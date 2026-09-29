#include "tray.hpp"

#include "../resources/resource.h"
#include "config.hpp"
#include "poll.hpp"
#include "util.hpp"

#include <windows.h>
#include <shellapi.h>

#include <algorithm>
#include <string>

namespace {

constexpr UINT kTrayMsg = WM_APP + 20;
constexpr UINT_PTR kPollTimer = 1;
constexpr UINT kCmdExit = 2;
constexpr wchar_t kClass[] = L"CORAX_AGENT_TRAY";

HWND g_hwnd = nullptr;
HICON g_icon = nullptr;

constexpr UINT kPollMs = 15000;
bool g_icon_owned = false;

HICON tray_icon() {
  const int cx = std::max(GetSystemMetrics(SM_CXSMICON), 16);
  return static_cast<HICON>(LoadImageW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDI_CORAX_AGENT), IMAGE_ICON, cx,
                                       cx, LR_DEFAULTCOLOR));
}

void add_icon(HWND hwnd) {
  g_icon_owned = true;
  g_icon = tray_icon();
  if (!g_icon) g_icon_owned = false;
  NOTIFYICONDATAW nid{};
  nid.cbSize = sizeof(nid);
  nid.hWnd = hwnd;
  nid.uID = 1;
  nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
  nid.uCallbackMessage = kTrayMsg;
  nid.hIcon = g_icon ? g_icon : LoadIconW(nullptr, MAKEINTRESOURCEW(32512));
  wcscpy_s(nid.szTip, L"Corax — инвентаризация");
  Shell_NotifyIconW(NIM_ADD, &nid);
}

void remove_icon(HWND hwnd) {
  NOTIFYICONDATAW nid{};
  nid.cbSize = sizeof(nid);
  nid.hWnd = hwnd;
  nid.uID = 1;
  Shell_NotifyIconW(NIM_DELETE, &nid);
}

void poll_tick() {
  AgentConfig cfg = load_agent_config();
  if (cfg.server_url.empty() || cfg.agent_token.empty()) return;
  poll_and_maybe_collect(cfg);
  if (!cfg.agent_token.empty()) SecureZeroMemory(cfg.agent_token.data(), cfg.agent_token.size());
}

LRESULT CALLBACK tray_wnd(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == kTrayMsg) {
    if (lp == WM_RBUTTONUP) {
      HMENU menu = CreatePopupMenu();
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
    if (LOWORD(wp) == kCmdExit) DestroyWindow(hwnd);
    return 0;
  }
  if (msg == WM_TIMER && wp == kPollTimer) {
    poll_tick();
    return 0;
  }
  if (msg == WM_DESTROY) {
    remove_icon(hwnd);
    if (g_icon && g_icon_owned) DestroyIcon(g_icon);
    g_icon = nullptr;
    g_icon_owned = false;
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
