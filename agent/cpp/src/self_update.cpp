#include "self_update.hpp"

#include "assist_ui.hpp"
#include "config.hpp"
#include "http.hpp"
#include "util.hpp"

#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#pragma comment(lib, "bcrypt.lib")

namespace {

constexpr const char* kBegin = "<<<CORAX_CFG_BEGIN>>>";
constexpr const char* kEnd = "<<<CORAX_CFG_END>>>";
constexpr size_t kBeginLen = 21;
constexpr size_t kEndLen = 19;
constexpr ULONGLONG kBackoffMs = 10ull * 60ull * 1000ull;

void note(const std::string& line) {
  util::append_file_utf8(util::exe_dir() + "\\corax-agent.log", util::iso8601_utc_now() + "  " + line + "\n");
}

std::wstring module_path() {
  wchar_t buf[MAX_PATH * 4];
  DWORD n = GetModuleFileNameW(nullptr, buf, (DWORD)(sizeof(buf) / sizeof(buf[0])));
  if (!n) return L"";
  return std::wstring(buf, n);
}

bool safe_version(const std::string& version) {
  if (version.empty() || version.size() > 32) return false;
  bool digit = false;
  for (char c : version) {
    if (std::isdigit(static_cast<unsigned char>(c))) digit = true;
    else if (c != '.') return false;
  }
  return digit;
}

int version_part(const std::string& version, size_t& i) {
  int value = 0;
  while (i < version.size() && version[i] != '.') {
    if (std::isdigit(static_cast<unsigned char>(version[i]))) value = value * 10 + (version[i] - '0');
    ++i;
  }
  if (i < version.size() && version[i] == '.') ++i;
  return value;
}

bool version_is_newer(const std::string& remote, const std::string& local) {
  if (!safe_version(remote) || !safe_version(local)) return false;
  size_t ri = 0, li = 0;
  for (int part = 0; part < 4; ++part) {
    int rv = version_part(remote, ri);
    int lv = version_part(local, li);
    if (rv != lv) return rv > lv;
  }
  return false;
}

std::string query_escape(const std::string& raw) {
  std::string out;
  for (unsigned char c : raw) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.') out.push_back(static_cast<char>(c));
    else {
      char buf[8];
      sprintf_s(buf, "%%%02X", c);
      out += buf;
    }
  }
  return out;
}

std::string json_string_field(const std::string& body, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  size_t pos = body.find(needle);
  if (pos == std::string::npos) return {};
  pos = body.find(':', pos + needle.size());
  if (pos == std::string::npos) return {};
  pos = body.find('"', pos + 1);
  if (pos == std::string::npos) return {};
  size_t end = body.find('"', pos + 1);
  if (end == std::string::npos) return {};
  return body.substr(pos + 1, end - pos - 1);
}

std::string sha256_hex(const std::string& data) {
  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) return {};
  DWORD hash_len = 0, cb = 0;
  if (BCryptGetProperty(alg, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hash_len), sizeof(hash_len), &cb, 0) != 0 ||
      hash_len == 0 || hash_len > 64) {
    BCryptCloseAlgorithmProvider(alg, 0);
    return {};
  }
  std::vector<UCHAR> out(hash_len);
  if (BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0) != 0) {
    BCryptCloseAlgorithmProvider(alg, 0);
    return {};
  }
  NTSTATUS hashed = BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(data.data())),
                                   static_cast<ULONG>(data.size()), 0);
  NTSTATUS done = hashed == 0 ? BCryptFinishHash(hash, out.data(), hash_len, 0) : hashed;
  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(alg, 0);
  if (done != 0) return {};
  static const char* hex = "0123456789abcdef";
  std::string text;
  text.resize(out.size() * 2);
  for (size_t i = 0; i < out.size(); ++i) {
    text[i * 2] = hex[out[i] >> 4];
    text[i * 2 + 1] = hex[out[i] & 0x0f];
  }
  return text;
}

bool widest_slot(const std::string& image, size_t& payload, size_t& capacity) {
  size_t best = 0;
  bool found = false;
  for (size_t i = 0; i + kBeginLen < image.size(); ++i) {
    if (std::memcmp(image.data() + i, kBegin, kBeginLen) != 0) continue;
    size_t start = i + kBeginLen;
    size_t end = image.find(kEnd, start);
    if (end == std::string::npos) continue;
    size_t cap = end - start;
    if (cap > best) {
      best = cap;
      payload = start;
      capacity = cap;
      found = true;
    }
  }
  return found && capacity >= 64;
}

std::string slot_text(const std::string& image) {
  size_t payload = 0, capacity = 0;
  if (!widest_slot(image, payload, capacity)) return {};
  std::string raw = image.substr(payload, capacity);
  while (!raw.empty() && (raw.back() == '\0' || raw.back() == ' ')) raw.pop_back();
  return util::trim(raw);
}

std::string own_slot_json() {
  return slot_text(std::string(CORAX_CONFIG_SLOT, CORAX_CONFIG_SLOT + kConfigSlotBytes));
}

std::string stamp_version(std::string json, const std::string& version) {
  const std::string value = "\"" + version + "\"";
  const std::string key = "\"agent_version\"";
  if (json.empty()) json = "{}";
  size_t key_at = json.find(key);
  if (key_at == std::string::npos) {
    size_t brace = json.rfind('}');
    if (brace == std::string::npos) return {};
    const char* comma = (brace > 0 && json[brace - 1] != '{') ? "," : "";
    json.insert(brace, std::string(comma) + "\"agent_version\":" + value);
    return json;
  }
  size_t colon = json.find(':', key_at + key.size());
  if (colon == std::string::npos) return {};
  size_t q1 = json.find('"', colon + 1);
  if (q1 == std::string::npos) return {};
  size_t q2 = json.find('"', q1 + 1);
  if (q2 == std::string::npos) return {};
  json.replace(q1, q2 - q1 + 1, value);
  return json;
}

bool transplant(std::string& image, const std::string& json) {
  size_t payload = 0, capacity = 0;
  if (!widest_slot(image, payload, capacity)) return false;
  if (json.size() > capacity) return false;
  std::string padded(capacity, '\0');
  memcpy(padded.data(), json.data(), json.size());
  memcpy(image.data() + payload, padded.data(), capacity);
  return true;
}

std::string read_file_binary(const std::wstring& path) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return {};
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file, &size) || size.QuadPart <= 0 || size.QuadPart > 40ll * 1024ll * 1024ll) {
    CloseHandle(file);
    return {};
  }
  std::string data(static_cast<size_t>(size.QuadPart), '\0');
  size_t got = 0;
  while (got < data.size()) {
    DWORD chunk = 0;
    DWORD ask = static_cast<DWORD>(std::min<size_t>(data.size() - got, 1 << 20));
    if (!ReadFile(file, data.data() + got, ask, &chunk, nullptr) || chunk == 0) break;
    got += chunk;
  }
  CloseHandle(file);
  data.resize(got);
  return data;
}

bool write_file_binary(const std::wstring& path, const std::string& data) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  size_t put = 0;
  while (put < data.size()) {
    DWORD chunk = 0;
    DWORD ask = static_cast<DWORD>(std::min<size_t>(data.size() - put, 1 << 20));
    if (!WriteFile(file, data.data() + put, ask, &chunk, nullptr) || chunk == 0) {
      CloseHandle(file);
      return false;
    }
    put += chunk;
  }
  CloseHandle(file);
  return true;
}

std::wstring backoff_path() { return module_path() + L".update"; }

bool in_backoff() {
  WIN32_FILE_ATTRIBUTE_DATA info{};
  if (!GetFileAttributesExW(backoff_path().c_str(), GetFileExInfoStandard, &info)) return false;
  FILETIME now{};
  GetSystemTimeAsFileTime(&now);
  ULARGE_INTEGER n, m;
  n.LowPart = now.dwLowDateTime;
  n.HighPart = now.dwHighDateTime;
  m.LowPart = info.ftLastWriteTime.dwLowDateTime;
  m.HighPart = info.ftLastWriteTime.dwHighDateTime;
  if (n.QuadPart < m.QuadPart) return false;
  return (n.QuadPart - m.QuadPart) / 10000ull < kBackoffMs;
}

void touch_backoff() {
  HANDLE file = CreateFileW(backoff_path().c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL,
                            nullptr);
  if (file == INVALID_HANDLE_VALUE) return;
  CloseHandle(file);
}

void clear_backoff() { DeleteFileW(backoff_path().c_str()); }

void cleanup_old() {
  std::wstring self = module_path();
  if (!self.empty()) DeleteFileW((self + L".old").c_str());
}

bool replace_exe(const std::wstring& self, const std::string& image) {
  std::wstring neu = self + L".new";
  std::wstring old = self + L".old";
  if (!write_file_binary(neu, image)) return false;
  DeleteFileW(old.c_str());
  if (!MoveFileExW(self.c_str(), old.c_str(), MOVEFILE_REPLACE_EXISTING)) {
    DeleteFileW(neu.c_str());
    return false;
  }
  if (!MoveFileExW(neu.c_str(), self.c_str(), MOVEFILE_REPLACE_EXISTING)) {
    MoveFileExW(old.c_str(), self.c_str(), MOVEFILE_REPLACE_EXISTING);
    DeleteFileW(neu.c_str());
    return false;
  }
  return true;
}

void relaunch_tray(const std::wstring& self) {
  size_t slash = self.find_last_of(L"\\/");
  std::wstring dir = slash == std::wstring::npos ? L"." : self.substr(0, slash);
  std::wstring cmd = L"\"" + self + L"\" --tray";
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION pi{};
  if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, DETACHED_PROCESS | CREATE_NO_WINDOW, nullptr,
                      dir.c_str(), &si, &pi)) {
    note("update: restart failed");
    return;
  }
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  ExitProcess(0);
}

std::string disk_version(const std::wstring& self) {
  std::string image = read_file_binary(self);
  if (image.size() < 64 || image.compare(0, 2, "MZ") != 0) return {};
  return json_string_field(slot_text(image), "agent_version");
}

}  // namespace

bool file_replaced_since_start(const std::wstring& path) {
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) return false;
  WIN32_FILE_ATTRIBUTE_DATA info{};
  if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &info)) return false;
  return CompareFileTime(&info.ftLastWriteTime, &created) > 0;
}

void maybe_self_update(const AgentConfig& cfg, const std::string& directive_body, bool relaunch_tray_flag) {
  if (assist_ui_visible()) return;
  cleanup_old();
  std::wstring self = module_path();
  if (self.empty() || cfg.server_url.empty() || cfg.agent_token.empty()) return;

  const std::string remote = json_string_field(directive_body, "release_version");
  const std::string sha = util::to_lower(json_string_field(directive_body, "release_sha256"));
  if (!version_is_newer(remote, cfg.agent_version)) return;
  if (relaunch_tray_flag && file_replaced_since_start(self)) {
    const std::string on_disk = disk_version(self);
    if (version_is_newer(on_disk, cfg.agent_version)) {
      note("update: restarting into " + on_disk);
      relaunch_tray(self);
      return;
    }
  }
  if (sha.size() != 64 || in_backoff()) return;
  touch_backoff();

  HttpResult file = http_get(cfg.server_url,
                             "/api/v1/agent/release?hostname=" + query_escape(util::computer_hostname()),
                             cfg.agent_token);
  if (!file.ok || file.body.size() < 50000 || file.body.size() > 40ull * 1024ull * 1024ull ||
      file.body.compare(0, 2, "MZ") != 0) {
    note("update: download failed");
    return;
  }
  if (sha256_hex(file.body) != sha) {
    note("update: hash mismatch");
    return;
  }
  std::string json = stamp_version(own_slot_json(), remote);
  if (json.empty() || !transplant(file.body, json)) {
    note("update: config slot rejected");
    return;
  }
  if (!replace_exe(self, file.body)) {
    note("update: cannot replace exe");
    return;
  }
  clear_backoff();
  note("update: installed " + remote);
  if (relaunch_tray_flag) relaunch_tray(self);
}
