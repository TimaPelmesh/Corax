#include "assist_ui.hpp"

#include "../resources/resource.h"
#include "util.hpp"

#include <windows.h>
#include <gdiplus.h>

#include <algorithm>
#include <cstring>
#include <string>

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "msimg32.lib")

namespace {

constexpr UINT kAssistClick = WM_APP + 41;
constexpr UINT_PTR kPulse = 1;

enum class Mode { Hidden, Offer, Live };

struct Ui {
  HWND hwnd = nullptr;
  HWND tray = nullptr;
  Mode mode = Mode::Hidden;
  std::wstring admin;
  int width = 0;
  int height = 0;
  float scale = 1.f;
  ULONG_PTR gdiplus = 0;
  bool gdiplus_ready = false;
  RECT allow_rc{};
  RECT deny_rc{};
  RECT end_rc{};
};

Ui g;

int sx(int value) { return std::max(1, static_cast<int>(value * g.scale + 0.5f)); }

float dpi_scale() {
  using GetDpiFn = UINT(WINAPI*)();
  if (HMODULE user = GetModuleHandleW(L"user32.dll")) {
    if (auto fn = reinterpret_cast<GetDpiFn>(GetProcAddress(user, "GetDpiForSystem"))) {
      const UINT dpi = fn();
      if (dpi >= 96) return static_cast<float>(dpi) / 96.f;
    }
  }
  return 1.f;
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
                 const Gdiplus::Font& font, const Gdiplus::Color& color) {
  Gdiplus::StringFormat format;
  format.SetAlignment(Gdiplus::StringAlignmentNear);
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
  gfx.SetTextRenderingHint(Gdiplus::TextRenderingHintClearTypeGridFit);
  gfx.Clear(Gdiplus::Color(0, 0, 0, 0));

  Gdiplus::RectF card(0, 0, static_cast<float>(w), static_cast<float>(h));
  fill_round(gfx, card, static_cast<float>(sx(10)), Gdiplus::Color(235, 32, 32, 32));

  Gdiplus::FontFamily family(L"Segoe UI");
  Gdiplus::Font title(&family, static_cast<float>(sx(13)), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
  Gdiplus::Font body(&family, static_cast<float>(sx(12)), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
  Gdiplus::Font btn(&family, static_cast<float>(sx(12)), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);

  const Gdiplus::Color fg(255, 243, 243, 243);
  const Gdiplus::Color muted(255, 197, 197, 197);
  const Gdiplus::Color primary(255, 96, 165, 250);
  const Gdiplus::Color on_primary(255, 10, 10, 10);

  if (g.mode == Mode::Offer) {
    draw_string(gfx, L"Corax Assist", Gdiplus::RectF(static_cast<float>(sx(16)), static_cast<float>(sx(10)),
                                                     static_cast<float>(sx(220)), static_cast<float>(sx(18))),
                title, fg);
    std::wstring line = g.admin.empty() ? L"Администратор хочет помочь с этим экраном"
                                        : g.admin + L" хочет помочь с этим экраном";
    draw_string(gfx, line, Gdiplus::RectF(static_cast<float>(sx(16)), static_cast<float>(sx(28)),
                                          static_cast<float>(w - sx(200)), static_cast<float>(sx(18))),
                body, muted);

    const int bw = sx(88);
    const int bh = sx(28);
    const int by = (h - bh) / 2;
    g.deny_rc = {w - sx(16) - bw, by, w - sx(16), by + bh};
    g.allow_rc = {g.deny_rc.left - sx(8) - bw, by, g.deny_rc.left - sx(8), by + bh};
    fill_round(gfx,
               Gdiplus::RectF(static_cast<float>(g.allow_rc.left), static_cast<float>(g.allow_rc.top),
                              static_cast<float>(bw), static_cast<float>(bh)),
               static_cast<float>(sx(6)), primary);
    fill_round(gfx,
               Gdiplus::RectF(static_cast<float>(g.deny_rc.left), static_cast<float>(g.deny_rc.top),
                              static_cast<float>(bw), static_cast<float>(bh)),
               static_cast<float>(sx(6)), Gdiplus::Color(40, 255, 255, 255));
    Gdiplus::StringFormat center;
    center.SetAlignment(Gdiplus::StringAlignmentCenter);
    center.SetLineAlignment(Gdiplus::StringAlignmentCenter);
    Gdiplus::SolidBrush ink(on_primary);
    Gdiplus::SolidBrush ghost(fg);
    Gdiplus::RectF ar(static_cast<float>(g.allow_rc.left), static_cast<float>(g.allow_rc.top), static_cast<float>(bw),
                      static_cast<float>(bh));
    Gdiplus::RectF dr(static_cast<float>(g.deny_rc.left), static_cast<float>(g.deny_rc.top), static_cast<float>(bw),
                      static_cast<float>(bh));
    gfx.DrawString(L"Разрешить", -1, &btn, ar, &center, &ink);
    gfx.DrawString(L"Нет", -1, &btn, dr, &center, &ghost);
  } else {
    draw_string(gfx, L"Экран виден администратору",
                Gdiplus::RectF(static_cast<float>(sx(16)), static_cast<float>(sx(8)), static_cast<float>(w - sx(140)),
                               static_cast<float>(h - sx(16))),
                title, fg);
    const int bw = sx(100);
    const int bh = sx(26);
    const int by = (h - bh) / 2;
    g.end_rc = {w - sx(14) - bw, by, w - sx(14), by + bh};
    fill_round(gfx,
               Gdiplus::RectF(static_cast<float>(g.end_rc.left), static_cast<float>(g.end_rc.top),
                              static_cast<float>(bw), static_cast<float>(bh)),
               static_cast<float>(sx(6)), Gdiplus::Color(255, 196, 43, 28));
    Gdiplus::StringFormat center;
    center.SetAlignment(Gdiplus::StringAlignmentCenter);
    center.SetLineAlignment(Gdiplus::StringAlignmentCenter);
    Gdiplus::SolidBrush white(Gdiplus::Color(255, 255, 255, 255));
    Gdiplus::RectF er(static_cast<float>(g.end_rc.left), static_cast<float>(g.end_rc.top), static_cast<float>(bw),
                      static_cast<float>(bh));
    gfx.DrawString(L"Завершить", -1, &btn, er, &center, &white);
  }

  Gdiplus::BitmapData data;
  Gdiplus::Rect lock(0, 0, w, h);
  if (bmp.LockBits(&lock, Gdiplus::ImageLockModeRead, PixelFormat32bppPARGB, &data) != Gdiplus::Ok) return;
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = w;
  info.bmiHeader.biHeight = -h;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  HDC screen = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(screen);
  void* bits = nullptr;
  HBITMAP dib = CreateDIBSection(mem, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (dib && bits) {
    memcpy(bits, data.Scan0, static_cast<size_t>(w * h * 4));
    HGDIOBJ old = SelectObject(mem, dib);
    SIZE size{w, h};
    POINT src{0, 0};
    POINT dst{};
    RECT wr{};
    GetWindowRect(g.hwnd, &wr);
    dst.x = wr.left;
    dst.y = wr.top;
    BLENDFUNCTION blend{AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
    UpdateLayeredWindow(g.hwnd, screen, &dst, &size, mem, &src, 0, &blend, ULW_ALPHA);
    SelectObject(mem, old);
  }
  if (dib) DeleteObject(dib);
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);
  bmp.UnlockBits(&data);
}

bool hit(const RECT& rc, LPARAM lp) {
  const int x = static_cast<short>(LOWORD(lp));
  const int y = static_cast<short>(HIWORD(lp));
  return x >= rc.left && x < rc.right && y >= rc.top && y < rc.bottom;
}

void notify(int code) {
  if (g.tray) PostMessageW(g.tray, kAssistClick, static_cast<WPARAM>(code), 0);
}

LRESULT CALLBACK AssistWnd(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_LBUTTONUP) {
    if (g.mode == Mode::Offer) {
      if (hit(g.allow_rc, lp)) notify(1);
      else if (hit(g.deny_rc, lp)) notify(2);
    } else if (g.mode == Mode::Live && hit(g.end_rc, lp)) {
      notify(3);
    }
    return 0;
  }
  if (msg == WM_TIMER && wp == kPulse) {
    present();
    return 0;
  }
  if (msg == WM_DESTROY) {
    KillTimer(hwnd, kPulse);
    g.hwnd = nullptr;
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

void ensure_class() {
  static bool once = false;
  if (once) return;
  once = true;
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = AssistWnd;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.lpszClassName = L"CORAXAssistBanner";
  RegisterClassExW(&wc);
}

void place() {
  RECT work{};
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  const int x = work.left + (work.right - work.left - g.width) / 2;
  const int y = work.top + sx(12);
  SetWindowPos(g.hwnd, HWND_TOPMOST, x, y, g.width, g.height, SWP_SHOWWINDOW);
}

void recreate(Mode mode) {
  ensure_gdiplus();
  ensure_class();
  g.scale = dpi_scale();
  g.mode = mode;
  g.width = sx(mode == Mode::Offer ? 520 : 360);
  g.height = sx(mode == Mode::Offer ? 56 : 40);
  if (!g.hwnd) {
    DWORD ex = WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST;
    if (mode == Mode::Live) ex |= WS_EX_NOACTIVATE;
    g.hwnd = CreateWindowExW(ex, L"CORAXAssistBanner", L"Corax Assist", WS_POPUP, 0, 0, g.width, g.height, nullptr,
                             nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!g.hwnd) return;
    SetTimer(g.hwnd, kPulse, 400, nullptr);
  } else {
    LONG_PTR ex = GetWindowLongPtrW(g.hwnd, GWL_EXSTYLE);
    if (mode == Mode::Live) ex |= WS_EX_NOACTIVATE;
    else ex &= ~static_cast<LONG_PTR>(WS_EX_NOACTIVATE);
    SetWindowLongPtrW(g.hwnd, GWL_EXSTYLE, ex);
  }
  place();
  present();
  if (mode == Mode::Offer) SetForegroundWindow(g.hwnd);
}

}  // namespace

void assist_ui_offer(void* tray_hwnd, const std::string& admin_name) {
  g.tray = static_cast<HWND>(tray_hwnd);
  g.admin = util::widen(admin_name);
  recreate(Mode::Offer);
}

void assist_ui_live(void* tray_hwnd) {
  g.tray = static_cast<HWND>(tray_hwnd);
  recreate(Mode::Live);
}

void assist_ui_hide() {
  if (!g.hwnd) return;
  DestroyWindow(g.hwnd);
  g.hwnd = nullptr;
  g.mode = Mode::Hidden;
}

bool assist_ui_visible() { return g.hwnd != nullptr; }
