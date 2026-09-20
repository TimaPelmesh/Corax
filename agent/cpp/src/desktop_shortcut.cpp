#include "desktop_shortcut.hpp"
#include "util.hpp"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shlobj.h>
#include <iphlpapi.h>

#include <cstdio>
#include <string>
#include <vector>

#pragma comment(lib, "iphlpapi.lib")
#pragma comment(lib, "ws2_32.lib")

namespace {

// Основной IPv4 текущей машины (адаптер с default gateway).
std::string primary_ipv4() {
  ULONG size = 0;
  if (GetAdaptersInfo(nullptr, &size) != ERROR_BUFFER_OVERFLOW) return {};
  std::vector<unsigned char> buf(size);
  auto* info = reinterpret_cast<IP_ADAPTER_INFO*>(buf.data());
  if (GetAdaptersInfo(info, &size) != NO_ERROR) return {};
  std::string fallback;
  for (IP_ADAPTER_INFO* a = info; a; a = a->Next) {
    std::string ip = a->IpAddressList.IpAddress.String;
    std::string gw = a->GatewayList.IpAddress.String;
    if (ip.empty() || ip == "0.0.0.0") continue;
    if (!gw.empty() && gw != "0.0.0.0") return ip;  // адаптер с шлюзом = основной
    if (fallback.empty()) fallback = ip;
  }
  return fallback;
}

// Если хост localhost/127.x — подставить реальный IPv4 (агент на сервере -> IP сервера).
std::string resolve_server_base(std::string base) {
  std::string lc = util::to_lower(base);
  size_t sch = lc.find("://");
  if (sch == std::string::npos) return base;
  size_t hs = sch + 3;
  size_t he = base.find_first_of(":/", hs);
  size_t host_len = (he == std::string::npos ? base.size() : he) - hs;
  std::string host = lc.substr(hs, host_len);
  if (host == "localhost" || host == "127.0.0.1" || host == "::1") {
    std::string ip = primary_ipv4();
    if (!ip.empty()) {
      return base.substr(0, hs) + ip + (he == std::string::npos ? std::string() : base.substr(he));
    }
  }
  return base;
}

void remove_old_shortcuts(const std::wstring& dir) {
  const wchar_t* olds[] = {L"Заявка в IT", L"Заявка CORAX", L"CORAX-ticket"};
  const wchar_t* exts[] = {L".lnk", L".url"};
  for (const wchar_t* name : olds) {
    for (const wchar_t* ext : exts) {
      DeleteFileW((dir + L"\\" + name + ext).c_str());
    }
  }
}

bool is_service_account() {
  wchar_t name[256];
  DWORD n = 256;
  if (!GetUserNameW(name, &n) || name[0] == 0) return true;
  std::string u = util::to_lower(util::narrow(name));
  return u == "system" || u == "local service" || u == "network service";
}

std::string percent_encode(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (unsigned char c : s) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' ||
        c == '_' || c == '.' || c == '~') {
      out.push_back(static_cast<char>(c));
    } else {
      char buf[8];
      std::snprintf(buf, sizeof(buf), "%%%02X", c);
      out += buf;
    }
  }
  return out;
}

std::wstring folder_csidl(int csidl) {
  wchar_t buf[MAX_PATH];
  if (FAILED(SHGetFolderPathW(nullptr, csidl, nullptr, SHGFP_TYPE_CURRENT, buf))) return {};
  return buf;
}

std::string exe_path_for_icon() {
  wchar_t exe[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, exe, MAX_PATH);
  if (!n) return {};
  wchar_t shortened[MAX_PATH];
  if (GetShortPathNameW(exe, shortened, MAX_PATH) > 0) return util::narrow(shortened);
  return util::narrow(std::wstring(exe, n));
}

bool write_url(const std::wstring& dir, const std::string& url, const std::string& icon) {
  if (dir.empty()) return false;
  DWORD attr = GetFileAttributesW(dir.c_str());
  if (attr == INVALID_FILE_ATTRIBUTES || !(attr & FILE_ATTRIBUTE_DIRECTORY)) return false;
  remove_old_shortcuts(dir);
  const std::wstring path = dir + L"\\Оставить заявку.url";
  std::string body = "[InternetShortcut]\r\nURL=" + url + "\r\n";
  if (!icon.empty()) {
    body += "IconFile=" + icon + "\r\nIconIndex=0\r\n";
  }
  return util::write_file_utf8(util::narrow(path), body);
}

bool skip_profile_name(const std::wstring& name) {
  std::string u = util::to_lower(util::narrow(name));
  return u.empty() || u == "public" || u == "default" || u == "default user" || u == "all users" ||
         u == "wdagutilityaccount" || u == "defaultapppool" || u[0] == '.';
}

std::wstring users_root() {
  wchar_t pub[MAX_PATH];
  DWORD n = GetEnvironmentVariableW(L"PUBLIC", pub, MAX_PATH);
  if (n && n < MAX_PATH) {
    std::wstring p(pub);
    size_t slash = p.find_last_of(L"\\/");
    if (slash != std::wstring::npos && slash > 0) return p.substr(0, slash);
  }
  return L"C:\\Users";
}

}  // namespace

std::string ensure_helpdesk_shortcut(const std::string& server_url, const std::string& hostname) {
  std::string host = util::trim(hostname);
  std::string base = util::trim(server_url);
  while (!base.empty() && (base.back() == '/' || base.back() == '\\')) base.pop_back();
  if (base.empty() || host.empty() || util::to_lower(host) == "unknown-host") {
    return "shortcut=skipped";
  }
  base = resolve_server_base(base);

  const std::string url = base + "/h#pc=" + percent_encode(host);
  const std::string icon = exe_path_for_icon();
  int ok = 0;

  if (write_url(folder_csidl(CSIDL_COMMON_DESKTOPDIRECTORY), url, icon)) ++ok;

  if (!is_service_account()) {
    if (write_url(folder_csidl(CSIDL_DESKTOPDIRECTORY), url, icon)) ++ok;
  } else {
    const std::wstring root = users_root();
    WIN32_FIND_DATAW fd{};
    HANDLE h = FindFirstFileW((root + L"\\*").c_str(), &fd);
    if (h != INVALID_HANDLE_VALUE) {
      do {
        if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) continue;
        if (fd.cFileName[0] == L'.') continue;
        if (skip_profile_name(fd.cFileName)) continue;
        if (write_url(root + L"\\" + fd.cFileName + L"\\Desktop", url, icon)) ++ok;
      } while (FindNextFileW(h, &fd));
      FindClose(h);
    }
  }

  if (ok <= 0) return "shortcut=failed url=" + url;
  return "shortcut=ok n=" + std::to_string(ok) + " " + url;
}
