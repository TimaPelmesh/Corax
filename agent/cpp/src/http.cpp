#include "http.hpp"
#include "util.hpp"
#include <windows.h>
#include <winhttp.h>
#pragma comment(lib, "winhttp.lib")

namespace {

bool parse_url(const std::string& url, bool& https, std::wstring& host, INTERNET_PORT& port,
               std::wstring& path) {
  std::wstring w = util::widen(url);
  URL_COMPONENTS uc{};
  uc.dwStructSize = sizeof(uc);
  wchar_t hostBuf[256];
  wchar_t pathBuf[2048];
  uc.lpszHostName = hostBuf;
  uc.dwHostNameLength = 256;
  uc.lpszUrlPath = pathBuf;
  uc.dwUrlPathLength = 2048;
  if (!WinHttpCrackUrl(w.c_str(), 0, 0, &uc)) return false;
  https = (uc.nScheme == INTERNET_SCHEME_HTTPS);
  host.assign(uc.lpszHostName, uc.dwHostNameLength);
  port = uc.nPort;
  path.assign(uc.lpszUrlPath, uc.dwUrlPathLength);
  if (path.empty()) path = L"/";
  return true;
}

}  // namespace

HttpResult http_post_json(const std::string& base_url, const std::string& path,
                          const std::string& bearer_token, const std::string& json_body) {
  HttpResult r;
  bool https = false;
  std::wstring host, url_path;
  INTERNET_PORT port = 0;
  if (!parse_url(base_url, https, host, port, url_path)) {
    r.error = "bad server_url (ожидается http://host:port)";
    return r;
  }
  // Append API path
  std::wstring full_path = url_path;
  if (!full_path.empty() && full_path.back() == L'/') full_path.pop_back();
  full_path += util::widen(path);

  HINTERNET session = WinHttpOpen(L"CORAX-Agent/4.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                  WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session) {
    r.error = "WinHttpOpen failed err=" + std::to_string(GetLastError());
    return r;
  }
  WinHttpSetTimeouts(session, 15000, 15000, 60000, 120000);

  HINTERNET connect = WinHttpConnect(session, host.c_str(), port, 0);
  if (!connect) {
    r.error = "WinHttpConnect failed err=" + std::to_string(GetLastError());
    WinHttpCloseHandle(session);
    return r;
  }

  DWORD flags = https ? WINHTTP_FLAG_SECURE : 0;
  HINTERNET request =
      WinHttpOpenRequest(connect, L"POST", full_path.c_str(), nullptr, WINHTTP_NO_REFERER,
                         WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
  if (!request) {
    r.error = "WinHttpOpenRequest failed err=" + std::to_string(GetLastError());
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return r;
  }

  std::wstring headers = L"Content-Type: application/json\r\n";
  if (!bearer_token.empty()) {
    headers += L"Authorization: Bearer ";
    headers += util::widen(bearer_token);
    headers += L"\r\n";
  }

  BOOL ok = WinHttpSendRequest(request, headers.c_str(), (DWORD)headers.size(),
                               (LPVOID)json_body.data(), (DWORD)json_body.size(),
                               (DWORD)json_body.size(), 0);
  if (!ok) {
    r.error = "WinHttpSendRequest failed err=" + std::to_string(GetLastError());
    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return r;
  }
  ok = WinHttpReceiveResponse(request, nullptr);
  if (!ok) {
    r.error = "WinHttpReceiveResponse failed err=" + std::to_string(GetLastError());
    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return r;
  }

  DWORD status = 0, sz = sizeof(status);
  WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                      WINHTTP_HEADER_NAME_BY_INDEX, &status, &sz, WINHTTP_NO_HEADER_INDEX);
  r.status = (int)status;

  std::string body;
  for (;;) {
    DWORD avail = 0;
    if (!WinHttpQueryDataAvailable(request, &avail)) break;
    if (!avail) break;
    std::string chunk(avail, '\0');
    DWORD read = 0;
    if (!WinHttpReadData(request, chunk.data(), avail, &read)) break;
    chunk.resize(read);
    body += chunk;
  }
  r.body = body;
  r.ok = (status >= 200 && status < 300);

  WinHttpCloseHandle(request);
  WinHttpCloseHandle(connect);
  WinHttpCloseHandle(session);
  if (!r.ok && r.error.empty()) r.error = "HTTP " + std::to_string(status);
  return r;
}
