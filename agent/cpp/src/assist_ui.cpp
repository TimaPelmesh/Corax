#include "assist_ui.hpp"

#include "../resources/resource.h"
#include "util.hpp"

#include <windows.h>
#include <objidl.h>
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
  float phase = 0.f;
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

void add_round(Gdiplus::GraphicsPath& path, const Gdiplus::RectF& rect, float radius) {
  const float d = std::min(radius * 2.f, std::min(rect.Width, rect.Height));
  path.Reset();
  path.AddArc(rect.X, rect.Y, d, d, 180.f, 90.f);
  path.AddArc(rect.GetRight() - d, rect.Y, d, d, 270.f, 90.f);
  path.AddArc(rect.GetRight() - d, rect.GetBottom() - d, d, d, 0.f, 90.f);
  path.AddArc(rect.X, rect.GetBottom() - d, d, d, 90.f, 90.f);
  path.CloseFigure();
}

void fill_round(Gdiplus::Graphics& gfx, const Gdiplus::RectF& rect, float radius, const Gdiplus::Color& color) {
  Gdiplus::GraphicsPath path;
  add_round(path, rect, radius);
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

  g.phase += 0.012f;
  if (g.phase > 1.f) g.phase -= 1.f;

  const float margin = static_cast<float>(sx(14));
  Gdiplus::RectF card(margin, margin * 0.55f, static_cast<float>(w) - margin * 2.f,
                      static_cast<float>(h) - margin * 1.35f);
  const float radius = static_cast<float>(sx(22));
  fill_round(gfx, Gdiplus::RectF(card.X, card.Y + static_cast<float>(sx(8)), card.Width, card.Height), radius,
             Gdiplus::Color(36, 0, 0, 0));

  Gdiplus::GraphicsPath clip;
  add_round(clip, card, radius);
  Gdiplus::LinearGradientBrush glass(card, Gdiplus::Color(214, 46, 52, 64), Gdiplus::Color(228, 16, 18, 24),
                                     Gdiplus::LinearGradientModeVertical);
  gfx.FillPath(&glass, &clip);

  gfx.SetClip(&clip);
  const float travel = card.Width + static_cast<float>(sx(120));
  const float blob = static_cast<float>(sx(150));
  const float bx = card.X - blob * 0.35f + travel * g.phase;
  Gdiplus::SolidBrush liquid(Gdiplus::Color(42, 125, 186, 255));
  gfx.FillEllipse(&liquid, bx, card.Y - blob * 0.25f, blob, card.Height + blob * 0.45f);
  Gdiplus::SolidBrush sheen(Gdiplus::Color(28, 255, 255, 255));
  gfx.FillEllipse(&sheen, card.GetRight() - bx + card.X - blob * 0.2f, card.Y - static_cast<float>(sx(24)),
                  blob * 0.72f, card.Height * 0.7f);
  gfx.ResetClip();

  Gdiplus::Pen edge(Gdiplus::Color(78, 255, 255, 255), 1.f);
  gfx.DrawPath(&edge, &clip);

  Gdiplus::FontFamily family(L"Segoe UI");
  Gdiplus::Font title(&family, static_cast<float>(sx(15)), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
  Gdiplus::Font body(&family, static_cast<float>(sx(12)), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
  Gdiplus::Font btn(&family, static_cast<float>(sx(12)), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
  const Gdiplus::Color fg(255, 248, 248, 248);
  const Gdiplus::Color muted(255, 186, 196, 210);

  auto pill = [&](const RECT& rc, const Gdiplus::Color& fill, const wchar_t* label, const Gdiplus::Color& ink) {
    Gdiplus::RectF box(static_cast<float>(rc.left), static_cast<float>(rc.top),
                       static_cast<float>(rc.right - rc.left), static_cast<float>(rc.bottom - rc.top));
    fill_round(gfx, box, box.Height / 2.f, fill);
    Gdiplus::StringFormat center;
    center.SetAlignment(Gdiplus::StringAlignmentCenter);
    center.SetLineAlignment(Gdiplus::StringAlignmentCenter);
    Gdiplus::SolidBrush brush(ink);
    gfx.DrawString(label, -1, &btn, box, &center, &brush);
  };

  const int inset = static_cast<int>(card.X) + sx(16);
  const int inner_w = static_cast<int>(card.Width) - sx(32);
  if (g.mode == Mode::Offer) {
    draw_string(gfx, L"Доступ к экрану",
                Gdiplus::RectF(static_cast<float>(inset), card.Y + static_cast<float>(sx(16)),
                               static_cast<float>(inner_w), static_cast<float>(sx(20))),
                title, fg);
    std::wstring who = g.admin.empty() ? L"Администратор" : g.admin;
    draw_string(gfx, who,
                Gdiplus::RectF(static_cast<float>(inset), card.Y + static_cast<float>(sx(38)),
                               static_cast<float>(inner_w), static_cast<float>(sx(18))),
                body, muted);
    const int bh = sx(34);
    const int gap = sx(8);
    const int by = static_cast<int>(card.GetBottom()) - sx(16) - bh;
    const int bw = (inner_w - gap) / 2;
    g.deny_rc = {inset, by, inset + bw, by + bh};
    g.allow_rc = {inset + bw + gap, by, inset + bw + gap + bw, by + bh};
    pill(g.deny_rc, Gdiplus::Color(42, 255, 255, 255), L"Нет", fg);
    pill(g.allow_rc, Gdiplus::Color(236, 96, 165, 250), L"Разрешить", Gdiplus::Color(255, 12, 18, 28));
  } else {
    draw_string(gfx, L"Экран виден",
                Gdiplus::RectF(static_cast<float>(inset), card.Y + static_cast<float>(sx(14)),
                               static_cast<float>(inner_w), static_cast<float>(sx(20))),
                title, fg);
    const int bh = sx(32);
    const int by = static_cast<int>(card.GetBottom()) - sx(14) - bh;
    g.end_rc = {inset, by, inset + inner_w, by + bh};
    pill(g.end_rc, Gdiplus::Color(220, 196, 54, 42), L"Завершить", Gdiplus::Color(255, 255, 255, 255));
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
  if (msg == WM_MOUSEMOVE) {
    const bool over = (g.mode == Mode::Offer && (hit(g.allow_rc, lp) || hit(g.deny_rc, lp))) ||
                      (g.mode == Mode::Live && hit(g.end_rc, lp));
    SetCursor(LoadCursor(nullptr, over ? IDC_HAND : IDC_ARROW));
    return 0;
  }
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
  g.width = sx(mode == Mode::Offer ? 312 : 248);
  g.height = sx(mode == Mode::Offer ? 176 : 132);
  if (!g.hwnd) {
    DWORD ex = WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST;
    if (mode == Mode::Live) ex |= WS_EX_NOACTIVATE;
    g.hwnd = CreateWindowExW(ex, L"CORAXAssistBanner", L"Corax Assist", WS_POPUP, 0, 0, g.width, g.height, nullptr,
                             nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!g.hwnd) return;
    SetTimer(g.hwnd, kPulse, 70, nullptr);
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
