#include "crash_handler.hpp"

#include <windows.h>
// dbghelp must follow windows.h.
#include <dbghelp.h>
#include <psapi.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <eh.h>
#include <stdexcept>
#include <string>

#pragma comment(lib, "dbghelp.lib")
#pragma comment(lib, "psapi.lib")

namespace {

std::string g_log_path;
std::atomic<bool> g_installed{false};
std::atomic<bool> g_dumped{false};  // one dump per process — avoid loops

std::string exe_directory() {
  wchar_t buf[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH);
  if (!n) return ".";
  std::wstring w(buf, n);
  size_t slash = w.find_last_of(L"\\/");
  if (slash == std::wstring::npos) return ".";
  w.resize(slash);
  int need = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string out(need, '\0');
  if (need > 0) {
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), out.data(), need, nullptr, nullptr);
  }
  return out;
}

// UTC timestamp `YYYYMMDD-HHMMSS` for the minidump filename (crash handler
// must not depend on std::chrono, some CRTs allocate through it).
std::string utc_stamp() {
  SYSTEMTIME st{};
  GetSystemTime(&st);
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%04u%02u%02u-%02u%02u%02u", st.wYear, st.wMonth, st.wDay,
                st.wHour, st.wMinute, st.wSecond);
  return buf;
}

std::string utc_iso() {
  SYSTEMTIME st{};
  GetSystemTime(&st);
  char buf[40];
  std::snprintf(buf, sizeof(buf), "%04u-%02u-%02uT%02u:%02u:%02uZ", st.wYear, st.wMonth, st.wDay,
                st.wHour, st.wMinute, st.wSecond);
  return buf;
}

// Append to log without touching STL streams (they can allocate; we're
// probably in a corrupted heap on OOM/AV crashes). Uses raw CreateFileW.
void append_log_line(const std::string& text) {
  if (g_log_path.empty()) return;
  int need =
      MultiByteToWideChar(CP_UTF8, 0, g_log_path.c_str(), (int)g_log_path.size(), nullptr, 0);
  if (need <= 0) return;
  std::wstring wpath((size_t)need, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, g_log_path.c_str(), (int)g_log_path.size(), wpath.data(), need);

  HANDLE file =
      CreateFileW(wpath.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                  OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return;
  SetFilePointer(file, 0, nullptr, FILE_END);
  std::string line = utc_iso() + "  " + text + "\r\n";
  DWORD written = 0;
  WriteFile(file, line.data(), (DWORD)line.size(), &written, nullptr);
  CloseHandle(file);
}

std::string hex64(uintptr_t v) {
  char buf[32];
  std::snprintf(buf, sizeof(buf), "0x%016llx", (unsigned long long)v);
  return buf;
}

std::string module_at(uintptr_t addr) {
  HMODULE mods[256];
  DWORD needed = 0;
  HANDLE self = GetCurrentProcess();
  if (!EnumProcessModules(self, mods, sizeof(mods), &needed)) return {};
  DWORD count = needed / sizeof(HMODULE);
  for (DWORD i = 0; i < count && i < 256; ++i) {
    MODULEINFO mi{};
    if (!GetModuleInformation(self, mods[i], &mi, sizeof(mi))) continue;
    uintptr_t base = (uintptr_t)mi.lpBaseOfDll;
    if (addr < base || addr >= base + mi.SizeOfImage) continue;
    wchar_t name[MAX_PATH];
    if (!GetModuleFileNameExW(self, mods[i], name, MAX_PATH)) continue;
    std::wstring w(name);
    size_t slash = w.find_last_of(L"\\/");
    std::wstring bare = (slash == std::wstring::npos) ? w : w.substr(slash + 1);
    int need = WideCharToMultiByte(CP_UTF8, 0, bare.c_str(), (int)bare.size(), nullptr, 0, nullptr,
                                   nullptr);
    std::string out((size_t)need, '\0');
    if (need > 0) {
      WideCharToMultiByte(CP_UTF8, 0, bare.c_str(), (int)bare.size(), out.data(), need, nullptr,
                          nullptr);
    }
    char off[32];
    std::snprintf(off, sizeof(off), "+0x%llx", (unsigned long long)(addr - base));
    return out + off;
  }
  return {};
}

// SEH exception-code → short mnemonic. Small closed set; keeps the message
// self-explanatory in the log without pulling in windows message tables.
const char* seh_name(DWORD code) {
  switch (code) {
    case EXCEPTION_ACCESS_VIOLATION: return "ACCESS_VIOLATION";
    case EXCEPTION_ARRAY_BOUNDS_EXCEEDED: return "ARRAY_BOUNDS_EXCEEDED";
    case EXCEPTION_BREAKPOINT: return "BREAKPOINT";
    case EXCEPTION_DATATYPE_MISALIGNMENT: return "DATATYPE_MISALIGNMENT";
    case EXCEPTION_FLT_DIVIDE_BY_ZERO: return "FLT_DIVIDE_BY_ZERO";
    case EXCEPTION_ILLEGAL_INSTRUCTION: return "ILLEGAL_INSTRUCTION";
    case EXCEPTION_IN_PAGE_ERROR: return "IN_PAGE_ERROR";
    case EXCEPTION_INT_DIVIDE_BY_ZERO: return "INT_DIVIDE_BY_ZERO";
    case EXCEPTION_INT_OVERFLOW: return "INT_OVERFLOW";
    case EXCEPTION_PRIV_INSTRUCTION: return "PRIV_INSTRUCTION";
    case EXCEPTION_STACK_OVERFLOW: return "STACK_OVERFLOW";
    case 0xE06D7363u /* MS C++ EH */: return "CPP_EH";
    default: return "SEH";
  }
}

std::string write_minidump(EXCEPTION_POINTERS* info) {
  if (g_dumped.exchange(true)) return {};  // one dump per process
  std::string dir = exe_directory();
  std::string path = dir + "\\corax-agent-crash-" + utc_stamp() + ".dmp";

  int need = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), (int)path.size(), nullptr, 0);
  std::wstring wpath((size_t)need, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, path.c_str(), (int)path.size(), wpath.data(), need);

  HANDLE file = CreateFileW(wpath.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return {};

  MINIDUMP_EXCEPTION_INFORMATION mei{};
  mei.ThreadId = GetCurrentThreadId();
  mei.ExceptionPointers = info;
  mei.ClientPointers = FALSE;

  // MiniDumpNormal keeps the file small (~200-600 KB) but still lets a dev
  // open it in WinDbg / VS with symbols and see the crashing frame. Enough
  // for a support-loop diagnostic; a "with data" variant would leak PII.
  MINIDUMP_TYPE type = (MINIDUMP_TYPE)(MiniDumpNormal | MiniDumpWithThreadInfo |
                                       MiniDumpWithIndirectlyReferencedMemory);
  BOOL ok = MiniDumpWriteDump(GetCurrentProcess(), GetCurrentProcessId(), file, type,
                              info ? &mei : nullptr, nullptr, nullptr);
  CloseHandle(file);
  if (!ok) return {};
  return path;
}

LONG WINAPI unhandled_seh_filter(EXCEPTION_POINTERS* info) {
  DWORD code = info && info->ExceptionRecord ? info->ExceptionRecord->ExceptionCode : 0;
  uintptr_t addr =
      info && info->ExceptionRecord ? (uintptr_t)info->ExceptionRecord->ExceptionAddress : 0;
  std::string mod = module_at(addr);
  std::string dump = write_minidump(info);

  std::string msg = std::string("crash: ") + seh_name(code) + " code=0x";
  char buf[16];
  std::snprintf(buf, sizeof(buf), "%08lx", (unsigned long)code);
  msg += buf;
  msg += " addr=" + hex64(addr);
  if (!mod.empty()) msg += " module=" + mod;
  if (!dump.empty()) msg += " dump=" + dump;
  append_log_line(msg);

  // Best-effort user notification. If the process was launched in --silent
  // mode this MessageBox still appears — that's on purpose, an operator who
  // notices `agent-crash.dmp` in the folder deserves to know why.
  std::string ui = "Агент CORAX упал.\n\nКод: ";
  ui += seh_name(code);
  ui += " (0x";
  ui += buf;
  ui += ")\n";
  if (!mod.empty()) ui += "Место: " + mod + "\n";
  if (!dump.empty()) ui += "\nМини-дамп: " + dump + "\n";
  ui += "\nЛог: " + g_log_path;
  int wneed = MultiByteToWideChar(CP_UTF8, 0, ui.c_str(), (int)ui.size(), nullptr, 0);
  std::wstring wui((size_t)wneed, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, ui.c_str(), (int)ui.size(), wui.data(), wneed);
  MessageBoxW(nullptr, wui.c_str(), L"CORAX Agent",
              MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST);

  // Let the OS terminate the process — Watson still gets a chance to log it.
  return EXCEPTION_EXECUTE_HANDLER;
}

}  // namespace

void install_process_crash_handler(const std::string& log_path) {
  if (g_installed.exchange(true)) return;
  g_log_path = log_path;

  // Disable Windows Error Reporting fault dialog (that "program stopped
  // working" modal) — we own the notification path via MessageBoxW above.
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  SetUnhandledExceptionFilter(&unhandled_seh_filter);

  // Some code paths (e.g., CRT-injected exception handlers, third-party DLLs
  // like WinHTTP proxying to schannel) call SetUnhandledExceptionFilter later
  // and displace ours. A vectored handler at the end of the chain is our
  // safety net: it fires before the CRT gets to swallow the exception.
  AddVectoredExceptionHandler(0 /* last-in-chain */, [](EXCEPTION_POINTERS* info) -> LONG {
    DWORD code = info && info->ExceptionRecord ? info->ExceptionRecord->ExceptionCode : 0;
    // Skip STL/C++ exceptions and known "expected" ones — only care about
    // actual crashes that would otherwise terminate silently.
    if (code == 0xE06D7363u) return EXCEPTION_CONTINUE_SEARCH;  // C++ throw
    if (code < 0x80000000u) return EXCEPTION_CONTINUE_SEARCH;   // status code, not fault
    if (code == EXCEPTION_BREAKPOINT || code == DBG_PRINTEXCEPTION_C ||
        code == DBG_PRINTEXCEPTION_WIDE_C) {
      return EXCEPTION_CONTINUE_SEARCH;
    }
    // First-chance visibility only — do NOT write the dump here or we would
    // save one per WMI-provider stumble. UnhandledExceptionFilter still fires
    // if nothing else catches it.
    append_log_line(std::string("first-chance: ") + seh_name(code));
    return EXCEPTION_CONTINUE_SEARCH;
  });
}

void install_seh_translator() {
  // Thread-local: converts SEH (access violation, stack overflow, …) into a
  // C++ std::runtime_error carrying the mnemonic. Requires /EHa on the whole
  // translation unit — enforced in CMakeLists.txt.
  _set_se_translator([](unsigned int code, EXCEPTION_POINTERS* /*ep*/) {
    char buf[16];
    std::snprintf(buf, sizeof(buf), "0x%08x", code);
    std::string what = std::string("SEH ") + seh_name((DWORD)code) + " (" + buf + ")";
    throw std::runtime_error(what);
  });
}
