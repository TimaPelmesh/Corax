#pragma once
#include "config.hpp"
#include "json_writer.hpp"
#include "osdetect.hpp"
#include "wmi.hpp"

#include <string>
#include <vector>

struct ModStat {
  std::string name;
  std::string status;
  std::string detail;
};

// Appends high/medium value fields into extended JSON (gpus, secure_boot, pending_reboot,
// local_admins, mapped_drives, battery health, usb_history, listening_ports, runtimes, …).
void collect_extended_extras(JsonWriter& j, WmiSession& wmi, const AgentConfig& cfg, const OsInfo& os,
                             std::vector<ModStat>& mods);
