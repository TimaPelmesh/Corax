#include "osdetect.hpp"
#include "util.hpp"
#include <windows.h>

#ifndef STATUS_SUCCESS
#define STATUS_SUCCESS ((LONG)0x00000000L)
#endif

typedef LONG(WINAPI* RtlGetVersionPtr)(PRTL_OSVERSIONINFOW);

OsInfo detect_os() {
  OsInfo info;
  RTL_OSVERSIONINFOW rovi{};
  rovi.dwOSVersionInfoSize = sizeof(rovi);
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll) {
    auto fn = (RtlGetVersionPtr)GetProcAddress(ntdll, "RtlGetVersion");
    if (fn) fn(&rovi);
  }
  if (!rovi.dwMajorVersion) {
    OSVERSIONINFOEXW vi{};
    vi.dwOSVersionInfoSize = sizeof(vi);
#pragma warning(push)
#pragma warning(disable : 4996)
    GetVersionExW((LPOSVERSIONINFOW)&vi);
#pragma warning(pop)
    rovi.dwMajorVersion = vi.dwMajorVersion;
    rovi.dwMinorVersion = vi.dwMinorVersion;
    rovi.dwBuildNumber = vi.dwBuildNumber;
  }

  info.major = rovi.dwMajorVersion;
  info.minor = rovi.dwMinorVersion;
  info.build = rovi.dwBuildNumber;
  info.version = std::to_string(info.major) + "." + std::to_string(info.minor) + "." +
                 std::to_string(info.build);

  SYSTEM_INFO si{};
  GetNativeSystemInfo(&si);
  switch (si.wProcessorArchitecture) {
    case PROCESSOR_ARCHITECTURE_AMD64: info.arch = "x64"; break;
    case PROCESSOR_ARCHITECTURE_ARM64: info.arch = "arm64"; break;
    default: info.arch = "x86"; break;
  }

  HKEY key = nullptr;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE,
                    L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", 0, KEY_READ,
                    &key) == ERROR_SUCCESS) {
    wchar_t buf[256];
    DWORD typ = 0, cb = sizeof(buf);
    if (RegQueryValueExW(key, L"ProductName", nullptr, &typ, (LPBYTE)buf, &cb) == ERROR_SUCCESS &&
        typ == REG_SZ) {
      info.product_name = util::narrow(buf);
    }
    DWORD install_type_sz = sizeof(buf);
    if (RegQueryValueExW(key, L"InstallationType", nullptr, &typ, (LPBYTE)buf, &install_type_sz) ==
            ERROR_SUCCESS &&
        typ == REG_SZ) {
      auto t = util::to_lower(util::narrow(buf));
      info.is_server = t.find("server") != std::string::npos;
    }
    RegCloseKey(key);
  }

  if (info.is_server || util::to_lower(info.product_name).find("server") != std::string::npos) {
    info.family = "server";
    info.is_server = true;
  } else if (info.major == 6 && info.minor == 1) {
    info.family = "win7";
  } else if (info.major == 6 && (info.minor == 2 || info.minor == 3)) {
    info.family = "win8";
  } else if (info.major >= 10) {
    info.family = (info.build >= 22000) ? "win11" : "win10";
  } else {
    info.family = "unknown";
  }

  // Capability matrix
  info.supports_storage_api = (info.major > 6) || (info.major == 6 && info.minor >= 2);  // Win8+
  info.supports_bitlocker_wmi = info.supports_storage_api;
  info.supports_security_center2 = (info.major >= 6);
  return info;
}
