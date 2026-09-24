#include "tray.hpp"

#include "../resources/resource.h"
#include "config.hpp"
#include "poll.hpp"
#include "util.hpp"

#include <windows.h>
#include <shellapi.h>

#include <string>

namespace {

constexpr UINT kTrayMsg = WM_APP + 20;
constexpr UINT_PTR kPollTimer = 1;
constexpr UINT kCmdStatus = 1;
constexpr UINT kCmdExit = 2;
constexpr wchar_t kClass[] = L"CORAX_AGENT_TRAY";

HWND g_hwnd = nullptr;
HWND g_about = nullptr;
std::wstring g_server;

constexpr UINT kPollMs = 15000;
constexpr wchar_t kAboutClass[] = L"CORAX_AGENT_ABOUT";

std::wstring server_label(const std::string& url) {
  std::string s = url;
  const auto scheme = s.find("://");
  if (scheme != std::string::npos) s = s.substr(scheme + 3);
  while (!s.empty() && s.back() == '/') s.pop_back();
  return util::widen(s);
}

void add_icon(HWND hwnd) {
  NOTIFYICONDATAW nid{};
  nid.cbSize = sizeof(nid);
  nid.hWnd = hwnd;
  nid.uID = 1;
  nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
  nid.uCallbackMessage = kTrayMsg;
  nid.hIcon = LoadIconW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDI_CORAX_AGENT));
  if (!nid.hIcon) nid.hIcon = LoadIconW(nullptr, MAKEINTRESOURCEW(32512));
  wcscpy_s(nid.szTip, L"CORAX — система инвентаризации");
  Shell_NotifyIconW(NIM_ADD, &nid);
}

void remove_icon(HWND hwnd) {
  NOTIFYICONDATAW nid{};
  nid.cbSize = sizeof(nid);
  nid.hWnd = hwnd;
  nid.uID = 1;
  Shell_NotifyIconW(NIM_DELETE, &nid);
}

LRESULT CALLBACK about_wnd(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_PAINT) {
    PAINTSTRUCT ps{};
    HDC dc = BeginPaint(hwnd, &ps);
    RECT rc{};
    GetClientRect(hwnd, &rc);
    HBRUSH bg = CreateSolidBrush(RGB(248, 250, 252));
    FillRect(dc, &rc, bg);
    DeleteObject(bg);
    RECT bar = rc;
    bar.bottom = 8;
    HBRUSH accent = CreateSolidBrush(RGB(14, 116, 144));
    FillRect(dc, &bar, accent);
    DeleteObject(accent);
    SetBkMode(dc, TRANSPARENT);
    HFONT title = CreateFontW(-22, 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    HFONT body = CreateFontW(-16, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    HFONT host = CreateFontW(-18, 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    SetTextColor(dc, RGB(15, 23, 42));
    SelectObject(dc, title);
    TextOutW(dc, 24, 28, L"CORAX", 5);
    SetTextColor(dc, RGB(71, 85, 105));
    SelectObject(dc, body);
    TextOutW(dc, 24, 62, L"Система инвентаризации", 22);
    TextOutW(dc, 24, 98, L"Сервер", 6);
    SetTextColor(dc, RGB(15, 23, 42));
    SelectObject(dc, host);
    const wchar_t* label = g_server.empty() ? L"не задан" : g_server.c_str();
    TextOutW(dc, 24, 120, label, static_cast<int>(wcslen(label)));
    DeleteObject(title);
    DeleteObject(body);
    DeleteObject(host);
    EndPaint(hwnd, &ps);
    return 0;
  }
  if (msg == WM_CLOSE) {
    DestroyWindow(hwnd);
    return 0;
  }
  if (msg == WM_DESTROY) {
    g_about = nullptr;
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

void show_status() {
  AgentConfig cfg = load_agent_config();
  g_server = server_label(cfg.server_url);
  if (!cfg.agent_token.empty()) SecureZeroMemory(cfg.agent_token.data(), cfg.agent_token.size());
  if (g_about && IsWindow(g_about)) {
    SetForegroundWindow(g_about);
    return;
  }
  HINSTANCE inst = GetModuleHandleW(nullptr);
  WNDCLASSW wc{};
  if (!GetClassInfoW(inst, kAboutClass, &wc)) {
    wc.lpfnWndProc = about_wnd;
    wc.hInstance = inst;
    wc.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));
    wc.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    wc.lpszClassName = kAboutClass;
    wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(IDI_CORAX_AGENT));
    RegisterClassW(&wc);
  }
  const int w = 420;
  const int h = 210;
  RECT desk{};
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &desk, 0);
  int x = desk.left + ((desk.right - desk.left) - w) / 2;
  int y = desk.top + ((desk.bottom - desk.top) - h) / 2;
  g_about = CreateWindowExW(WS_EX_TOPMOST, kAboutClass, L"CORAX",
                            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, x, y, w, h, g_hwnd, nullptr, inst, nullptr);
  ShowWindow(g_about, SW_SHOWNORMAL);
  SetForegroundWindow(g_about);
}

void poll_tick() {
  AgentConfig cfg = load_agent_config();
  if (cfg.server_url.empty() || cfg.agent_token.empty()) return;
  poll_and_maybe_collect(cfg);
  if (!cfg.agent_token.empty()) SecureZeroMemory(cfg.agent_token.data(), cfg.agent_token.size());
}

LRESULT CALLBACK tray_wnd(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == kTrayMsg) {
    if (lp == WM_LBUTTONDBLCLK) show_status();
    if (lp == WM_RBUTTONUP) {
      HMENU menu = CreatePopupMenu();
      AppendMenuW(menu, MF_STRING, kCmdStatus, L"Состояние");
      AppendMenuW(menu, MF_STRING, kCmdExit, L"Выйти");
      POINT pt{};
      GetCursorPos(&pt);
      SetForegroundWindow(hwnd);
      TrackPopupMenu(menu, TPM_RIGHTALIGN | TPM_BOTTOMALIGN, pt.x, pt.y, 0, hwnd, nullptr);
      DestroyMenu(menu);
    }
    return 0;
  }
  if (msg == WM_COMMAND) {
    if (LOWORD(wp) == kCmdStatus) show_status();
    if (LOWORD(wp) == kCmdExit) DestroyWindow(hwnd);
    return 0;
  }
  if (msg == WM_TIMER && wp == kPollTimer) {
    poll_tick();
    return 0;
  }
  if (msg == WM_DESTROY) {
    remove_icon(hwnd);
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

}  // namespace

void launch_tray_process(const std::string& install_dir) {
  std::wstring exe = util::widen(install_dir) + L"\\CORAX-Agent.exe";
  std::wstring cmd = L"\"" + exe + L"\" --tray";
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION pi{};
  if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, DETACHED_PROCESS | BELOW_NORMAL_PRIORITY_CLASS,
                      nullptr, util::widen(install_dir).c_str(), &si, &pi)) {
    return;
  }
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
}

int run_tray() {
  if (FindWindowW(kClass, nullptr)) return 0;
  SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
  WNDCLASSW wc{};
  wc.lpfnWndProc = tray_wnd;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = kClass;
  RegisterClassW(&wc);
  g_hwnd = CreateWindowExW(0, kClass, L"CORAX", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, wc.hInstance, nullptr);
  if (!g_hwnd) return 1;
  add_icon(g_hwnd);
  SetTimer(g_hwnd, kPollTimer, kPollMs, nullptr);
  poll_tick();
  MSG msg{};
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return 0;
}
