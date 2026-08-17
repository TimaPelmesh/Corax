#pragma once
#include <string>
#include <optional>

namespace util {

std::string narrow(const std::wstring& w);
std::wstring widen(const std::string& s);
std::string trim(const std::string& s);
std::string to_lower(const std::string& s);
bool looks_placeholder(const std::string& s);
std::string clean_wmi(const std::string& s, size_t max_len = 256);
std::string exe_dir();
std::string read_file_utf8(const std::string& path);
bool write_file_utf8(const std::string& path, const std::string& data);
bool append_file_utf8(const std::string& path, const std::string& data);
std::string iso8601_utc_now();
std::string getenv_utf8(const char* name);
bool is_elevated();

}  // namespace util
