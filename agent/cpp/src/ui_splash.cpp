#include "ui_splash.hpp"
#include <string>
#include "util.hpp"

#include <windows.h>
#include <commctrl.h>
#pragma comment(lib, "comctl32.lib")

namespace {

constexpr COLORREF kBg = RGB(15, 23, 42);       // slate-900
constexpr COLORREF kCard = RGB(30, 41, 59);     // slate-800
constexpr COLORREF kText = RGB(248, 250, 252);  // slate-50
constexpr COLORREF kMuted = RGB(148, 163, 184); // slate-400
constexpr COLORREF kAccent = RGB(37, 99, 235);  // blue-600

struct SplashState {
  HWND hwnd = nullptr;
  HWND status = nullptr;
  HWND bar = nullptr;
  HWND brand = nullptr;
  HWND subtitle = nullptr;
  HBRUSH bg = nullptr;
  HBRUSH card = nullptr;
  HFONT fontTitle = nullptr;
  HFONT fontBody = nullptr;
  std::wstring statusText;
  bool marquee = false;
};

SplashState g;

LRESULT CALLBACK SplashWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
  switch (msg) {
    case WM_ERASEBKGND: {
      HDC hdc = (HDC)wParam;
      RECT rc{};
      GetClientRect(hwnd, &rc);
      FillRect(hdc, &rc, g.bg);
      return 1;
    }
    case WM_CTLCOLORSTATIC: {
      HDC hdc = (HDC)wParam;
      // Opaque bg — TRANSPARENT + NULL_BRUSH stacks old glyphs on every SetWindowText.
      SetBkMode(hdc, OPAQUE);
      SetBkColor(hdc, kBg);
      HWND ctrl = (HWND)lParam;
      if (ctrl == g.brand) {
        SetTextColor(hdc, kAccent);
      } else if (ctrl == g.subtitle) {
        SetTextColor(hdc, kMuted);
      } else {
        SetTextColor(hdc, kText);
      }
      return (LRESULT)g.bg;
    }
    case WM_CLOSE:
      DestroyWindow(hwnd);
      return 0;
    case WM_DESTROY:
      g.hwnd = nullptr;
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wParam, lParam);
}

void ensure_class() {
  static bool once = false;
  if (once) return;
  once = true;
  INITCOMMONCONTROLSEX icc{sizeof(icc), ICC_PROGRESS_CLASS};
  InitCommonControlsEx(&icc);

  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = SplashWndProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = CreateSolidBrush(kBg);
  wc.lpszClassName = L"CORAXAgentSplash";
  RegisterClassExW(&wc);
}

void set_marquee(bool on) {
  if (!g.bar || g.marquee == on) return;
  g.marquee = on;
  LONG_PTR style = GetWindowLongPtrW(g.bar, GWL_STYLE);
  if (on) {
    SetWindowLongPtrW(g.bar, GWL_STYLE, style | PBS_MARQUEE);
    SendMessageW(g.bar, PBM_SETMARQUEE, TRUE, 30);
  } else {
    SendMessageW(g.bar, PBM_SETMARQUEE, FALSE, 0);
    SetWindowLongPtrW(g.bar, GWL_STYLE, style & ~PBS_MARQUEE);
    InvalidateRect(g.bar, nullptr, TRUE);
  }
}

}  // namespace

AgentSplash::AgentSplash() = default;

AgentSplash::~AgentSplash() { close(); }

void AgentSplash::show(const std::string& title_hint) {
  if (g.hwnd) return;
  ensure_class();
  g.bg = CreateSolidBrush(kBg);
  g.card = CreateSolidBrush(kCard);
  g.fontTitle = CreateFontW(28, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  g.fontBody = CreateFontW(16, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                           OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                           DEFAULT_PITCH | FF_SWISS, L"Segoe UI");

  const int w = 460;
  const int h = 220;
  int sx = GetSystemMetrics(SM_CXSCREEN);
  int sy = GetSystemMetrics(SM_CYSCREEN);
  g.hwnd = CreateWindowExW(
      WS_EX_TOPMOST | WS_EX_TOOLWINDOW, L"CORAXAgentSplash", L"CORAX Agent",
      WS_POPUP | WS_BORDER, (sx - w) / 2, (sy - h) / 2, w, h, nullptr, nullptr,
      GetModuleHandleW(nullptr), nullptr);
  if (!g.hwnd) return;

  g.brand = CreateWindowExW(0, L"STATIC", L"CORAX", WS_CHILD | WS_VISIBLE | SS_LEFT | SS_NOPREFIX, 28,
                            24, 400, 32, g.hwnd, nullptr, GetModuleHandleW(nullptr), nullptr);
  SendMessageW(g.brand, WM_SETFONT, (WPARAM)g.fontTitle, TRUE);

  std::wstring sub = util::widen(title_hint.empty() ? "Inventory agent" : title_hint);
  g.subtitle = CreateWindowExW(0, L"STATIC", sub.c_str(),
                               WS_CHILD | WS_VISIBLE | SS_LEFT | SS_NOPREFIX, 28, 58, 400, 22, g.hwnd,
                               nullptr, GetModuleHandleW(nullptr), nullptr);
  SendMessageW(g.subtitle, WM_SETFONT, (WPARAM)g.fontBody, TRUE);

  g.status = CreateWindowExW(0, L"STATIC", L"Подготовка…",
                             WS_CHILD | WS_VISIBLE | SS_LEFT | SS_NOPREFIX, 28, 110, 400, 24, g.hwnd,
                             nullptr, GetModuleHandleW(nullptr), nullptr);
  SendMessageW(g.status, WM_SETFONT, (WPARAM)g.fontBody, TRUE);

  g.bar = CreateWindowExW(0, PROGRESS_CLASSW, nullptr, WS_CHILD | WS_VISIBLE | PBS_SMOOTH, 28, 150,
                          400, 18, g.hwnd, nullptr, GetModuleHandleW(nullptr), nullptr);
  SendMessageW(g.bar, PBM_SETRANGE, 0, MAKELPARAM(0, 100));
  SendMessageW(g.bar, PBM_SETPOS, 5, 0);
  SendMessageW(g.bar, PBM_SETBARCOLOR, 0, kAccent);
  SendMessageW(g.bar, PBM_SETBKCOLOR, 0, kCard);

  hwnd_ = g.hwnd;
  status_ = g.status;
  bar_ = g.bar;

  ShowWindow(g.hwnd, SW_SHOW);
  UpdateWindow(g.hwnd);
  pump();
}

void AgentSplash::set_status(const std::string& text) {
  if (!g.status) return;
  g.statusText = util::widen(text);
  // Clear previous glyphs before new text (extra safety vs opaque brush).
  RECT rc{};
  GetClientRect(g.status, &rc);
  HDC hdc = GetDC(g.status);
  if (hdc) {
    FillRect(hdc, &rc, g.bg);
    ReleaseDC(g.status, hdc);
  }
  SetWindowTextW(g.status, g.statusText.c_str());
  InvalidateRect(g.status, nullptr, TRUE);
  UpdateWindow(g.status);
  pump();
}

void AgentSplash::set_progress(int percent_0_100) {
  if (!g.bar) return;
  if (percent_0_100 < 0) percent_0_100 = 0;
  if (percent_0_100 > 100) percent_0_100 = 100;
  set_marquee(false);
  SendMessageW(g.bar, PBM_SETPOS, percent_0_100, 0);
  InvalidateRect(g.bar, nullptr, TRUE);
  UpdateWindow(g.bar);
  pump();
}

void AgentSplash::set_busy(bool busy) {
  if (!g.bar) return;
  if (busy) {
    set_marquee(true);
  } else {
    set_marquee(false);
  }
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
  set_busy(false);
  set_progress(100);
  set_status("Готово");
  MessageBoxW(g.hwnd ? g.hwnd : nullptr, util::widen(detail).c_str(), L"CORAX Agent",
              MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST);
  close();
}

void AgentSplash::finish_error(const std::string& detail) {
  set_busy(false);
  set_status("Ошибка");
  MessageBoxW(g.hwnd ? g.hwnd : nullptr, util::widen(detail).c_str(), L"CORAX Agent — ошибка",
              MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST);
  close();
}

void AgentSplash::close() {
  set_busy(false);
  if (g.hwnd) {
    DestroyWindow(g.hwnd);
    g.hwnd = nullptr;
  }
  hwnd_ = status_ = bar_ = nullptr;
  g.status = g.bar = g.brand = g.subtitle = nullptr;
  if (g.fontTitle) {
    DeleteObject(g.fontTitle);
    g.fontTitle = nullptr;
  }
  if (g.fontBody) {
    DeleteObject(g.fontBody);
    g.fontBody = nullptr;
  }
  if (g.bg) {
    DeleteObject(g.bg);
    g.bg = nullptr;
  }
  if (g.card) {
    DeleteObject(g.card);
    g.card = nullptr;
  }
  pump();
}
