#include "ui_splash.hpp"

#include "../resources/resource.h"
#include "util.hpp"

#include <windows.h>
#include <objidl.h>
#include <gdiplus.h>

#include <algorithm>
#include <string>

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "msimg32.lib")

namespace {

constexpr int kLogicalWidth = 480;
constexpr int kLogicalHeight = 236;
constexpr UINT_PTR kAnimationTimer = 1;

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

void present() {
  if (!g.hwnd || !g.gdiplus_ready) return;
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

  const int icon_px = sx(64);
  if (g.icon) {
    Gdiplus::Bitmap* icon_bmp = Gdiplus::Bitmap::FromHICON(g.icon);
    if (icon_bmp) {
      gfx.DrawImage(icon_bmp, sx(28), sx(26), icon_px, icon_px);
      delete icon_bmp;
    }
  }

  Gdiplus::FontFamily family(L"Segoe UI");
  Gdiplus::Font title(&family, static_cast<float>(sx(22)), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
  Gdiplus::Font sub(&family, static_cast<float>(sx(13)), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
  Gdiplus::Font body(&family, static_cast<float>(sx(14)), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
  Gdiplus::Font font_small(&family, static_cast<float>(sx(12)), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);

  const Gdiplus::Color ink(255, 15, 23, 42);
  const Gdiplus::Color muted(255, 100, 116, 139);
  const Gdiplus::Color accent = g.visual == VisualState::Error ? Gdiplus::Color(255, 185, 28, 28)
                                                               : Gdiplus::Color(255, 37, 99, 235);

  draw_string(gfx, L"Corax", Gdiplus::RectF(static_cast<float>(sx(104)), static_cast<float>(sx(30)),
                                            static_cast<float>(sx(240)), static_cast<float>(sx(28))),
              title, ink, Gdiplus::StringAlignmentNear);
  draw_string(gfx, g.subtitle.empty() ? L"Инвентаризация" : g.subtitle,
              Gdiplus::RectF(static_cast<float>(sx(104)), static_cast<float>(sx(58)), static_cast<float>(sx(250)),
                             static_cast<float>(sx(20))),
              sub, muted, Gdiplus::StringAlignmentNear);

  std::wstring heading = g.visual == VisualState::Success ? L"Отчёт отправлен" : g.status;
  if (g.visual == VisualState::Error && heading.empty()) heading = L"Не удалось отправить отчёт";
  draw_string(gfx, heading,
              Gdiplus::RectF(static_cast<float>(sx(28)), static_cast<float>(sx(108)), static_cast<float>(w - sx(56)),
                             static_cast<float>(sx(22))),
              body, g.visual == VisualState::Error ? accent : ink, Gdiplus::StringAlignmentNear);

  const float track_y = static_cast<float>(sx(146));
  const float track_x = static_cast<float>(sx(28));
  const float track_w = static_cast<float>(w - sx(56));
  const float track_h = static_cast<float>(sx(6));
  fill_round(gfx, Gdiplus::RectF(track_x, track_y, track_w, track_h), track_h / 2.f, Gdiplus::Color(255, 226, 232, 240));
  const int shown = std::clamp(g.displayed_progress, 0, 100);
  const float fill_w = std::max(track_h, track_w * (shown / 100.f));
  fill_round(gfx, Gdiplus::RectF(track_x, track_y, fill_w, track_h), track_h / 2.f, accent);

  const std::wstring percent = std::to_wstring(shown) + L"%";
  draw_string(gfx, percent,
              Gdiplus::RectF(static_cast<float>(w - sx(92)), static_cast<float>(sx(164)), static_cast<float>(sx(56)),
                             static_cast<float>(sx(18))),
              font_small, muted, Gdiplus::StringAlignmentFar);
  Gdiplus::Pen close_pen(Gdiplus::Color(255, 148, 163, 184), std::max(1.4f, g.scale));
  close_pen.SetStartCap(Gdiplus::LineCapRound);
  close_pen.SetEndCap(Gdiplus::LineCapRound);
  const float x0 = static_cast<float>(w - sx(36));
  const float y0 = static_cast<float>(sx(28));
  gfx.DrawLine(&close_pen, x0, y0, x0 + sx(10), y0 + sx(10));
  gfx.DrawLine(&close_pen, x0 + sx(10), y0, x0, y0 + sx(10));

  draw_string(gfx, L"Дальше только трей",
              Gdiplus::RectF(static_cast<float>(sx(28)), static_cast<float>(sx(164)), static_cast<float>(sx(220)),
                             static_cast<float>(sx(18))),
              font_small, muted, Gdiplus::StringAlignmentNear);

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

bool close_button_hit(LPARAM point) {
  const int x = static_cast<short>(LOWORD(point));
  const int y = static_cast<short>(HIWORD(point));
  return x >= g.width - sx(46) && x <= g.width - sx(16) && y >= sx(16) && y <= sx(46);
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
      if (!close_button_hit(l_param)) {
        ReleaseCapture();
        SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
      }
      return 0;
    case WM_LBUTTONUP:
      if (close_button_hit(l_param)) DestroyWindow(hwnd);
      return 0;
    case WM_CLOSE:
      DestroyWindow(hwnd);
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
  const int icon_px = std::max(sx(64), 64);
  g.icon = static_cast<HICON>(LoadImageW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDI_CORAX_AGENT), IMAGE_ICON,
                                         icon_px, icon_px, LR_DEFAULTCOLOR));

  const int screen_x = GetSystemMetrics(SM_CXSCREEN);
  const int screen_y = GetSystemMetrics(SM_CYSCREEN);
  g.hwnd = CreateWindowExW(WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW, L"CORAXAgentSplash", L"Corax",
                           WS_POPUP, (screen_x - g.width) / 2, (screen_y - g.height) / 2, g.width, g.height,
                           nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!g.hwnd) return;
  hwnd_ = status_ = bar_ = g.hwnd;
  SetTimer(g.hwnd, kAnimationTimer, 16, nullptr);
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

void AgentSplash::finish_ok(const std::string&) {
  if (!g.hwnd) return;
  g.busy = false;
  g.visual = VisualState::Success;
  g.progress = 100;
  g.displayed_progress = 100;
  g.status = L"Отчёт отправлен";
  present();
  wait_with_animation(*this, 900);
  close();
}

void AgentSplash::finish_error(const std::string& detail) {
  if (!g.hwnd) return;
  g.busy = false;
  g.visual = VisualState::Error;
  g.status = util::widen(detail);
  present();
  wait_with_animation(*this, 2200);
  close();
}

void AgentSplash::close() {
  if (g.hwnd) {
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
