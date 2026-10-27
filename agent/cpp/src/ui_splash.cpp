#include "ui_splash.hpp"

#include "../resources/resource.h"
#include "util.hpp"

#include <windows.h>
#include <shellapi.h>
#include <objidl.h>
#include <gdiplus.h>

#include <algorithm>
#include <string>

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "msimg32.lib")

namespace {

constexpr int kLogicalWidth = 520;
constexpr int kLogicalHeight = 96;
constexpr UINT_PTR kAnimationTimer = 1;
constexpr UINT kTrayMsg = WM_APP + 31;

enum class VisualState { Running, Success, Error };

struct SplashState {
  HWND hwnd = nullptr;
  HICON icon = nullptr;
  std::wstring subtitle;
  std::wstring status = L"Подготавливаем всё необходимое…";
  int progress = 4;
  int displayed_progress = 0;
  int animation_tick = 0;
  bool busy = false;
  VisualState visual = VisualState::Running;
  int width = kLogicalWidth;
  int height = kLogicalHeight;
  float scale = 1.f;
  ULONG_PTR gdiplus = 0;
  bool gdiplus_ready = false;
  bool tray_on = false;
  bool hidden = false;
};

SplashState g;

int sx(int value) { return std::max(1, static_cast<int>(value * g.scale + 0.5f)); }

float dpi_scale() {
  using GetDpiFn = UINT(WINAPI*)();
  if (HMODULE user = GetModuleHandleW(L"user32.dll")) {
    if (auto fn = reinterpret_cast<GetDpiFn>(GetProcAddress(user, "GetDpiForSystem"))) {
      const UINT dpi = fn();
      if (dpi >= 96) return static_cast<float>(dpi) / 96.f;
    }
  }
  HDC screen = GetDC(nullptr);
  const int dpi = screen ? GetDeviceCaps(screen, LOGPIXELSX) : 96;
  if (screen) ReleaseDC(nullptr, screen);
  return std::max(1.f, dpi / 96.f);
}

void ensure_gdiplus() {
  if (g.gdiplus_ready) return;
  Gdiplus::GdiplusStartupInput input;
  if (Gdiplus::GdiplusStartup(&g.gdiplus, &input, nullptr) == Gdiplus::Ok) g.gdiplus_ready = true;
}

void fill_round(Gdiplus::Graphics& gfx, const Gdiplus::RectF& rect, float radius, const Gdiplus::Color& color) {
  Gdiplus::GraphicsPath path;
  const float d = radius * 2.f;
  path.AddArc(rect.X, rect.Y, d, d, 180.f, 90.f);
  path.AddArc(rect.GetRight() - d, rect.Y, d, d, 270.f, 90.f);
  path.AddArc(rect.GetRight() - d, rect.GetBottom() - d, d, d, 0.f, 90.f);
  path.AddArc(rect.X, rect.GetBottom() - d, d, d, 90.f, 90.f);
  path.CloseFigure();
  Gdiplus::SolidBrush brush(color);
  gfx.FillPath(&brush, &path);
}

void draw_string(Gdiplus::Graphics& gfx, const std::wstring& text, const Gdiplus::RectF& rect,
                 const Gdiplus::Font& font, const Gdiplus::Color& color, Gdiplus::StringAlignment align) {
  Gdiplus::StringFormat format;
  format.SetAlignment(align);
  format.SetLineAlignment(Gdiplus::StringAlignmentCenter);
  format.SetTrimming(Gdiplus::StringTrimmingEllipsisCharacter);
  format.SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap);
  Gdiplus::SolidBrush brush(color);
  gfx.DrawString(text.c_str(), static_cast<INT>(text.size()), &font, rect, &format, &brush);
}

void present();

void hide_window() {
  if (!g.hwnd) return;
  g.hidden = true;
  ShowWindow(g.hwnd, SW_HIDE);
}

void show_window() {
  if (!g.hwnd) return;
  g.hidden = false;
  ShowWindow(g.hwnd, SW_SHOW);
  SetForegroundWindow(g.hwnd);
  present();
}

void add_tray() {
  if (!g.hwnd || g.tray_on) return;
  NOTIFYICONDATAW nid{};
  nid.cbSize = sizeof(nid);
  nid.hWnd = g.hwnd;
  nid.uID = 1;
  nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
  nid.uCallbackMessage = kTrayMsg;
  nid.hIcon = g.icon ? g.icon : LoadIconW(nullptr, MAKEINTRESOURCEW(32512));
  wcscpy_s(nid.szTip, L"Corax");
  if (Shell_NotifyIconW(NIM_ADD, &nid)) g.tray_on = true;
}

void remove_tray() {
  if (!g.tray_on || !g.hwnd) {
    g.tray_on = false;
    return;
  }
  NOTIFYICONDATAW nid{};
  nid.cbSize = sizeof(nid);
  nid.hWnd = g.hwnd;
  nid.uID = 1;
  Shell_NotifyIconW(NIM_DELETE, &nid);
  g.tray_on = false;
}

void present() {
  if (!g.hwnd || !g.gdiplus_ready || g.hidden) return;
  const int w = g.width;
  const int h = g.height;
  Gdiplus::Bitmap bmp(w, h, PixelFormat32bppPARGB);
  Gdiplus::Graphics gfx(&bmp);
  gfx.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  gfx.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality);
  gfx.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
  gfx.SetTextRenderingHint(Gdiplus::TextRenderingHintClearTypeGridFit);
  gfx.Clear(Gdiplus::Color(0, 0, 0, 0));

  const float pad = static_cast<float>(sx(10));
  Gdiplus::RectF card(pad, pad, static_cast<float>(w) - pad * 2.f, static_cast<float>(h) - pad * 2.f);
  fill_round(gfx, Gdiplus::RectF(card.X + sx(2), card.Y + sx(6), card.Width, card.Height), static_cast<float>(sx(18)),
             Gdiplus::Color(36, 15, 23, 42));
  fill_round(gfx, card, static_cast<float>(sx(18)), Gdiplus::Color(255, 255, 255, 255));

  const int icon_px = sx(36);
  if (g.icon) {
    Gdiplus::Bitmap* icon_bmp = Gdiplus::Bitmap::FromHICON(g.icon);
    if (icon_bmp) {
      gfx.DrawImage(icon_bmp, sx(16), sx(18), icon_px, icon_px);
      delete icon_bmp;
    }
  }

  Gdiplus::FontFamily family(L"Segoe UI");
  Gdiplus::Font title(&family, static_cast<float>(sx(15)), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
  Gdiplus::Font body(&family, static_cast<float>(sx(12)), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);

  const Gdiplus::Color ink(255, 15, 23, 42);
  const Gdiplus::Color muted(255, 100, 116, 139);
  const Gdiplus::Color accent = g.visual == VisualState::Error ? Gdiplus::Color(255, 185, 28, 28)
                               : g.visual == VisualState::Success ? Gdiplus::Color(255, 22, 163, 74)
                                                               : Gdiplus::Color(255, 37, 99, 235);

  const float text_x = static_cast<float>(sx(62));
  const float text_w = static_cast<float>(w - sx(96));
  draw_string(gfx, L"Corax", Gdiplus::RectF(text_x, static_cast<float>(sx(16)), text_w, static_cast<float>(sx(18))),
              title, ink, Gdiplus::StringAlignmentNear);

  std::wstring heading = g.status.empty() ? L"Сбор сведений…" : g.status;
  if (g.visual == VisualState::Success) heading = L"Отчёт отправлен";
  if (g.visual == VisualState::Error && heading.empty()) heading = L"Не удалось отправить отчёт";
  draw_string(gfx, heading, Gdiplus::RectF(text_x, static_cast<float>(sx(36)), text_w, static_cast<float>(sx(16))),
              body, g.visual == VisualState::Error ? accent : muted, Gdiplus::StringAlignmentNear);

  const float track_y = static_cast<float>(sx(64));
  const float track_x = text_x;
  const float track_w = static_cast<float>(w - sx(78));
  const float track_h = static_cast<float>(sx(4));
  fill_round(gfx, Gdiplus::RectF(track_x, track_y, track_w, track_h), track_h / 2.f, Gdiplus::Color(255, 226, 232, 240));
  const int shown = std::clamp(g.displayed_progress, 0, 100);
  const float fill_w = std::max(track_h, track_w * (shown / 100.f));
  fill_round(gfx, Gdiplus::RectF(track_x, track_y, fill_w, track_h), track_h / 2.f, accent);

  Gdiplus::Pen min_pen(Gdiplus::Color(255, 100, 116, 139), std::max(1.6f, g.scale));
  min_pen.SetStartCap(Gdiplus::LineCapRound);
  min_pen.SetEndCap(Gdiplus::LineCapRound);
  const float x0 = static_cast<float>(w - sx(28));
  const float y0 = static_cast<float>(sx(22));
  gfx.DrawLine(&min_pen, x0, y0, x0 + sx(12), y0);

  Gdiplus::BitmapData data{};
  Gdiplus::Rect lock(0, 0, w, h);
  if (bmp.LockBits(&lock, Gdiplus::ImageLockModeRead, PixelFormat32bppPARGB, &data) != Gdiplus::Ok) return;

  HDC screen = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(screen);
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = w;
  info.bmiHeader.biHeight = -h;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP dib = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (dib && bits) {
    for (int y = 0; y < h; ++y) {
      memcpy(static_cast<BYTE*>(bits) + y * w * 4, static_cast<BYTE*>(data.Scan0) + y * data.Stride, w * 4);
    }
    HGDIOBJ old = SelectObject(mem, dib);
    RECT wr{};
    GetWindowRect(g.hwnd, &wr);
    POINT origin{wr.left, wr.top};
    SIZE size{w, h};
    POINT src{0, 0};
    BLENDFUNCTION blend{};
    blend.BlendOp = AC_SRC_OVER;
    blend.SourceConstantAlpha = 255;
    blend.AlphaFormat = AC_SRC_ALPHA;
    UpdateLayeredWindow(g.hwnd, screen, &origin, &size, mem, &src, 0, &blend, ULW_ALPHA);
    SelectObject(mem, old);
    DeleteObject(dib);
  }
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);
  bmp.UnlockBits(&data);
}

bool minimize_hit(LPARAM point) {
  const int x = static_cast<short>(LOWORD(point));
  const int y = static_cast<short>(HIWORD(point));
  return x >= g.width - sx(44) && y >= sx(8) && y <= sx(40);
}

LRESULT CALLBACK SplashWndProc(HWND hwnd, UINT msg, WPARAM w_param, LPARAM l_param) {
  switch (msg) {
    case WM_ERASEBKGND:
      return 1;
    case WM_TIMER:
      if (w_param == kAnimationTimer) {
        ++g.animation_tick;
        if (g.displayed_progress < g.progress) {
          const int delta = g.progress - g.displayed_progress;
          g.displayed_progress += std::max(1, delta / 6);
          if (g.displayed_progress > g.progress) g.displayed_progress = g.progress;
        }
        present();
      }
      return 0;
    case WM_LBUTTONDOWN:
      if (!minimize_hit(l_param)) {
        ReleaseCapture();
        SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
      }
      return 0;
    case WM_LBUTTONUP:
      if (minimize_hit(l_param)) hide_window();
      return 0;
    case WM_SYSCOMMAND:
      if ((w_param & 0xFFF0) == SC_MINIMIZE) {
        hide_window();
        return 0;
      }
      break;
    case kTrayMsg:
      if (l_param == WM_LBUTTONUP || l_param == WM_LBUTTONDBLCLK) show_window();
      return 0;
    case WM_CLOSE:
      hide_window();
      return 0;
    case WM_DESTROY:
      KillTimer(hwnd, kAnimationTimer);
      g.hwnd = nullptr;
      return 0;
  }
  return DefWindowProcW(hwnd, msg, w_param, l_param);
}

void ensure_class() {
  static bool once = false;
  if (once) return;
  once = true;
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = SplashWndProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hIcon = LoadIconW(wc.hInstance, MAKEINTRESOURCEW(IDI_CORAX_AGENT));
  wc.hIconSm = wc.hIcon;
  wc.lpszClassName = L"CORAXAgentSplash";
  RegisterClassExW(&wc);
}

void wait_with_animation(AgentSplash& splash, DWORD milliseconds) {
  const DWORD start = GetTickCount();
  while (GetTickCount() - start < milliseconds) {
    splash.pump();
    Sleep(16);
  }
}

}  // namespace

AgentSplash::AgentSplash() = default;

AgentSplash::~AgentSplash() { close(); }

void AgentSplash::show(const std::string& title_hint) {
  if (g.hwnd) return;
  ensure_gdiplus();
  ensure_class();
  g.scale = dpi_scale();
  g.width = sx(kLogicalWidth);
  g.height = sx(kLogicalHeight);
  g.subtitle = util::widen(title_hint.empty() ? "Инвентаризация" : title_hint);
  g.status = L"Подготавливаем всё необходимое…";
  g.progress = 4;
  g.displayed_progress = 0;
  g.animation_tick = 0;
  g.busy = false;
  g.visual = VisualState::Running;
  const int icon_px = std::max(sx(36), 32);
  g.icon = static_cast<HICON>(LoadImageW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDI_CORAX_AGENT), IMAGE_ICON,
                                         icon_px, icon_px, LR_DEFAULTCOLOR));

  const int screen_x = GetSystemMetrics(SM_CXSCREEN);
  const int screen_y = GetSystemMetrics(SM_CYSCREEN);
  g.hidden = false;
  g.hwnd = CreateWindowExW(WS_EX_LAYERED | WS_EX_APPWINDOW, L"CORAXAgentSplash", L"Corax", WS_POPUP,
                           (screen_x - g.width) / 2, (screen_y - g.height) / 3, g.width, g.height, nullptr, nullptr,
                           GetModuleHandleW(nullptr), nullptr);
  if (!g.hwnd) return;
  hwnd_ = status_ = bar_ = g.hwnd;
  SetTimer(g.hwnd, kAnimationTimer, 16, nullptr);
  add_tray();
  ShowWindow(g.hwnd, SW_SHOWNORMAL);
  present();
  pump();
}

void AgentSplash::set_status(const std::string& text) {
  if (!g.hwnd) return;
  g.status = util::widen(text);
  present();
  pump();
}

void AgentSplash::set_progress(int percent_0_100) {
  if (!g.hwnd) return;
  g.progress = std::clamp(percent_0_100, 0, 100);
  if (g.progress < g.displayed_progress) g.displayed_progress = g.progress;
  g.busy = false;
  present();
  pump();
}

void AgentSplash::set_busy(bool busy) {
  if (!g.hwnd) return;
  g.busy = busy;
  present();
  pump();
}

void AgentSplash::pump() {
  MSG msg;
  while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
}

void AgentSplash::finish_ok(const std::string& detail) {
  if (!g.hwnd) return;
  g.busy = false;
  g.visual = VisualState::Success;
  g.progress = 100;
  g.displayed_progress = 100;
  std::string line = detail.empty() ? "Отчёт отправлен" : detail;
  const size_t nl = line.find('\n');
  if (nl != std::string::npos) line = line.substr(0, nl);
  if (line.size() > 72) line = line.substr(0, 69) + "...";
  g.status = util::widen(line);
  if (!g.hidden) {
    present();
    wait_with_animation(*this, detail.empty() ? 700 : 1400);
  }
  close();
}

void AgentSplash::finish_error(const std::string& detail) {
  if (!g.hwnd) return;
  g.busy = false;
  g.visual = VisualState::Error;
  std::string line = detail;
  const size_t nl = line.find('\n');
  if (nl != std::string::npos) line = line.substr(0, nl);
  if (line.size() > 72) line = line.substr(0, 69) + "...";
  g.status = util::widen(line.empty() ? "Не удалось отправить отчёт" : line);
  if (g.hidden) show_window();
  present();
  wait_with_animation(*this, 2200);
  close();
}

void AgentSplash::close() {
  if (g.hwnd) {
    remove_tray();
    KillTimer(g.hwnd, kAnimationTimer);
    DestroyWindow(g.hwnd);
    g.hwnd = nullptr;
  }
  hwnd_ = status_ = bar_ = nullptr;
  if (g.icon) {
    DestroyIcon(g.icon);
    g.icon = nullptr;
  }
  pump();
}
