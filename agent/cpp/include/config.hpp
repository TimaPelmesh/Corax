#pragma once
#include <string>

inline constexpr size_t kConfigSlotBytes = 8192;

// Filled in config.cpp; panel patches this region inside the EXE on download.
extern "C" char CORAX_CONFIG_SLOT[kConfigSlotBytes];

struct AgentModules {
  bool patches = true;
  bool network = true;
  bool domain_sessions = true;
  bool bitlocker = true;
  bool tpm_secureboot = true;
  bool antivirus = true;
  bool startup = true;
  bool services = true;
  bool storage_health = true;
  bool battery = true;
  bool windows_features = false;
  bool office = true;
  bool usb_history = true;
  bool docker_wsl = true;
};

struct AgentConfig {
  std::string server_url;
  std::string agent_token;
  std::string agent_version = "4.1.1";
  std::string profile = "full";
  AgentModules modules;
  int software_max = 12000;
  int services_max = 400;
  int patches_max = 500;
  bool silent = false;  // false = show console progress on double-click; use --silent for Task Scheduler
};

AgentConfig load_agent_config();
std::string modules_enabled_csv(const AgentModules& m);
