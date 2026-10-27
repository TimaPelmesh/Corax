#pragma once
#include <string>

struct OsInfo {
  std::string family;       // win7 | win8 | win10 | win11 | server | unknown
  std::string product_name;
  std::string version;      // major.minor.build
  unsigned major = 0;
  unsigned minor = 0;
  unsigned build = 0;
  bool is_server = false;
  bool supports_storage_api = false;
  bool supports_bitlocker_wmi = false;
  bool supports_security_center2 = false;
  std::string arch;         // x64 | x86 | arm64
};

OsInfo detect_os();
