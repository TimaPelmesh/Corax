#include "pair_lan.hpp"
#include "util.hpp"

#include <winsock2.h>
#include <windows.h>
#include <winhttp.h>
#include <iphlpapi.h>
#include <wincrypt.h>

#include <cstdio>
#include <string>
#include <vector>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "iphlpapi.lib")
#pragma comment(lib, "ws2_32.lib")

namespace {

std::string hex_id() {
  unsigned char bytes[16]{};
  HCRYPTPROV prov = 0;
  if (!CryptAcquireContextW(&prov, nullptr, nullptr, PROV_RSA_FULL, CRYPT_VERIFYCONTEXT)) return "";
  BOOL ok = CryptGenRandom(prov, sizeof(bytes), bytes);
  CryptReleaseContext(prov, 0);
  if (!ok) return "";
  static const char* kHex = "0123456789abcdef";
  std::string out;
  out.resize(32);
  for (int i = 0; i < 16; ++i) {
    out[i * 2] = kHex[bytes[i] >> 4];
    out[i * 2 + 1] = kHex[bytes[i] & 0x0f];
  }
  return out;
}

std::string json_escape(const std::string& value) {
  std::string out;
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') out.push_back('\\');
    if (c >= 32) out.push_back(static_cast<char>(c));
  }
  return out;
}

std::string http_exchange(const std::wstring& method, const std::string& url, const std::string& body,
                          int timeout_ms) {
  std::wstring wurl = util::widen(url);
  URL_COMPONENTS uc{};
  uc.dwStructSize = sizeof(uc);
  wchar_t host[256]{};
  wchar_t path[1024]{};
  uc.lpszHostName = host;
  uc.dwHostNameLength = 256;
  uc.lpszUrlPath = path;
  uc.dwUrlPathLength = 1024;
  if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &uc)) return "";
  HINTERNET session = WinHttpOpen(L"CORAX-Setup", WINHTTP_ACCESS_TYPE_NO_PROXY, nullptr, nullptr, 0);
  if (!session) return "";
  WinHttpSetTimeouts(session, timeout_ms, timeout_ms, timeout_ms, timeout_ms);
  HINTERNET connect = WinHttpConnect(session, host, uc.nPort, 0);
  if (!connect) {
    WinHttpCloseHandle(session);
    return "";
  }
  const DWORD secure = uc.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0;
  HINTERNET request = WinHttpOpenRequest(connect, method.c_str(), path, nullptr, WINHTTP_NO_REFERER,
                                         WINHTTP_DEFAULT_ACCEPT_TYPES, secure);
  if (!request) {
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return "";
  }
  const wchar_t* headers = body.empty() ? L"" : L"Content-Type: application/json\r\n";
  BOOL sent = WinHttpSendRequest(request, headers, (DWORD)-1L,
                                 body.empty() ? WINHTTP_NO_REQUEST_DATA : (LPVOID)body.data(),
                                 (DWORD)body.size(), (DWORD)body.size(), 0);
  std::string response;
  if (sent && WinHttpReceiveResponse(request, nullptr)) {
    DWORD available = 0;
    do {
      if (!WinHttpQueryDataAvailable(request, &available) || available == 0) break;
      std::string chunk(available, '\0');
      DWORD read = 0;
      if (!WinHttpReadData(request, chunk.data(), available, &read)) break;
      response.append(chunk.data(), read);
    } while (available > 0);
  }
  WinHttpCloseHandle(request);
  WinHttpCloseHandle(connect);
  WinHttpCloseHandle(session);
  return response;
}

std::vector<std::string> local_ipv4() {
  std::vector<std::string> ips;
  ULONG size = 16 * 1024;
  std::vector<unsigned char> buf(size);
  if (GetAdaptersAddresses(AF_INET, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER,
                           nullptr, reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buf.data()), &size) != NO_ERROR) {
    return ips;
  }
  for (auto* adapter = reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buf.data()); adapter; adapter = adapter->Next) {
    if (adapter->OperStatus != IfOperStatusUp) continue;
    for (auto* unicast = adapter->FirstUnicastAddress; unicast; unicast = unicast->Next) {
      auto* sa = reinterpret_cast<sockaddr_in*>(unicast->Address.lpSockaddr);
      if (!sa || sa->sin_family != AF_INET) continue;
      unsigned long addr = ntohl(sa->sin_addr.S_un.S_addr);
      unsigned a = (addr >> 24) & 255;
      unsigned b = (addr >> 16) & 255;
      if (a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && b >= 16 && b <= 31)) {
        char text[32];
        sprintf_s(text, "%u.%u.%u.%u", a, b, (addr >> 8) & 255, addr & 255);
        ips.emplace_back(text);
      }
    }
  }
  return ips;
}

std::string find_server(const std::function<void(const std::string&)>& status) {
  status("Ищем сервер CORAX в локальной сети…");
  for (const std::string& ip : local_ipv4()) {
    int last_dot = (int)ip.find_last_of('.');
    if (last_dot < 0) continue;
    std::string prefix = ip.substr(0, last_dot + 1);
    for (int host = 1; host < 255; ++host) {
      if (host % 32 == 1) status("Ищем сервер CORAX в локальной сети…");
      std::string candidate = prefix + std::to_string(host);
      if (candidate == ip) continue;
      std::string body = http_exchange(L"GET", "http://" + candidate + ":3000/api/v1/agent/discover", "", 250);
      if (body.find("corax") != std::string::npos) return "http://" + candidate + ":3000";
    }
  }
  return "";
}

std::string trim_server(std::string server) {
  while (!server.empty() && (server.back() == '/' || server.back() == '\\')) server.pop_back();
  return server;
}

bool write_pair_files(const std::string& server, const std::string& token) {
  std::string dir = util::exe_dir();
  std::string existing = util::read_file_utf8(dir + "\\agent.json");
  bool wrote_config = true;
  if (existing.find("\"server_url\"") == std::string::npos) {
    std::string agent_json = "{\n  \"server_url\": \"" + json_escape(server) + "\"\n}\n";
    wrote_config = util::write_file_utf8(dir + "\\agent.json", agent_json);
  }
  std::string provision = "{\n  \"agent_token\": \"" + json_escape(token) + "\"\n}\n";
  return wrote_config && util::write_file_utf8(dir + "\\agent.provision.json", provision);
}

std::string extract_json_string(const std::string& body, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  size_t pos = body.find(needle);
  if (pos == std::string::npos) return "";
  pos = body.find('"', pos + needle.size());
  if (pos == std::string::npos) return "";
  size_t end = body.find('"', pos + 1);
  if (end == std::string::npos) return "";
  return body.substr(pos + 1, end - pos - 1);
}

std::string extract_token(const std::string& body) { return extract_json_string(body, "agent_token"); }

std::string machine_public_id() {
  // MachineGuid is unique per Windows install, so a shared installer file
  // does not reuse the first computer's pairing.
  HKEY key = nullptr;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Cryptography", 0,
                    KEY_READ | KEY_WOW64_64KEY, &key) != ERROR_SUCCESS) {
    return "";
  }
  wchar_t buf[128]{};
  DWORD size = sizeof(buf);
  DWORD type = 0;
  const LONG rc = RegQueryValueExW(key, L"MachineGuid", nullptr, &type, reinterpret_cast<LPBYTE>(buf), &size);
  RegCloseKey(key);
  if (rc != ERROR_SUCCESS || type != REG_SZ) return "";
  std::string out;
  for (wchar_t ch : std::wstring(buf)) {
    if (ch >= L'0' && ch <= L'9') out.push_back(static_cast<char>(ch));
    else if (ch >= L'a' && ch <= L'f') out.push_back(static_cast<char>(ch));
    else if (ch >= L'A' && ch <= L'F') out.push_back(static_cast<char>(ch - L'A' + L'a'));
  }
  return out.size() >= 16 ? out : "";
}

std::string program_data_pair_path() {
  const wchar_t* env = _wgetenv(L"ProgramData");
  std::wstring root = (env && *env) ? std::wstring(env) : L"C:\\ProgramData";
  std::wstring dir = root + L"\\CORAX\\Agent";
  CreateDirectoryW((root + L"\\CORAX").c_str(), nullptr);
  CreateDirectoryW(dir.c_str(), nullptr);
  return util::narrow(dir) + "\\agent.pair.json";
}

std::string read_public_id_file(const std::string& path) {
  std::string existing = util::read_file_utf8(path);
  const std::string key = "\"public_id\"";
  size_t pos = existing.find(key);
  if (pos == std::string::npos) return "";
  pos = existing.find('"', pos + key.size());
  size_t end = pos == std::string::npos ? std::string::npos : existing.find('"', pos + 1);
  if (pos == std::string::npos || end == std::string::npos || end - pos - 1 < 16) return "";
  return existing.substr(pos + 1, end - pos - 1);
}

std::string load_or_create_public_id() {
  std::string from_machine = machine_public_id();
  if (!from_machine.empty()) return from_machine;
  const std::string path = program_data_pair_path();
  std::string existing = read_public_id_file(path);
  if (!existing.empty()) return existing;
  std::string created = hex_id();
  if (created.empty()) return "";
  util::write_file_utf8(path, "{\"public_id\":\"" + created + "\"}\n");
  return created;
}

}  // namespace

EnrollResult enroll_on_lan(
    const std::function<void(const std::string&)>& status,
    const std::string& known_server,
    int wait_ms) {
  std::string server = trim_server(known_server);
  if (!server.empty()) {
    status("Сервер инвентаризации: " + server);
  } else {
    server = find_server(status);
  }
  if (server.empty()) {
    status("Сервер CORAX в этой сети не найден.");
    return EnrollResult::Failed;
  }
  std::string public_id = load_or_create_public_id();
  if (public_id.empty()) return EnrollResult::Failed;
  std::string hostname = util::computer_hostname();
  std::string announce = "{\"public_id\":\"" + public_id + "\",\"hostname\":\"" + json_escape(hostname) + "\"}";
  std::string claim_body = "{\"public_id\":\"" + public_id + "\"}";
  const ULONGLONG deadline = GetTickCount64() + (wait_ms > 0 ? (ULONGLONG)wait_ms : 0);
  for (;;) {
    status("Ждём одобрения в панели CORAX…");
    std::string announced = http_exchange(L"POST", server + "/api/v1/agent/pair/announce", announce, 8000);
    std::string token = extract_token(announced);
    std::string st = extract_json_string(announced, "status");
    if (token.empty()) {
      std::string claimed = http_exchange(L"POST", server + "/api/v1/agent/pair/claim", claim_body, 4000);
      token = extract_token(claimed);
      if (st.empty()) st = extract_json_string(claimed, "status");
    }
    if (st == "rejected") {
      status("Подключение отклонено в панели CORAX.");
      return EnrollResult::Failed;
    }
    if (!token.empty()) {
      if (!write_pair_files(server, token)) {
        status("Токен получен, но не удалось записать его рядом с агентом.");
        return EnrollResult::Failed;
      }
      http_exchange(L"POST", server + "/api/v1/agent/pair/claim", claim_body, 4000);
      status("Сервер одобрил этот компьютер.");
      return EnrollResult::Enrolled;
    }
    if (wait_ms <= 0 || GetTickCount64() >= deadline) {
      if (announced.empty() && st.empty()) {
        status("Сервер CORAX не ответил.");
        return EnrollResult::Failed;
      }
      return EnrollResult::Pending;
    }
    const ULONGLONG next = GetTickCount64() + 2000;
    while (GetTickCount64() < next && GetTickCount64() < deadline) {
      status("Ждём одобрения в панели CORAX…");
      Sleep(200);
    }
  }
}
