#include "assist_ui.hpp"

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

struct Ui {
  HWND hwnd = nullptr;
  HWND tray = nullptr;
  std::wstring admin;
  int width = 0;
  int height = 0;
  float scale = 1.f;
  ULONG_PTR gdiplus = 0;
  bool gdiplus_ready = false;
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
                 const Gdiplus::Font& font, const Gdiplus::Color& color,
                 Gdiplus::StringAlignment align = Gdiplus::StringAlignmentNear) {
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
  gfx.SetTextRenderingHint(Gdiplus::TextRenderingHintClearTypeGridFit);
  gfx.Clear(Gdiplus::Color(0, 0, 0, 0));

  const float margin = static_cast<float>(sx(10));
  Gdiplus::RectF card(margin, margin * 0.35f, static_cast<float>(w) - margin * 2.f,
                      static_cast<float>(h) - margin);
  const float radius = static_cast<float>(sx(16));

  fill_round(gfx, Gdiplus::RectF(card.X, card.Y + static_cast<float>(sx(5)), card.Width, card.Height), radius,
             Gdiplus::Color(28, 15, 23, 42));

  Gdiplus::GraphicsPath clip;
  add_round(clip, card, radius);
  Gdiplus::SolidBrush glass(Gdiplus::Color(250, 255, 255, 255));
  gfx.FillPath(&glass, &clip);
  Gdiplus::Pen edge(Gdiplus::Color(255, 226, 232, 240), 1.f);
  gfx.DrawPath(&edge, &clip);

  const float badge = static_cast<float>(sx(36));
  Gdiplus::RectF mark(card.X + static_cast<float>(sx(14)), card.Y + (card.Height - badge) / 2.f, badge, badge);
  fill_round(gfx, mark, static_cast<float>(sx(10)), Gdiplus::Color(255, 37, 99, 235));
  Gdiplus::FontFamily family(L"Segoe UI");
  Gdiplus::Font mark_font(&family, static_cast<float>(sx(16)), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
  Gdiplus::StringFormat center;
  center.SetAlignment(Gdiplus::StringAlignmentCenter);
  center.SetLineAlignment(Gdiplus::StringAlignmentCenter);
  Gdiplus::SolidBrush white(Gdiplus::Color(255, 255, 255, 255));
  gfx.DrawString(L"C", -1, &mark_font, mark, &center, &white);

  Gdiplus::Font label(&family, static_cast<float>(sx(12)), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
  Gdiplus::Font name_font(&family, static_cast<float>(sx(16)), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
  Gdiplus::Font btn(&family, static_cast<float>(sx(13)), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);

  const int btn_w = sx(118);
  const int btn_h = sx(34);
  const int btn_x = static_cast<int>(card.GetRight()) - sx(14) - btn_w;
  const int btn_y = static_cast<int>(card.Y + (card.Height - static_cast<float>(btn_h)) / 2.f);
  g.end_rc = {btn_x, btn_y, btn_x + btn_w, btn_y + btn_h};

  const float text_x = mark.GetRight() + static_cast<float>(sx(12));
  const float text_w = static_cast<float>(btn_x) - text_x - static_cast<float>(sx(12));
  const float text_y = card.Y + static_cast<float>(sx(16));
  draw_string(gfx, L"К вам подключился сотрудник",
              Gdiplus::RectF(text_x, text_y, text_w, static_cast<float>(sx(18))), label,
              Gdiplus::Color(255, 75, 85, 99));
  std::wstring who = g.admin.empty() ? L"Сотрудник" : g.admin;
  draw_string(gfx, who, Gdiplus::RectF(text_x, text_y + static_cast<float>(sx(20)), text_w, static_cast<float>(sx(22))),
              name_font, Gdiplus::Color(255, 17, 24, 39));

  Gdiplus::RectF box(static_cast<float>(g.end_rc.left), static_cast<float>(g.end_rc.top),
                     static_cast<float>(g.end_rc.right - g.end_rc.left),
                     static_cast<float>(g.end_rc.bottom - g.end_rc.top));
  fill_round(gfx, box, static_cast<float>(sx(8)), Gdiplus::Color(255, 254, 242, 242));
  Gdiplus::Pen btn_edge(Gdiplus::Color(255, 254, 202, 202), 1.f);
  Gdiplus::GraphicsPath btn_path;
  add_round(btn_path, box, static_cast<float>(sx(8)));
  gfx.DrawPath(&btn_edge, &btn_path);
  Gdiplus::SolidBrush ink(Gdiplus::Color(255, 185, 28, 28));
  gfx.DrawString(L"Завершить", -1, &btn, box, &center, &ink);

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
    SetCursor(LoadCursor(nullptr, hit(g.end_rc, lp) ? IDC_HAND : IDC_ARROW));
    return 0;
  }
  if (msg == WM_LBUTTONUP) {
    if (hit(g.end_rc, lp)) notify(3);
    return 0;
  }
  if (msg == WM_DESTROY) {
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
  SetWindowPos(g.hwnd, HWND_TOPMOST, x, y, g.width, g.height, SWP_SHOWWINDOW | SWP_NOACTIVATE);
}

void recreate() {
  ensure_gdiplus();
  ensure_class();
  g.scale = dpi_scale();
  g.width = sx(460);
  g.height = sx(92);
  if (!g.hwnd) {
    const DWORD ex = WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE;
    g.hwnd = CreateWindowExW(ex, L"CORAXAssistBanner", L"Corax Assist", WS_POPUP, 0, 0, g.width, g.height, nullptr,
                             nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!g.hwnd) return;
  } else {
    SetWindowPos(g.hwnd, nullptr, 0, 0, g.width, g.height, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  }
  place();
  present();
}

}  // namespace

void assist_ui_live(void* tray_hwnd, const std::string& admin_name) {
  g.tray = static_cast<HWND>(tray_hwnd);
  g.admin = util::widen(admin_name);
  recreate();
}

void assist_ui_hide() {
  if (!g.hwnd) return;
  DestroyWindow(g.hwnd);
  g.hwnd = nullptr;
}

bool assist_ui_visible() { return g.hwnd != nullptr; }
