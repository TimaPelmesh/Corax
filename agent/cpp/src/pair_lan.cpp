#include "pair_lan.hpp"
#include "util.hpp"

#include <windows.h>
#include <winhttp.h>
#include <iphlpapi.h>
#include <wincrypt.h>

#include <cstdio>
#include <string>
#include <vector>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "iphlpapi.lib")

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
  HINTERNET request = WinHttpOpenRequest(connect, method.c_str(), path, nullptr, WINHTTP_NO_REFERER,
                                         WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
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

bool write_pair_files(const std::string& server, const std::string& token) {
  std::string dir = util::exe_dir();
  std::string agent_json = "{\n  \"server_url\": \"" + json_escape(server) + "\"\n}\n";
  std::string provision = "{\n  \"agent_token\": \"" + json_escape(token) + "\"\n}\n";
  return util::write_file_utf8(dir + "\\agent.json", agent_json) &&
         util::write_file_utf8(dir + "\\agent.provision.json", provision);
}

std::string extract_token(const std::string& body) {
  const std::string key = "\"agent_token\"";
  size_t pos = body.find(key);
  if (pos == std::string::npos) return "";
  pos = body.find('"', pos + key.size());
  if (pos == std::string::npos) return "";
  size_t end = body.find('"', pos + 1);
  if (end == std::string::npos) return "";
  return body.substr(pos + 1, end - pos - 1);
}

}  // namespace

bool enroll_on_lan(const std::function<void(const std::string&)>& status) {
  std::string server = find_server(status);
  if (server.empty()) {
    status("Сервер CORAX в этой сети не найден.");
    return false;
  }
  std::string public_id = hex_id();
  if (public_id.empty()) return false;
  std::string hostname = util::computer_hostname();
  std::string announce = "{\"public_id\":\"" + public_id + "\",\"hostname\":\"" + json_escape(hostname) + "\"}";
  http_exchange(L"POST", server + "/api/v1/agent/pair/announce", announce, 4000);
  status("Компьютер " + hostname + " ждёт подключения в панели CORAX.");
  for (int i = 0; i < 300; ++i) {
    status("Компьютер " + hostname + " ждёт подключения в панели CORAX.");
    Sleep(2000);
    std::string claim_body = "{\"public_id\":\"" + public_id + "\"}";
    std::string response = http_exchange(L"POST", server + "/api/v1/agent/pair/claim", claim_body, 4000);
    std::string token = extract_token(response);
    if (!token.empty()) return write_pair_files(server, token);
  }
  status("В панели не подтвердили подключение.");
  return false;
}
