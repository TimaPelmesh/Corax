#include "assist.hpp"

#include "assist_ui.hpp"
#include "config.hpp"
#include "http.hpp"
#include "util.hpp"

#include <windows.h>
#include <wtsapi32.h>
#include <objidl.h>
#include <gdiplus.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "wtsapi32.lib")

#pragma comment(lib, "gdiplus.lib")

namespace {

constexpr UINT kStartMsg = WM_APP + 40;
constexpr UINT kClickMsg = WM_APP + 41;

struct State {
  HWND tray = nullptr;
  HANDLE waiter = nullptr;
  std::atomic<bool> stop{false};
  std::atomic<bool> live{false};
  std::atomic<int> monitor{0};
  std::atomic<int> quality{80};
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
  int sd = 0;
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

void fill_screens_meta(FrameInfo& info, const std::vector<MonitorRec>& mons, int index) {
  info.mon = index;
  info.mc = static_cast<int>(mons.size());
  info.screens.clear();
  for (size_t i = 0; i < mons.size(); ++i) {
    const int mw = mons[i].rect.right - mons[i].rect.left;
    const int mh = mons[i].rect.bottom - mons[i].rect.top;
    if (i) info.screens += ",";
    info.screens += std::to_string(mw) + "x" + std::to_string(mh);
    if (mons[i].primary) info.screens += "p";
  }
}

/** Lock screen only. A normal local or RDP desktop is "Default" and must stay controllable. */
bool is_locked_desktop() {
  HDESK input = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!input) input = OpenInputDesktop(0, FALSE, MAXIMUM_ALLOWED);
  if (!input) return false;
  wchar_t name[256] = {};
  DWORD need = 0;
  const BOOL ok = GetUserObjectInformationW(input, UOI_NAME, name, sizeof(name), &need);
  CloseDesktop(input);
  if (!ok || !name[0]) return false;
  return _wcsicmp(name, L"Winlogon") == 0;
}

/** This tray serves Assist only while its logon session is the connected one (console or RDP). */
bool this_session_is_active() {
  DWORD sid = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &sid) || sid == 0) return false;
  LPWSTR buf = nullptr;
  DWORD bytes = 0;
  if (!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, sid, WTSConnectState, &buf, &bytes) || !buf) {
    return true;
  }
  const auto state = *reinterpret_cast<WTS_CONNECTSTATE_CLASS*>(buf);
  WTSFreeMemory(buf);
  return state == WTSActive;
}

bool encode_bitmap_jpeg(HBITMAP bmp, int quality, std::string& out) {
  ensure_gdiplus();
  if (!g_gdiplus_ok) return false;
  Gdiplus::Bitmap image(bmp, nullptr);
  CLSID jpeg{};
  if (!jpeg_clsid(&jpeg)) return false;
  IStream* stream = nullptr;
  if (CreateStreamOnHGlobal(nullptr, TRUE, &stream) != S_OK) return false;
  Gdiplus::EncoderParameters params;
  params.Count = 1;
  ULONG q = static_cast<ULONG>(std::max(40, std::min(92, quality)));
  params.Parameter[0].Guid = Gdiplus::EncoderQuality;
  params.Parameter[0].Type = Gdiplus::EncoderParameterValueTypeLong;
  params.Parameter[0].NumberOfValues = 1;
  params.Parameter[0].Value = &q;
  const bool saved = image.Save(stream, &jpeg, &params) == Gdiplus::Ok;
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
  return !out.empty();
}

bool grab_secure_placeholder(std::string& out, FrameInfo& info) {
  ensure_gdiplus();
  if (!g_gdiplus_ok) return false;
  const auto mons = list_monitors();
  int index = g.monitor.load();
  if (index < 0 || index >= static_cast<int>(mons.size())) index = 0;
  const RECT mon = mons[index].rect;
  const int sw = mon.right - mon.left;
  const int sh = mon.bottom - mon.top;
  const int dw = 960;
  const int dh = std::max(540, sh > 0 && sw > 0 ? sh * 960 / sw : 540);

  Gdiplus::Bitmap bmp(dw, dh, PixelFormat24bppRGB);
  Gdiplus::Graphics gfx(&bmp);
  gfx.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  gfx.SetTextRenderingHint(Gdiplus::TextRenderingHintClearTypeGridFit);
  gfx.Clear(Gdiplus::Color(255, 18, 22, 30));

  Gdiplus::SolidBrush bar(Gdiplus::Color(255, 72, 148, 236));
  gfx.FillRectangle(&bar, 0, 0, dw, 6);

  Gdiplus::FontFamily family(L"Segoe UI");
  Gdiplus::Font title(&family, 28.f, Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
  Gdiplus::Font body(&family, 18.f, Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
  Gdiplus::SolidBrush fg(Gdiplus::Color(255, 248, 248, 248));
  Gdiplus::SolidBrush muted(Gdiplus::Color(255, 170, 182, 198));
  Gdiplus::StringFormat center;
  center.SetAlignment(Gdiplus::StringAlignmentCenter);
  center.SetLineAlignment(Gdiplus::StringAlignmentCenter);

  const Gdiplus::RectF title_rc(40.f, static_cast<float>(dh) * 0.32f, static_cast<float>(dw) - 80.f, 44.f);
  const Gdiplus::RectF body_rc(60.f, static_cast<float>(dh) * 0.44f, static_cast<float>(dw) - 120.f, 80.f);
  gfx.DrawString(L"ПК заблокирован", -1, &title, title_rc, &center, &fg);
  gfx.DrawString(L"Управление недоступно, пока сеанс не разблокирован.\nВойдите по RDP — после этого откроется рабочий стол.",
                 -1, &body, body_rc, &center, &muted);

  HBITMAP hbmp = nullptr;
  if (bmp.GetHBITMAP(Gdiplus::Color(255, 18, 22, 30), &hbmp) != Gdiplus::Ok || !hbmp) return false;
  const bool ok = encode_bitmap_jpeg(hbmp, 70, out);
  DeleteObject(hbmp);

  info.sw = sw;
  info.sh = sh;
  info.dw = dw;
  info.dh = dh;
  info.cx = 0.5;
  info.cy = 0.5;
  info.cv = 0;
  info.sd = 1;
  fill_screens_meta(info, mons, index);
  return ok;
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

bool grab_jpeg(std::string& out, FrameInfo& info, uint32_t* fingerprint) {
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
    dh = std::max(1, dh * 1600 / dw);
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
  if (fingerprint) *fingerprint = 0;
  SelectObject(mem, old);

  const bool ok = encode_bitmap_jpeg(bmp, g.quality.load(), out);
  DeleteObject(bmp);
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);
  if (!ok) return false;

  POINT cursor{};
  GetCursorPos(&cursor);
  info.sw = sw;
  info.sh = sh;
  info.dw = dw;
  info.dh = dh;
  info.cx = sw > 0 ? std::clamp((cursor.x - mon.left) / static_cast<double>(sw), 0.0, 1.0) : 0;
  info.cy = sh > 0 ? std::clamp((cursor.y - mon.top) / static_cast<double>(sh), 0.0, 1.0) : 0;
  CURSORINFO shown{};
  shown.cbSize = sizeof(shown);
  info.cv = (GetCursorInfo(&shown) && (shown.flags & CURSOR_SHOWING)) ? 1 : 0;
  info.sd = 0;
  fill_screens_meta(info, mons, index);
  return !out.empty();
}

void attach_input_desktop() {
  HDESK desk = OpenInputDesktop(0, FALSE, GENERIC_ALL);
  if (!desk) desk = OpenInputDesktop(0, FALSE, MAXIMUM_ALLOWED);
  if (!desk) return;
  SetThreadDesktop(desk);
  CloseDesktop(desk);
  MSG pump{};
  PeekMessageW(&pump, nullptr, 0, 0, PM_NOREMOVE);
}

void send_mouse_flags(DWORD flags, DWORD data = 0) {
  INPUT in{};
  in.type = INPUT_MOUSE;
  in.mi.dwFlags = flags;
  in.mi.mouseData = data;
  if (SendInput(1, &in, sizeof(INPUT)) == 0) {
    mouse_event(flags, 0, 0, data, 0);
  }
}

struct ClickAnchor {
  int x = 0;
  int y = 0;
  DWORD tick = 0;
  bool on = false;
};

ClickAnchor g_click;

bool near_last_click(int x, int y) {
  if (!g_click.on) return false;
  if (GetTickCount() - g_click.tick > GetDoubleClickTime()) return false;
  const int tolx = std::max(GetSystemMetrics(SM_CXDOUBLECLK) * 4, 28);
  const int toly = std::max(GetSystemMetrics(SM_CYDOUBLECLK) * 4, 28);
  return std::abs(x - g_click.x) <= tolx && std::abs(y - g_click.y) <= toly;
}

void apply_mouse(double nx, double ny, int button, int down) {
  attach_input_desktop();
  if (is_locked_desktop()) return;
  const auto mons = list_monitors();
  int index = g.monitor.load();
  if (index < 0 || index >= static_cast<int>(mons.size())) index = 0;
  const RECT mon = mons[index].rect;
  const int sw = mon.right - mon.left;
  const int sh = mon.bottom - mon.top;
  int sx = mon.left + static_cast<int>(std::lround(std::clamp(nx, 0.0, 1.0) * std::max(0, sw - 1)));
  int sy = mon.top + static_cast<int>(std::lround(std::clamp(ny, 0.0, 1.0) * std::max(0, sh - 1)));
  const bool click = down == 0 || down == 1;
  // A second click a few pixels away is not a double-click for Explorer.
  // Keep both clicks of a pair on the same pixel, and ignore the jitter between them.
  if (near_last_click(sx, sy)) {
    if (!click) return;
    if (button == 0) {
      sx = g_click.x;
      sy = g_click.y;
    }
  }
  if (down == 1 && button == 0) {
    g_click.x = sx;
    g_click.y = sy;
    g_click.tick = GetTickCount();
    g_click.on = true;
  }
  HWND fg = GetForegroundWindow();
  DWORD fg_pid = 0;
  const DWORD fg_tid = fg ? GetWindowThreadProcessId(fg, &fg_pid) : 0;
  const DWORD my_tid = GetCurrentThreadId();
  const bool attached = fg_tid && fg_tid != my_tid && AttachThreadInput(my_tid, fg_tid, TRUE);
  SetCursorPos(sx, sy);
  if (!click) {
    const int virt_l = GetSystemMetrics(SM_XVIRTUALSCREEN);
    const int virt_t = GetSystemMetrics(SM_YVIRTUALSCREEN);
    const int virt_w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    const int virt_h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    INPUT move{};
    move.type = INPUT_MOUSE;
    move.mi.dx = virt_w > 1 ? static_cast<LONG>((sx - virt_l) * 65535.0 / (virt_w - 1)) : 0;
    move.mi.dy = virt_h > 1 ? static_cast<LONG>((sy - virt_t) * 65535.0 / (virt_h - 1)) : 0;
    move.mi.dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE | MOUSEEVENTF_VIRTUALDESK;
    SendInput(1, &move, sizeof(INPUT));
  }
  if (down == 1) {
    if (button == 0) send_mouse_flags(MOUSEEVENTF_LEFTDOWN);
    else if (button == 2) send_mouse_flags(MOUSEEVENTF_RIGHTDOWN);
    else if (button == 1) send_mouse_flags(MOUSEEVENTF_MIDDLEDOWN);
  } else if (down == 0) {
    if (button == 0) send_mouse_flags(MOUSEEVENTF_LEFTUP);
    else if (button == 2) send_mouse_flags(MOUSEEVENTF_RIGHTUP);
    else if (button == 1) send_mouse_flags(MOUSEEVENTF_MIDDLEUP);
  }
  if (attached) AttachThreadInput(my_tid, fg_tid, FALSE);
}

void apply_key(int vk, int down) {
  if (vk <= 0 || vk > 254) return;
  attach_input_desktop();
  if (is_locked_desktop()) return;
  INPUT in{};
  in.type = INPUT_KEYBOARD;
  in.ki.wVk = static_cast<WORD>(vk);
  in.ki.dwFlags = down ? 0 : KEYEVENTF_KEYUP;
  SendInput(1, &in, sizeof(INPUT));
}

void apply_wheel(int delta) {
  attach_input_desktop();
  if (is_locked_desktop()) return;
  send_mouse_flags(MOUSEEVENTF_WHEEL, static_cast<DWORD>(delta));
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
      g.quality.store(std::max(70, std::min(86, json_int_near(slice, "v", 80))));
    }
    cur = close + 1;
  }
}

/** Tiny blit used only to notice that the picture changed, before a full JPEG encode. */
uint32_t dirty_hash(const RECT& mon) {
  const int dw = 32;
  const int dh = 18;
  const int sw = mon.right - mon.left;
  const int sh = mon.bottom - mon.top;
  if (sw <= 0 || sh <= 0) return 0;
  HDC screen = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(screen);
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = dw;
  info.bmiHeader.biHeight = -dh;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP dib = CreateDIBSection(mem, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
  uint32_t hash = 0;
  if (dib && bits) {
    HGDIOBJ old = SelectObject(mem, dib);
    SetStretchBltMode(mem, COLORONCOLOR);
    StretchBlt(mem, 0, 0, dw, dh, screen, mon.left, mon.top, sw, sh, SRCCOPY);
    SelectObject(mem, old);
    const auto* px = static_cast<const uint32_t*>(bits);
    hash = 2166136261u;
    for (int i = 0; i < dw * dh; i += 2) {
      hash ^= px[i];
      hash *= 16777619u;
    }
  }
  if (dib) DeleteObject(dib);
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);
  return hash;
}

struct FrameSlot {
  std::mutex mu;
  std::condition_variable cv;
  std::string jpeg;
  FrameInfo info;
  bool fresh = false;
  bool stop = false;
};

void publish_frame(FrameSlot& slot, std::string jpeg, const FrameInfo& info) {
  {
    std::lock_guard<std::mutex> lock(slot.mu);
    slot.jpeg = std::move(jpeg);
    slot.info = info;
    slot.fresh = true;
  }
  slot.cv.notify_one();
}

std::string frame_path(const std::string& sid, const std::string& host, const FrameInfo& info);

void sender_loop(FrameSlot& slot, const AgentConfig& cfg, const std::string& sid, const std::string& host) {
  while (!g.stop && g.live) {
    std::string jpeg;
    FrameInfo info;
    {
      std::unique_lock<std::mutex> lock(slot.mu);
      slot.cv.wait_for(lock, std::chrono::milliseconds(30), [&] { return slot.fresh || slot.stop || !g.live; });
      if (slot.stop || !g.live) break;
      if (!slot.fresh) continue;
      jpeg.swap(slot.jpeg);
      info = slot.info;
      slot.fresh = false;
    }
    if (jpeg.empty()) continue;
    HttpResult sent = http_post_bytes(cfg.server_url, frame_path(sid, host, info), cfg.agent_token, "image/jpeg",
                                      jpeg.data(), jpeg.size());
    if (sent.status == 410 || sent.status == 404) {
      g.live = false;
      break;
    }
    if (sent.ok) apply_events(sent.body);
  }
}

std::string frame_path(const std::string& sid, const std::string& host, const FrameInfo& info) {
  return "/api/v1/assist/sessions/" + sid + "/frame?hostname=" + query_escape(host) +
         "&mon=" + std::to_string(info.mon) + "&mc=" + std::to_string(info.mc) +
         "&cx=" + std::to_string(info.cx) + "&cy=" + std::to_string(info.cy) +
         "&cv=" + std::to_string(info.cv) + "&sd=" + std::to_string(info.sd) +
         "&w=" + std::to_string(info.dw) + "&h=" + std::to_string(info.dh) +
         "&mw=" + std::to_string(info.sw) + "&mh=" + std::to_string(info.sh) +
         "&screens=" + query_escape(info.screens);
}

void capture_loop() {
  AgentConfig cfg = load_agent_config();
  const std::string host = util::computer_hostname();
  std::string sid;
  {
    std::lock_guard<std::mutex> lock(g.mu);
    sid = g.session_id;
  }
  // live already set by start_capture()
  FrameSlot slot;
  std::thread sender([&] { sender_loop(slot, cfg, sid, host); });
  uint32_t last_hash = 0;
  DWORD last_publish = 0;
  bool last_secure = false;
  DWORD last_secure_sent = 0;

  while (!g.stop && g.live) {
    if (!this_session_is_active()) break;
    // Move onto the unlocked desktop before any GDI work, so a lock → RDP login
    // can resume the real screen on this same thread.
    attach_input_desktop();
    const bool secure = is_locked_desktop();
    std::string jpeg;
    FrameInfo info;

    if (secure) {
      const DWORD now = GetTickCount();
      // Placeholder while the session is locked. Built off-thread so this
      // capture thread stays free to switch onto Default after unlock.
      if (!last_secure || now - last_secure_sent > 500) {
        jpeg.clear();
        std::thread([&] { grab_secure_placeholder(jpeg, info); }).join();
        if (!jpeg.empty()) {
          last_secure_sent = now;
          publish_frame(slot, std::move(jpeg), info);
        }
      }
      last_secure = true;
      last_hash = 0;
      Sleep(80);
      continue;
    }
    last_secure = false;

    const auto mons = list_monitors();
    int index = g.monitor.load();
    if (index < 0 || index >= static_cast<int>(mons.size())) index = 0;
    const uint32_t hash = dirty_hash(mons[index].rect);
    const DWORD now = GetTickCount();
    const bool changed = hash != last_hash;
    // Idle desktop: a heartbeat a few times a second. Motion: a new frame immediately.
    if (!changed && now - last_publish < 280) {
      Sleep(12);
      continue;
    }

    if (!grab_jpeg(jpeg, info, nullptr)) {
      Sleep(20);
      continue;
    }
    if (jpeg.size() > 1400000 && g.quality.load() > 72) {
      g.quality.store(std::max(72, g.quality.load() - 4));
    }
    last_hash = hash;
    last_publish = now;
    publish_frame(slot, std::move(jpeg), info);
    Sleep(changed ? 8 : 20);
  }
  {
    std::lock_guard<std::mutex> lock(slot.mu);
    slot.stop = true;
  }
  slot.cv.notify_all();
  if (sender.joinable()) sender.join();
  g.live = false;
  {
    std::lock_guard<std::mutex> lock(g.mu);
    g.session_id.clear();
  }
  if (g.tray) PostMessageW(g.tray, kClickMsg, 4, 0);
}

DWORD WINAPI capture_proc(LPVOID) {
  capture_loop();
  return 0;
}

void input_loop() {
  AgentConfig cfg = load_agent_config();
  const std::string host = util::computer_hostname();
  attach_input_desktop();
  while (!g.stop && g.live) {
    std::string sid;
    {
      std::lock_guard<std::mutex> lock(g.mu);
      sid = g.session_id;
    }
    if (sid.empty()) {
      Sleep(40);
      continue;
    }
    if (!this_session_is_active()) {
      Sleep(200);
      continue;
    }
    attach_input_desktop();
    if (is_locked_desktop()) {
      Sleep(80);
      continue;
    }
    const std::string path = "/api/v1/assist/sessions/" + sid + "/events?hostname=" + query_escape(host);
    HttpResult pulled = http_get(cfg.server_url, path, cfg.agent_token);
    if (pulled.status == 410 || pulled.status == 404) break;
    if (pulled.ok) apply_events(pulled.body);
    Sleep(8);
  }
}

DWORD WINAPI input_proc(LPVOID) {
  input_loop();
  return 0;
}

void start_capture() {
  bool expected = false;
  if (!g.live.compare_exchange_strong(expected, true)) return;
  HANDLE video = CreateThread(nullptr, 0, capture_proc, nullptr, 0, nullptr);
  if (video) CloseHandle(video);
  HANDLE input = CreateThread(nullptr, 0, input_proc, nullptr, 0, nullptr);
  if (input) CloseHandle(input);
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
    if (cfg.server_url.empty() || cfg.agent_token.empty() || !this_session_is_active()) {
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
    // Silent: accepted; legacy agents may still see offered.
    if (id.empty() || (status != "accepted" && status != "offered" && status != "live")) continue;
    {
      std::lock_guard<std::mutex> lock(g.mu);
      g.session_id = id;
      g.admin = json_str(r.body, "admin_name");
    }
    if (status == "offered") post_answer(true);
    if (g.tray) PostMessageW(g.tray, kStartMsg, 0, 0);
    // Give the tray UI thread a moment to show the banner and start capture.
    for (int i = 0; i < 50 && !g.stop && !g.live; ++i) Sleep(20);
    // Fallback if there is no tray HWND / message pump.
    if (!g.stop && !g.live) {
      std::string cur;
      {
        std::lock_guard<std::mutex> lock(g.mu);
        cur = g.session_id;
      }
      if (cur == id) start_capture();
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
  if (msg == kStartMsg) {
    std::string admin;
    {
      std::lock_guard<std::mutex> lock(g.mu);
      admin = g.admin;
    }
    assist_ui_live(tray_hwnd, admin);
    start_capture();
    return;
  }
  if (msg != kClickMsg) return;
  // 3 = employee hang-up; 4 = session ended on server (hide banner only).
  if (wp == 3) {
    g.live = false;
    post_hangup();
    assist_ui_hide();
    std::lock_guard<std::mutex> lock(g.mu);
    g.session_id.clear();
  } else if (wp == 4) {
    assist_ui_hide();
  }
}
