#include "util.hpp"
#include <windows.h>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <fstream>
#include <regex>
#include <sstream>

namespace util {

std::string narrow(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  if (n <= 0) return {};
  std::string out(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), out.data(), n, nullptr, nullptr);
  return out;
}

std::wstring widen(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  if (n <= 0) return {};
  std::wstring out(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), out.data(), n);
  return out;
}

std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && (unsigned char)s[a] <= ' ') ++a;
  while (b > a && (unsigned char)s[b - 1] <= ' ') --b;
  return s.substr(a, b - a);
}

std::string to_lower(const std::string& s) {
  std::string o = s;
  for (char& c : o) c = (char)std::tolower((unsigned char)c);
  return o;
}

bool looks_placeholder(const std::string& s) {
  static const std::regex re(
      "^(system product name|system manufacturer|system model|system version|system sku|"
      "default string|to be filled by o\\.e\\.m\\.|to be filled|system serial number|"
      "not specified|oem|o\\.e\\.m\\.|invalid|all series|type1family0|bad string|undefined|"
      "not available|n/?a|product name|not applicable)$",
      std::regex::icase);
  return std::regex_match(trim(s), re);
}

std::string clean_wmi(const std::string& s, size_t max_len) {
  std::string t = trim(s);
  t.erase(std::remove(t.begin(), t.end(), '\0'), t.end());
  if (t.empty() || looks_placeholder(t)) return {};
  if (t.size() > max_len) t.resize(max_len);
  return t;
}

std::string exe_dir() {
  wchar_t buf[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH);
  if (!n) return ".";
  std::wstring path(buf, n);
  size_t pos = path.find_last_of(L"\\/");
  if (pos == std::wstring::npos) return ".";
  return narrow(path.substr(0, pos));
}

std::string read_file_utf8(const std::string& path) {
  // Windows: narrow UTF-8 paths break on Cyrillic folders — use wchar_t.
  std::ifstream f(widen(path), std::ios::binary);
  if (!f) return {};
  std::ostringstream ss;
  ss << f.rdbuf();
  std::string s = ss.str();
  if (s.size() >= 3 && (unsigned char)s[0] == 0xEF && (unsigned char)s[1] == 0xBB &&
      (unsigned char)s[2] == 0xBF) {
    s.erase(0, 3);
  }
  return s;
}

bool write_file_utf8(const std::string& path, const std::string& data) {
  std::ofstream f(widen(path), std::ios::binary);
  if (!f) return false;
  f.write(data.data(), (std::streamsize)data.size());
  return (bool)f;
}

bool append_file_utf8(const std::string& path, const std::string& data) {
  std::ofstream f(widen(path), std::ios::binary | std::ios::app);
  if (!f) return false;
  f.write(data.data(), (std::streamsize)data.size());
  return (bool)f;
}

std::string iso8601_utc_now() {
  using namespace std::chrono;
  auto now = system_clock::now();
  std::time_t t = system_clock::to_time_t(now);
  std::tm tm{};
  gmtime_s(&tm, &t);
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ", tm.tm_year + 1900,
                tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec);
  return buf;
}

std::string getenv_utf8(const char* name) {
  wchar_t* w = nullptr;
  size_t len = 0;
  if (_wdupenv_s(&w, &len, widen(name).c_str()) != 0 || !w) return {};
  std::string out = narrow(w);
  free(w);
  return out;
}

bool is_elevated() {
  BOOL elev = FALSE;
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  TOKEN_ELEVATION te{};
  DWORD sz = 0;
  if (GetTokenInformation(token, TokenElevation, &te, sizeof(te), &sz)) {
    elev = te.TokenIsElevated;
  }
  CloseHandle(token);
  return elev == TRUE;
}

}  // namespace util
