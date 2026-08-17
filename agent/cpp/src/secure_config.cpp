#include "secure_config.hpp"

#include "util.hpp"

#include <windows.h>
#include <wincrypt.h>

#include <algorithm>
#include <regex>
#include <string>
#include <vector>

#pragma comment(lib, "crypt32.lib")

namespace {

constexpr wchar_t kCredentialFile[] = L"agent.cred";
constexpr wchar_t kProvisionFile[] = L"agent.provision.json";
constexpr char kCredentialHeader[] = "CORAX-DPAPI-MACHINE-v1\n";

std::string g_status = "credential not loaded";

std::wstring join_path(const std::string& directory, const wchar_t* filename) {
  std::wstring base = util::widen(directory);
  if (!base.empty() && base.back() != L'\\' && base.back() != L'/') base += L'\\';
  return base + filename;
}

std::string json_string(const std::string& json, const std::string& key) {
  std::regex re("\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
  std::smatch match;
  if (!std::regex_search(json, match, re)) return {};
  return match[1].str();
}

std::vector<unsigned char> entropy_bytes() {
  static const char kEntropy[] = "CORAX Agent portable credential v1";
  return std::vector<unsigned char>(kEntropy, kEntropy + sizeof(kEntropy) - 1);
}

bool protect_machine(const std::string& secret, std::vector<unsigned char>& encrypted) {
  if (secret.empty()) return false;
  DATA_BLOB input{};
  input.pbData = reinterpret_cast<BYTE*>(const_cast<char*>(secret.data()));
  input.cbData = static_cast<DWORD>(secret.size());
  auto entropy = entropy_bytes();
  DATA_BLOB entropy_blob{};
  entropy_blob.pbData = entropy.data();
  entropy_blob.cbData = static_cast<DWORD>(entropy.size());
  DATA_BLOB output{};
  if (!CryptProtectData(&input, L"CORAX Agent token", &entropy_blob, nullptr, nullptr,
                        CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN, &output)) {
    return false;
  }
  encrypted.assign(output.pbData, output.pbData + output.cbData);
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  return true;
}

bool unprotect_machine(const std::vector<unsigned char>& encrypted, std::string& secret) {
  if (encrypted.empty()) return false;
  DATA_BLOB input{};
  input.pbData = const_cast<BYTE*>(encrypted.data());
  input.cbData = static_cast<DWORD>(encrypted.size());
  auto entropy = entropy_bytes();
  DATA_BLOB entropy_blob{};
  entropy_blob.pbData = entropy.data();
  entropy_blob.cbData = static_cast<DWORD>(entropy.size());
  DATA_BLOB output{};
  if (!CryptUnprotectData(&input, nullptr, &entropy_blob, nullptr, nullptr,
                          CRYPTPROTECT_UI_FORBIDDEN, &output)) {
    return false;
  }
  secret.assign(reinterpret_cast<const char*>(output.pbData), output.cbData);
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  return !secret.empty();
}

bool base64_encode(const std::vector<unsigned char>& data, std::string& out) {
  if (data.empty()) return false;
  DWORD chars = 0;
  if (!CryptBinaryToStringA(data.data(), static_cast<DWORD>(data.size()),
                            CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &chars)) {
    return false;
  }
  std::string encoded(chars, '\0');
  if (!CryptBinaryToStringA(data.data(), static_cast<DWORD>(data.size()),
                            CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, encoded.data(), &chars)) {
    return false;
  }
  if (!encoded.empty() && encoded.back() == '\0') encoded.pop_back();
  out = encoded;
  return true;
}

bool base64_decode(const std::string& encoded, std::vector<unsigned char>& out) {
  DWORD bytes = 0;
  if (!CryptStringToBinaryA(encoded.c_str(), static_cast<DWORD>(encoded.size()),
                            CRYPT_STRING_BASE64, nullptr, &bytes, nullptr, nullptr)) {
    return false;
  }
  out.assign(bytes, 0);
  return CryptStringToBinaryA(encoded.c_str(), static_cast<DWORD>(encoded.size()),
                              CRYPT_STRING_BASE64, out.data(), &bytes, nullptr, nullptr) == TRUE;
}

bool read_credential(const std::wstring& path, std::string& secret) {
  std::string raw = util::read_file_utf8(util::narrow(path));
  if (raw.rfind(kCredentialHeader, 0) != 0) return false;
  std::string encoded = util::trim(raw.substr(sizeof(kCredentialHeader) - 1));
  std::vector<unsigned char> encrypted;
  if (!base64_decode(encoded, encrypted)) return false;
  bool ok = unprotect_machine(encrypted, secret);
  if (!encrypted.empty()) SecureZeroMemory(encrypted.data(), encrypted.size());
  return ok;
}

bool write_credential(const std::wstring& path, const std::string& secret) {
  std::vector<unsigned char> encrypted;
  if (!protect_machine(secret, encrypted)) return false;
  std::string encoded;
  bool ok = base64_encode(encrypted, encoded);
  if (!encrypted.empty()) SecureZeroMemory(encrypted.data(), encrypted.size());
  if (!ok) return false;
  ok = util::write_file_utf8(util::narrow(path), std::string(kCredentialHeader) + encoded + "\n");
  if (ok) SetFileAttributesW(path.c_str(), FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED);
  return ok;
}

void best_effort_remove_provision(const std::wstring& path, size_t original_size) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file != INVALID_HANDLE_VALUE) {
    std::vector<unsigned char> zeros(std::max<size_t>(original_size, 1), 0);
    DWORD written = 0;
    SetFilePointer(file, 0, nullptr, FILE_BEGIN);
    WriteFile(file, zeros.data(), static_cast<DWORD>(zeros.size()), &written, nullptr);
    FlushFileBuffers(file);
    CloseHandle(file);
  }
  DeleteFileW(path.c_str());
}

}  // namespace

std::string load_or_provision_agent_token(const std::string& directory) {
  const std::wstring credential_path = join_path(directory, kCredentialFile);
  std::string secret;
  if (read_credential(credential_path, secret)) {
    g_status = "token protected by Windows DPAPI (LocalMachine)";
    return secret;
  }

  const std::wstring provision_path = join_path(directory, kProvisionFile);
  std::string provision = util::read_file_utf8(util::narrow(provision_path));
  if (provision.empty()) {
    g_status = "no DPAPI credential or provisioning file";
    return {};
  }
  secret = json_string(provision, "agent_token");
  if (secret.empty()) secret = json_string(provision, "AGENT_TOKEN");
  if (secret.empty()) {
    g_status = "provisioning file has no token";
    return {};
  }
  if (!write_credential(credential_path, secret)) {
    g_status = "Windows DPAPI could not protect the token";
    SecureZeroMemory(secret.data(), secret.size());
    return {};
  }

  best_effort_remove_provision(provision_path, provision.size());
  if (!provision.empty()) SecureZeroMemory(provision.data(), provision.size());
  g_status = "token provisioned and protected by Windows DPAPI (LocalMachine)";
  return secret;
}

std::string secure_config_status() { return g_status; }
