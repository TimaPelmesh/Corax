#include "assist.hpp"

#include "assist_ui.hpp"
#include "config.hpp"
#include "http.hpp"
#include "util.hpp"

#include <windows.h>
#include <objidl.h>
#include <gdiplus.h>

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
  std::mutex mu;
  std::string session_id;
  std::string admin;
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

bool grab_jpeg(std::string& out, int& sw, int& sh) {
  ensure_gdiplus();
  if (!g_gdiplus_ok) return false;
  sw = GetSystemMetrics(SM_CXSCREEN);
  sh = GetSystemMetrics(SM_CYSCREEN);
  if (sw <= 0 || sh <= 0) return false;
  int dw = sw;
  int dh = sh;
  if (dw > 1280) {
    dh = dh * 1280 / dw;
    dw = 1280;
  }
  HDC screen = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(screen);
  HBITMAP bmp = CreateCompatibleBitmap(screen, dw, dh);
  HGDIOBJ old = SelectObject(mem, bmp);
  SetStretchBltMode(mem, HALFTONE);
  StretchBlt(mem, 0, 0, dw, dh, screen, 0, 0, sw, sh, SRCCOPY | CAPTUREBLT);
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
  ULONG quality = 52;
  params.Parameter[0].Guid = Gdiplus::EncoderQuality;
  params.Parameter[0].Type = Gdiplus::EncoderParameterValueTypeLong;
  params.Parameter[0].NumberOfValues = 1;
  params.Parameter[0].Value = &quality;
  if (image.Save(stream, &jpeg, &params) != Gdiplus::Ok) {
    stream->Release();
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(nullptr, screen);
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
  DeleteObject(bmp);
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);
  return !out.empty();
}

void apply_mouse(double nx, double ny, int button, int down) {
  INPUT in{};
  in.type = INPUT_MOUSE;
  in.mi.dx = static_cast<LONG>(nx * 65535.0);
  in.mi.dy = static_cast<LONG>(ny * 65535.0);
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
    int sw = 0, sh = 0;
    if (!grab_jpeg(jpeg, sw, sh)) {
      Sleep(200);
      continue;
    }
    const std::string path = "/api/v1/assist/sessions/" + sid + "/frame?hostname=" + query_escape(host);
    HttpResult sent = http_post_bytes(cfg.server_url, path, cfg.agent_token, "image/jpeg", jpeg.data(), jpeg.size());
    if (sent.status == 410 || sent.status == 404) break;
    if (sent.ok) apply_events(sent.body);
    Sleep(110);
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
