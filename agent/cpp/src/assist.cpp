#include "assist.hpp"

#include "assist_ui.hpp"
#include "config.hpp"
#include "http.hpp"
#include "util.hpp"

#include <windows.h>
#include <objidl.h>
#include <gdiplus.h>

#include <algorithm>
#include <atomic>
#include <mutex>
#include <string>
#include <vector>

#pragma comment(lib, "gdiplus.lib")

namespace {

constexpr UINT kOfferMsg = WM_APP + 40;
constexpr UINT kClickMsg = WM_APP + 41;

struct State {
  HWND tray = nullptr;
  HANDLE waiter = nullptr;
  std::atomic<bool> stop{false};
  std::atomic<bool> live{false};
  std::atomic<int> monitor{0};
  std::atomic<int> quality{72};
  std::mutex mu;
  std::string session_id;
  std::string admin;
};

struct MonitorRec {
  RECT rect{};
  bool primary = false;
};

struct FrameInfo {
  int mon = 0;
  int mc = 1;
  int sw = 0;
  int sh = 0;
  int dw = 0;
  int dh = 0;
  double cx = 0;
  double cy = 0;
  int cv = 0;
  std::string screens;
};

State g;
ULONG_PTR g_gdiplus = 0;
bool g_gdiplus_ok = false;

std::string query_escape(const std::string& raw) {
  std::string out;
  for (unsigned char c : raw) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
        c == '.') {
      out.push_back(static_cast<char>(c));
    } else {
      char buf[8];
      sprintf_s(buf, "%%%02X", c);
      out += buf;
    }
  }
  return out;
}

std::string json_str(const std::string& body, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  size_t pos = body.find(needle);
  if (pos == std::string::npos) return "";
  pos = body.find(':', pos + needle.size());
  if (pos == std::string::npos) return "";
  ++pos;
  while (pos < body.size() && (body[pos] == ' ' || body[pos] == '\t')) ++pos;
  if (pos >= body.size() || body[pos] != '"') return "";
  size_t end = body.find('"', pos + 1);
  if (end == std::string::npos) return "";
  return body.substr(pos + 1, end - pos - 1);
}

int json_int_near(const std::string& slice, const char* key, int fallback) {
  const std::string needle = std::string("\"") + key + "\"";
  size_t pos = slice.find(needle);
  if (pos == std::string::npos) return fallback;
  pos = slice.find(':', pos + needle.size());
  if (pos == std::string::npos) return fallback;
  ++pos;
  while (pos < slice.size() && (slice[pos] == ' ' || slice[pos] == '\t')) ++pos;
  try {
    return std::stoi(slice.substr(pos));
  } catch (...) {
    return fallback;
  }
}

double json_num_near(const std::string& slice, const char* key, double fallback) {
  const std::string needle = std::string("\"") + key + "\"";
  size_t pos = slice.find(needle);
  if (pos == std::string::npos) return fallback;
  pos = slice.find(':', pos + needle.size());
  if (pos == std::string::npos) return fallback;
  ++pos;
  while (pos < slice.size() && (slice[pos] == ' ' || slice[pos] == '\t')) ++pos;
  try {
    return std::stod(slice.substr(pos));
  } catch (...) {
    return fallback;
  }
}

void ensure_gdiplus() {
  if (g_gdiplus_ok) return;
  Gdiplus::GdiplusStartupInput input;
  if (Gdiplus::GdiplusStartup(&g_gdiplus, &input, nullptr) == Gdiplus::Ok) g_gdiplus_ok = true;
}

bool jpeg_clsid(CLSID* id) {
  UINT num = 0, size = 0;
  Gdiplus::GetImageEncodersSize(&num, &size);
  if (!size) return false;
  std::vector<char> buf(size);
  auto* info = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buf.data());
  Gdiplus::GetImageEncoders(num, size, info);
  for (UINT i = 0; i < num; ++i) {
    if (wcscmp(info[i].MimeType, L"image/jpeg") == 0) {
      *id = info[i].Clsid;
      return true;
    }
  }
  return false;
}

BOOL CALLBACK enum_monitors(HMONITOR monitor, HDC, LPRECT, LPARAM ctx) {
  auto* out = reinterpret_cast<std::vector<MonitorRec>*>(ctx);
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  if (!GetMonitorInfoW(monitor, &info)) return TRUE;
  MonitorRec rec;
  rec.rect = info.rcMonitor;
  rec.primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0;
  out->push_back(rec);
  return TRUE;
}

std::vector<MonitorRec> list_monitors() {
  std::vector<MonitorRec> mons;
  EnumDisplayMonitors(nullptr, nullptr, enum_monitors, reinterpret_cast<LPARAM>(&mons));
  if (mons.empty()) {
    MonitorRec rec;
    rec.rect = {0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)};
    rec.primary = true;
    mons.push_back(rec);
  }
  std::stable_partition(mons.begin(), mons.end(), [](const MonitorRec& item) { return item.primary; });
  return mons;
}

void paint_cursor(HDC dc, const RECT& mon, int dw, int dh) {
  CURSORINFO info{};
  info.cbSize = sizeof(info);
  if (!GetCursorInfo(&info) || !(info.flags & CURSOR_SHOWING) || !info.hCursor) return;
  ICONINFO icon{};
  int hot_x = 0;
  int hot_y = 0;
  if (GetIconInfo(info.hCursor, &icon)) {
    hot_x = static_cast<int>(icon.xHotspot);
    hot_y = static_cast<int>(icon.yHotspot);
    if (icon.hbmMask) DeleteObject(icon.hbmMask);
    if (icon.hbmColor) DeleteObject(icon.hbmColor);
  }
  const int sw = mon.right - mon.left;
  const int sh = mon.bottom - mon.top;
  if (sw <= 0 || sh <= 0) return;
  const int x = (info.ptScreenPos.x - mon.left - hot_x) * dw / sw;
  const int y = (info.ptScreenPos.y - mon.top - hot_y) * dh / sh;
  DrawIconEx(dc, x, y, info.hCursor, 0, 0, 0, nullptr, DI_NORMAL | DI_DEFAULTSIZE);
}

bool grab_jpeg(std::string& out, FrameInfo& info) {
  ensure_gdiplus();
  if (!g_gdiplus_ok) return false;
  const auto mons = list_monitors();
  int index = g.monitor.load();
  if (index < 0 || index >= static_cast<int>(mons.size())) index = 0;
  const RECT mon = mons[index].rect;
  const int sw = mon.right - mon.left;
  const int sh = mon.bottom - mon.top;
  if (sw <= 0 || sh <= 0) return false;
  int dw = sw;
  int dh = sh;
  if (dw > 1600) {
    dh = dh * 1600 / dw;
    dw = 1600;
  }
  HDC screen = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(screen);
  HBITMAP bmp = CreateCompatibleBitmap(screen, dw, dh);
  HGDIOBJ old = SelectObject(mem, bmp);
  if (dw == sw && dh == sh) {
    BitBlt(mem, 0, 0, dw, dh, screen, mon.left, mon.top, SRCCOPY | CAPTUREBLT);
  } else {
    SetStretchBltMode(mem, COLORONCOLOR);
    StretchBlt(mem, 0, 0, dw, dh, screen, mon.left, mon.top, sw, sh, SRCCOPY | CAPTUREBLT);
  }
  paint_cursor(mem, mon, dw, dh);
  SelectObject(mem, old);

  Gdiplus::Bitmap image(bmp, nullptr);
  CLSID jpeg{};
  if (!jpeg_clsid(&jpeg)) {
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(nullptr, screen);
    return false;
  }
  IStream* stream = nullptr;
  if (CreateStreamOnHGlobal(nullptr, TRUE, &stream) != S_OK) {
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(nullptr, screen);
    return false;
  }
  Gdiplus::EncoderParameters params;
  params.Count = 1;
  ULONG quality = static_cast<ULONG>(std::max(40, std::min(90, g.quality.load())));
  params.Parameter[0].Guid = Gdiplus::EncoderQuality;
  params.Parameter[0].Type = Gdiplus::EncoderParameterValueTypeLong;
  params.Parameter[0].NumberOfValues = 1;
  params.Parameter[0].Value = &quality;
  const bool saved = image.Save(stream, &jpeg, &params) == Gdiplus::Ok;
  DeleteObject(bmp);
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);
  if (!saved) {
    stream->Release();
    return false;
  }
  STATSTG stat{};
  stream->Stat(&stat, STATFLAG_NONAME);
  const ULONG len = static_cast<ULONG>(stat.cbSize.QuadPart);
  HGLOBAL hg = nullptr;
  GetHGlobalFromStream(stream, &hg);
  void* data = GlobalLock(hg);
  if (data && len) out.assign(static_cast<const char*>(data), len);
  if (data) GlobalUnlock(hg);
  stream->Release();

  POINT cursor{};
  GetCursorPos(&cursor);
  info.mon = index;
  info.mc = static_cast<int>(mons.size());
  info.sw = sw;
  info.sh = sh;
  info.dw = dw;
  info.dh = dh;
  info.cx = sw > 0 ? std::clamp((cursor.x - mon.left) / static_cast<double>(sw), 0.0, 1.0) : 0;
  info.cy = sh > 0 ? std::clamp((cursor.y - mon.top) / static_cast<double>(sh), 0.0, 1.0) : 0;
  CURSORINFO shown{};
  shown.cbSize = sizeof(shown);
  info.cv = (GetCursorInfo(&shown) && (shown.flags & CURSOR_SHOWING)) ? 1 : 0;
  info.screens.clear();
  for (size_t i = 0; i < mons.size(); ++i) {
    const int mw = mons[i].rect.right - mons[i].rect.left;
    const int mh = mons[i].rect.bottom - mons[i].rect.top;
    if (i) info.screens += ",";
    info.screens += std::to_string(mw) + "x" + std::to_string(mh);
    if (mons[i].primary) info.screens += "p";
  }
  return !out.empty();
}

void apply_mouse(double nx, double ny, int button, int down) {
  const auto mons = list_monitors();
  int index = g.monitor.load();
  if (index < 0 || index >= static_cast<int>(mons.size())) index = 0;
  const RECT mon = mons[index].rect;
  const int virt_l = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const int virt_t = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const int virt_w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  const int virt_h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  const double x = mon.left + std::clamp(nx, 0.0, 1.0) * (mon.right - mon.left);
  const double y = mon.top + std::clamp(ny, 0.0, 1.0) * (mon.bottom - mon.top);
  INPUT in{};
  in.type = INPUT_MOUSE;
  in.mi.dx = virt_w > 1 ? static_cast<LONG>((x - virt_l) * 65535.0 / (virt_w - 1)) : 0;
  in.mi.dy = virt_h > 1 ? static_cast<LONG>((y - virt_t) * 65535.0 / (virt_h - 1)) : 0;
  in.mi.dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE | MOUSEEVENTF_VIRTUALDESK;
  if (down == 1) {
    if (button == 0) in.mi.dwFlags |= MOUSEEVENTF_LEFTDOWN;
    else if (button == 2) in.mi.dwFlags |= MOUSEEVENTF_RIGHTDOWN;
    else if (button == 1) in.mi.dwFlags |= MOUSEEVENTF_MIDDLEDOWN;
  } else if (down == 0) {
    if (button == 0) in.mi.dwFlags |= MOUSEEVENTF_LEFTUP;
    else if (button == 2) in.mi.dwFlags |= MOUSEEVENTF_RIGHTUP;
    else if (button == 1) in.mi.dwFlags |= MOUSEEVENTF_MIDDLEUP;
  }
  SendInput(1, &in, sizeof(INPUT));
}

void apply_key(int vk, int down) {
  if (vk <= 0 || vk > 254) return;
  INPUT in{};
  in.type = INPUT_KEYBOARD;
  in.ki.wVk = static_cast<WORD>(vk);
  in.ki.dwFlags = down ? 0 : KEYEVENTF_KEYUP;
  SendInput(1, &in, sizeof(INPUT));
}

void apply_wheel(int delta) {
  INPUT in{};
  in.type = INPUT_MOUSE;
  in.mi.dwFlags = MOUSEEVENTF_WHEEL;
  in.mi.mouseData = static_cast<DWORD>(delta);
  SendInput(1, &in, sizeof(INPUT));
}

void apply_events(const std::string& body) {
  size_t events = body.find("\"events\"");
  if (events == std::string::npos) return;
  size_t i = body.find('[', events);
  if (i == std::string::npos) return;
  size_t end = body.find(']', i);
  if (end == std::string::npos) end = body.size();
  size_t cur = i;
  while (cur < end) {
    size_t obj = body.find('{', cur);
    if (obj == std::string::npos || obj >= end) break;
    size_t close = body.find('}', obj);
    if (close == std::string::npos || close > end) break;
    const std::string slice = body.substr(obj, close - obj + 1);
    const std::string t = json_str(slice, "t");
    if (t == "m") {
      apply_mouse(json_num_near(slice, "x", 0), json_num_near(slice, "y", 0), json_int_near(slice, "b", 0),
                  json_int_near(slice, "d", 2));
    } else if (t == "k") {
      apply_key(json_int_near(slice, "vk", 0), json_int_near(slice, "d", 1));
    } else if (t == "w") {
      apply_wheel(json_int_near(slice, "d", 0));
    } else if (t == "s") {
      g.monitor.store(std::max(0, json_int_near(slice, "i", 0)));
    } else if (t == "q") {
      g.quality.store(std::max(40, std::min(90, json_int_near(slice, "v", 72))));
    }
    cur = close + 1;
  }
}

void capture_loop() {
  AgentConfig cfg = load_agent_config();
  const std::string host = util::computer_hostname();
  std::string sid;
  {
    std::lock_guard<std::mutex> lock(g.mu);
    sid = g.session_id;
  }
  g.live = true;
  while (!g.stop && g.live) {
    std::string jpeg;
    FrameInfo info;
    if (!grab_jpeg(jpeg, info)) {
      Sleep(120);
      continue;
    }
    if (jpeg.size() > 820000 && g.quality.load() > 48) {
      g.quality.store(std::max(48, g.quality.load() - 10));
    }
    const std::string path = "/api/v1/assist/sessions/" + sid + "/frame?hostname=" + query_escape(host) +
                             "&mon=" + std::to_string(info.mon) + "&mc=" + std::to_string(info.mc) +
                             "&cx=" + std::to_string(info.cx) + "&cy=" + std::to_string(info.cy) +
                             "&cv=" + std::to_string(info.cv) + "&w=" + std::to_string(info.dw) +
                             "&h=" + std::to_string(info.dh) + "&mw=" + std::to_string(info.sw) +
                             "&mh=" + std::to_string(info.sh) + "&screens=" + query_escape(info.screens);
    HttpResult sent = http_post_bytes(cfg.server_url, path, cfg.agent_token, "image/jpeg", jpeg.data(), jpeg.size());
    if (sent.status == 410 || sent.status == 404) break;
    if (sent.ok) apply_events(sent.body);
    Sleep(48);
  }
  g.live = false;
}

DWORD WINAPI capture_proc(LPVOID) {
  capture_loop();
  return 0;
}

void start_capture() {
  HANDLE th = CreateThread(nullptr, 0, capture_proc, nullptr, 0, nullptr);
  if (th) CloseHandle(th);
}

void post_answer(bool accept) {
  AgentConfig cfg = load_agent_config();
  std::string sid;
  {
    std::lock_guard<std::mutex> lock(g.mu);
    sid = g.session_id;
  }
  if (sid.empty()) return;
  const std::string host = util::computer_hostname();
  const std::string body = std::string("{\"accept\":") + (accept ? "true" : "false") + ",\"hostname\":\"" + host +
                           "\"}";
  http_post_json(cfg.server_url, "/api/v1/assist/sessions/" + sid + "/answer", cfg.agent_token, body);
}

void post_hangup() {
  AgentConfig cfg = load_agent_config();
  std::string sid;
  {
    std::lock_guard<std::mutex> lock(g.mu);
    sid = g.session_id;
  }
  if (sid.empty()) return;
  const std::string host = util::computer_hostname();
  http_post_json(cfg.server_url, "/api/v1/assist/sessions/" + sid + "/hangup?hostname=" + query_escape(host),
                 cfg.agent_token, "{}");
}

DWORD WINAPI waiter_proc(LPVOID) {
  while (!g.stop) {
    AgentConfig cfg = load_agent_config();
    if (cfg.server_url.empty() || cfg.agent_token.empty()) {
      Sleep(4000);
      continue;
    }
    const std::string host = util::computer_hostname();
    HttpResult r = http_get(cfg.server_url, "/api/v1/assist/pending?hostname=" + query_escape(host), cfg.agent_token);
    if (g.stop) break;
    if (!r.ok) {
      Sleep(3000);
      continue;
    }
    const std::string id = json_str(r.body, "id");
    const std::string status = json_str(r.body, "status");
    if (id.empty() || status != "offered") continue;
    {
      std::lock_guard<std::mutex> lock(g.mu);
      g.session_id = id;
      g.admin = json_str(r.body, "admin_name");
    }
    if (g.tray) PostMessageW(g.tray, kOfferMsg, 0, 0);
    for (int i = 0; i < 900 && !g.stop && !g.live; ++i) {
      std::string cur;
      {
        std::lock_guard<std::mutex> lock(g.mu);
        cur = g.session_id;
      }
      if (cur != id) break;
      Sleep(100);
    }
    while (!g.stop && g.live) Sleep(200);
  }
  return 0;
}

}  // namespace

void assist_tray_start(void* tray_hwnd) {
  g.tray = static_cast<HWND>(tray_hwnd);
  g.stop = false;
  g.waiter = CreateThread(nullptr, 0, waiter_proc, nullptr, 0, nullptr);
}

void assist_tray_stop() {
  g.stop = true;
  g.live = false;
  assist_ui_hide();
  if (g.waiter) {
    WaitForSingleObject(g.waiter, 1500);
    CloseHandle(g.waiter);
    g.waiter = nullptr;
  }
}

void assist_tray_handle(void* tray_hwnd, unsigned msg, unsigned long long wp) {
  g.tray = static_cast<HWND>(tray_hwnd);
  if (msg == kOfferMsg) {
    std::string admin;
    {
      std::lock_guard<std::mutex> lock(g.mu);
      admin = g.admin;
    }
    assist_ui_offer(tray_hwnd, admin);
    return;
  }
  if (msg != kClickMsg) return;
  if (wp == 1) {
    post_answer(true);
    assist_ui_live(tray_hwnd);
    start_capture();
  } else if (wp == 2) {
    post_answer(false);
    assist_ui_hide();
    std::lock_guard<std::mutex> lock(g.mu);
    g.session_id.clear();
  } else if (wp == 3) {
    g.live = false;
    post_hangup();
    assist_ui_hide();
    std::lock_guard<std::mutex> lock(g.mu);
    g.session_id.clear();
  }
}
