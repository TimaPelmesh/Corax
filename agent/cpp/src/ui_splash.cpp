#include "ui_splash.hpp"

#include "../resources/resource.h"
#include "util.hpp"

#include <windows.h>

#include <algorithm>
#include <string>

#pragma comment(lib, "msimg32.lib")

namespace {

constexpr int kWindowWidth = 620;
constexpr int kWindowHeight = 382;
constexpr UINT_PTR kAnimationTimer = 1;
constexpr UINT kAnimationIntervalMs = 16;

constexpr COLORREF kBgTop = RGB(255, 255, 255);
constexpr COLORREF kBgBottom = RGB(245, 249, 255);
constexpr COLORREF kCard = RGB(255, 255, 255);
constexpr COLORREF kCardBorder = RGB(210, 224, 246);
constexpr COLORREF kText = RGB(9, 15, 28);
constexpr COLORREF kMuted = RGB(82, 98, 122);
constexpr COLORREF kDim = RGB(142, 158, 181);
constexpr COLORREF kAccent = RGB(37, 99, 235);
constexpr COLORREF kAccentDark = RGB(30, 64, 175);
constexpr COLORREF kAccentSoft = RGB(219, 234, 254);
constexpr COLORREF kAccentFaint = RGB(239, 246, 255);

enum class VisualState { Running, Success, Error };

struct SplashState {
  HWND hwnd = nullptr;
  HICON icon = nullptr;
  HFONT fontTitle = nullptr;
  HFONT fontSubtitle = nullptr;
  HFONT fontStatus = nullptr;
  HFONT fontSmall = nullptr;
  HFONT fontPercent = nullptr;
  std::wstring subtitle;
  std::wstring status = L"Готовим безопасный запуск…";
  int progress = 4;
  int displayed_progress = 0;
  int animation_tick = 0;
  bool busy = false;
  VisualState visual = VisualState::Running;
};

SplashState g;

COLORREF state_accent() {
  return kAccent;
}

COLORREF state_soft() { return kAccentSoft; }

void fill_round_rect(HDC hdc, const RECT& rect, int radius, COLORREF color) {
  HBRUSH brush = CreateSolidBrush(color);
  HPEN pen = CreatePen(PS_NULL, 0, color);
  HGDIOBJ old_brush = SelectObject(hdc, brush);
  HGDIOBJ old_pen = SelectObject(hdc, pen);
  RoundRect(hdc, rect.left, rect.top, rect.right, rect.bottom, radius, radius);
  SelectObject(hdc, old_pen);
  SelectObject(hdc, old_brush);
  DeleteObject(pen);
  DeleteObject(brush);
}

void stroke_round_rect(HDC hdc, const RECT& rect, int radius, COLORREF color) {
  HBRUSH hollow = static_cast<HBRUSH>(GetStockObject(HOLLOW_BRUSH));
  HPEN pen = CreatePen(PS_SOLID, 1, color);
  HGDIOBJ old_brush = SelectObject(hdc, hollow);
  HGDIOBJ old_pen = SelectObject(hdc, pen);
  RoundRect(hdc, rect.left, rect.top, rect.right, rect.bottom, radius, radius);
  SelectObject(hdc, old_pen);
  SelectObject(hdc, old_brush);
  DeleteObject(pen);
}

void fill_circle(HDC hdc, int center_x, int center_y, int radius, COLORREF color) {
  HBRUSH brush = CreateSolidBrush(color);
  HPEN pen = CreatePen(PS_NULL, 0, color);
  HGDIOBJ old_brush = SelectObject(hdc, brush);
  HGDIOBJ old_pen = SelectObject(hdc, pen);
  Ellipse(hdc, center_x - radius, center_y - radius, center_x + radius, center_y + radius);
  SelectObject(hdc, old_pen);
  SelectObject(hdc, old_brush);
  DeleteObject(pen);
  DeleteObject(brush);
}

void draw_text(HDC hdc, const std::wstring& value, RECT rect, HFONT font, COLORREF color,
               UINT format = DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX) {
  HGDIOBJ old_font = SelectObject(hdc, font);
  SetBkMode(hdc, TRANSPARENT);
  SetTextColor(hdc, color);
  DrawTextW(hdc, value.c_str(), static_cast<int>(value.size()), &rect, format);
  SelectObject(hdc, old_font);
}

void draw_background(HDC hdc, const RECT& client) {
  TRIVERTEX vertices[2]{};
  vertices[0].x = client.left;
  vertices[0].y = client.top;
  vertices[0].Red = static_cast<COLOR16>(GetRValue(kBgTop) << 8);
  vertices[0].Green = static_cast<COLOR16>(GetGValue(kBgTop) << 8);
  vertices[0].Blue = static_cast<COLOR16>(GetBValue(kBgTop) << 8);
  vertices[0].Alpha = 0xFFFF;
  vertices[1].x = client.right;
  vertices[1].y = client.bottom;
  vertices[1].Red = static_cast<COLOR16>(GetRValue(kBgBottom) << 8);
  vertices[1].Green = static_cast<COLOR16>(GetGValue(kBgBottom) << 8);
  vertices[1].Blue = static_cast<COLOR16>(GetBValue(kBgBottom) << 8);
  vertices[1].Alpha = 0xFFFF;
  GRADIENT_RECT gradient{0, 1};
  GradientFill(hdc, vertices, 2, &gradient, 1, GRADIENT_FILL_RECT_V);

  // Quiet blue light keeps the white surface warm without looking like a system dialog.
  fill_circle(hdc, 575, 12, 88, RGB(232, 241, 255));
  fill_circle(hdc, 22, 374, 72, RGB(237, 245, 255));
}

void draw_close_button(HDC hdc) {
  RECT hover_area{570, 22, 600, 52};
  fill_round_rect(hdc, hover_area, 14, RGB(241, 245, 249));
  HPEN pen = CreatePen(PS_SOLID, 2, RGB(100, 116, 139));
  HGDIOBJ old_pen = SelectObject(hdc, pen);
  MoveToEx(hdc, 580, 32, nullptr);
  LineTo(hdc, 590, 42);
  MoveToEx(hdc, 590, 32, nullptr);
  LineTo(hdc, 580, 42);
  SelectObject(hdc, old_pen);
  DeleteObject(pen);
}

void draw_header(HDC hdc) {
  RECT icon_tile{24, 22, 88, 86};
  fill_round_rect(hdc, icon_tile, 20, kAccentFaint);
  stroke_round_rect(hdc, icon_tile, 20, RGB(191, 219, 254));
  if (g.icon) DrawIconEx(hdc, 32, 30, g.icon, 48, 48, 0, nullptr, DI_NORMAL);

  draw_text(hdc, L"CORAX Agent", RECT{104, 24, 390, 56}, g.fontTitle, kText);
  draw_text(hdc, g.subtitle, RECT{104, 57, 470, 82}, g.fontSubtitle, kMuted);

  RECT badge{438, 62, 592, 88};
  fill_round_rect(hdc, badge, 13, kAccentSoft);
  fill_circle(hdc, 453, 75, 4, kAccent);
  draw_text(hdc, L"ИНВЕНТАРИЗАЦИЯ", RECT{464, 62, 586, 88}, g.fontSmall, kAccentDark);
  draw_close_button(hdc);
}

void draw_status_card(HDC hdc) {
  RECT card{24, 110, 596, 300};
  fill_round_rect(hdc, RECT{27, 114, 599, 304}, 24, RGB(221, 232, 248));
  fill_round_rect(hdc, card, 24, kCard);
  stroke_round_rect(hdc, card, 24, kCardBorder);

  COLORREF accent = state_accent();
  COLORREF soft = state_soft();
  const int pulse = 12 + ((g.animation_tick / 5) % 4);
  fill_circle(hdc, 55, 149, pulse + 6, kAccentFaint);
  fill_circle(hdc, 55, 149, pulse, soft);
  fill_circle(hdc, 55, 149, 6, accent);

  std::wstring heading = L"Проверяем этот компьютер";
  if (g.visual == VisualState::Success) heading = L"Готово — всё прошло успешно";
  if (g.visual == VisualState::Error) heading = L"Не удалось завершить проверку";
  draw_text(hdc, heading, RECT{82, 124, 465, 153}, g.fontStatus, kText);
  draw_text(hdc, g.status, RECT{82, 154, 555, 181}, g.fontSubtitle, kMuted);

  const std::wstring percent = std::to_wstring(g.displayed_progress) + L"%";
  draw_text(hdc, percent, RECT{500, 125, 558, 158}, g.fontPercent, accent,
            DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX);

  RECT track{48, 202, 572, 216};
  fill_round_rect(hdc, track, 7, RGB(226, 232, 240));
  const int track_width = track.right - track.left;
  const int fill_width = std::max(14, (track_width * g.displayed_progress) / 100);
  RECT fill{track.left, track.top, std::min(track.right, track.left + fill_width), track.bottom};
  fill_round_rect(hdc, fill, 7, accent);

  if (g.busy && g.visual == VisualState::Running && fill.right - fill.left > 32) {
    const int usable = static_cast<int>(std::max<LONG>(1, fill.right - fill.left - 30));
    const int x = fill.left + ((g.animation_tick * 4) % usable);
    RECT shine{x, fill.top + 2, std::min<LONG>(fill.right, x + 28), fill.bottom - 2};
    fill_round_rect(hdc, shine, 5, RGB(147, 197, 253));
  }

  const wchar_t* labels[] = {L"Подготовка", L"Сбор данных", L"Отправка"};
  const int centers[] = {92, 309, 528};
  const int thresholds[] = {8, 20, 75};
  for (int i = 0; i < 3; ++i) {
    const bool active = g.displayed_progress >= thresholds[i];
    fill_circle(hdc, centers[i], 251, active ? 7 : 6, active ? accent : kDim);
    if (active) fill_circle(hdc, centers[i], 251, 3, kText);
    draw_text(hdc, labels[i], RECT{centers[i] - 64, 267, centers[i] + 64, 289}, g.fontSmall,
              active ? kText : kDim, DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX);
    if (i < 2) {
      HPEN line_pen = CreatePen(PS_SOLID, 1, active ? RGB(147, 197, 253) : RGB(226, 232, 240));
      HGDIOBJ old_pen = SelectObject(hdc, line_pen);
      MoveToEx(hdc, centers[i] + 13, 251, nullptr);
      LineTo(hdc, centers[i + 1] - 13, 251);
      SelectObject(hdc, old_pen);
      DeleteObject(line_pen);
    }
  }
}

void draw_footer(HDC hdc) {
  fill_circle(hdc, 36, 336, 4, kAccent);
  draw_text(hdc, L"Можно продолжать работать — агент всё сделает сам",
            RECT{50, 321, 475, 350}, g.fontSubtitle, kMuted);
  draw_text(hdc, L"CORAX • локальная инвентаризация", RECT{350, 350, 585, 371}, g.fontSmall, kDim,
            DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX);
}

void paint_window(HWND hwnd) {
  PAINTSTRUCT paint{};
  HDC window_dc = BeginPaint(hwnd, &paint);
  RECT client{};
  GetClientRect(hwnd, &client);

  HDC buffer_dc = CreateCompatibleDC(window_dc);
  HBITMAP buffer = CreateCompatibleBitmap(window_dc, client.right, client.bottom);
  HGDIOBJ old_bitmap = SelectObject(buffer_dc, buffer);

  draw_background(buffer_dc, client);
  draw_header(buffer_dc);
  draw_status_card(buffer_dc);
  draw_footer(buffer_dc);

  BitBlt(window_dc, 0, 0, client.right, client.bottom, buffer_dc, 0, 0, SRCCOPY);
  SelectObject(buffer_dc, old_bitmap);
  DeleteObject(buffer);
  DeleteDC(buffer_dc);
  EndPaint(hwnd, &paint);
}

bool close_button_hit(LPARAM point) {
  const int x = static_cast<short>(LOWORD(point));
  const int y = static_cast<short>(HIWORD(point));
  return x >= 566 && x <= 604 && y >= 18 && y <= 56;
}

LRESULT CALLBACK SplashWndProc(HWND hwnd, UINT msg, WPARAM w_param, LPARAM l_param) {
  switch (msg) {
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT:
      paint_window(hwnd);
      return 0;
    case WM_TIMER:
      if (w_param == kAnimationTimer) {
        ++g.animation_tick;
        if (g.displayed_progress < g.progress) {
          const int delta = g.progress - g.displayed_progress;
          g.displayed_progress += std::max(1, delta / 7);
          if (g.displayed_progress > g.progress) g.displayed_progress = g.progress;
        }
        InvalidateRect(hwnd, nullptr, FALSE);
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
  wc.style = CS_HREDRAW | CS_VREDRAW | CS_DROPSHADOW;
  wc.lpfnWndProc = SplashWndProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
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
  SetProcessDPIAware();
  ensure_class();

  g.subtitle = util::widen(title_hint.empty() ? "Агент инвентаризации" : title_hint);
  g.status = L"Подготавливаем всё необходимое…";
  g.progress = 4;
  g.displayed_progress = 0;
  g.animation_tick = 0;
  g.busy = false;
  g.visual = VisualState::Running;

  g.fontTitle = CreateFontW(30, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  g.fontSubtitle = CreateFontW(16, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                               OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                               DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  g.fontStatus = CreateFontW(21, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                             OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  g.fontSmall = CreateFontW(12, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  g.fontPercent = CreateFontW(24, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                              OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                              DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  g.icon = static_cast<HICON>(LoadImageW(GetModuleHandleW(nullptr),
                                         MAKEINTRESOURCEW(IDI_CORAX_AGENT), IMAGE_ICON, 48, 48,
                                         LR_DEFAULTCOLOR | LR_SHARED));

  const int screen_x = GetSystemMetrics(SM_CXSCREEN);
  const int screen_y = GetSystemMetrics(SM_CYSCREEN);
  g.hwnd = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, L"CORAXAgentSplash", L"CORAX Agent",
                           WS_POPUP, (screen_x - kWindowWidth) / 2,
                           (screen_y - kWindowHeight) / 2, kWindowWidth, kWindowHeight, nullptr,
                           nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!g.hwnd) return;

  SetWindowRgn(g.hwnd,
               CreateRoundRectRgn(0, 0, kWindowWidth + 1, kWindowHeight + 1, 28, 28), TRUE);
  SetTimer(g.hwnd, kAnimationTimer, kAnimationIntervalMs, nullptr);

  hwnd_ = g.hwnd;
  status_ = g.hwnd;
  bar_ = g.hwnd;
  ShowWindow(g.hwnd, SW_SHOWNORMAL);
  UpdateWindow(g.hwnd);
  pump();
}

void AgentSplash::set_status(const std::string& text) {
  if (!g.hwnd) return;
  g.status = util::widen(text);
  InvalidateRect(g.hwnd, nullptr, FALSE);
  pump();
}

void AgentSplash::set_progress(int percent_0_100) {
  if (!g.hwnd) return;
  g.progress = std::clamp(percent_0_100, 0, 100);
  if (g.progress < g.displayed_progress) g.displayed_progress = g.progress;
  g.busy = false;
  InvalidateRect(g.hwnd, nullptr, FALSE);
  pump();
}

void AgentSplash::set_busy(bool busy) {
  if (!g.hwnd) return;
  g.busy = busy;
  InvalidateRect(g.hwnd, nullptr, FALSE);
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
  g.status = L"Отчёт успешно отправлен в панель CORAX";
  InvalidateRect(g.hwnd, nullptr, FALSE);
  wait_with_animation(*this, 1500);
  close();
}

void AgentSplash::finish_error(const std::string& detail) {
  if (!g.hwnd) return;
  g.busy = false;
  g.visual = VisualState::Error;
  g.status = L"Проверьте настройки — ваши данные не потеряны";
  InvalidateRect(g.hwnd, nullptr, FALSE);
  wait_with_animation(*this, 350);
  MessageBoxW(g.hwnd, util::widen(detail).c_str(), L"CORAX Agent",
              MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST);
  close();
}

void AgentSplash::close() {
  if (g.hwnd) {
    KillTimer(g.hwnd, kAnimationTimer);
    DestroyWindow(g.hwnd);
    g.hwnd = nullptr;
  }
  hwnd_ = status_ = bar_ = nullptr;

  for (HFONT* font : {&g.fontTitle, &g.fontSubtitle, &g.fontStatus, &g.fontSmall, &g.fontPercent}) {
    if (*font) {
      DeleteObject(*font);
      *font = nullptr;
    }
  }
  pump();
}
