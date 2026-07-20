#include "config.hpp"
#include "util.hpp"
#include <cstring>
#include <regex>

// Static image: BEGIN + ~7.6KB pad + END — panel injects JSON between markers.
extern "C" char CORAX_CONFIG_SLOT[kConfigSlotBytes] =
    "<<<CORAX_CFG_BEGIN>>>"
    "{}"
#include "config_slot_seed.inc"
    "<<<CORAX_CFG_END>>>";

namespace {

const char* find_bytes(const char* hay, size_t hay_n, const char* needle) {
  size_t n = std::strlen(needle);
  if (n == 0 || n > hay_n) return nullptr;
  for (size_t i = 0; i + n <= hay_n; ++i) {
    if (std::memcmp(hay + i, needle, n) == 0) return hay + i;
  }
  return nullptr;
}

bool json_bool(const std::string& json, const std::string& key, bool def) {
  std::regex re("\"" + key + "\"\\s*:\\s*(true|false)", std::regex::icase);
  std::smatch m;
  if (!std::regex_search(json, m, re)) return def;
  return util::to_lower(m[1].str()) == "true";
}

std::string json_string(const std::string& json, const std::string& key) {
  std::regex re("\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
  std::smatch m;
  if (!std::regex_search(json, m, re)) return {};
  return m[1].str();
}

int json_int(const std::string& json, const std::string& key, int def) {
  std::regex re("\"" + key + "\"\\s*:\\s*(-?[0-9]+)");
  std::smatch m;
  if (!std::regex_search(json, m, re)) return def;
  try {
    return std::stoi(m[1].str());
  } catch (...) {
    return def;
  }
}

std::string extract_object(const std::string& json, const std::string& key) {
  std::string needle = "\"" + key + "\"";
  size_t p = json.find(needle);
  if (p == std::string::npos) return {};
  p = json.find('{', p);
  if (p == std::string::npos) return {};
  int depth = 0;
  for (size_t i = p; i < json.size(); ++i) {
    if (json[i] == '{') ++depth;
    else if (json[i] == '}') {
      --depth;
      if (depth == 0) return json.substr(p, i - p + 1);
    }
  }
  return {};
}

void apply_modules(AgentModules& m, const std::string& mods) {
  if (mods.empty()) return;
  m.patches = json_bool(mods, "patches", m.patches);
  m.network = json_bool(mods, "network", m.network);
  m.domain_sessions = json_bool(mods, "domain_sessions", m.domain_sessions);
  m.bitlocker = json_bool(mods, "bitlocker", m.bitlocker);
  m.tpm_secureboot = json_bool(mods, "tpm_secureboot", m.tpm_secureboot);
  m.antivirus = json_bool(mods, "antivirus", m.antivirus);
  m.startup = json_bool(mods, "startup", m.startup);
  m.services = json_bool(mods, "services", m.services);
  m.storage_health = json_bool(mods, "storage_health", m.storage_health);
  m.battery = json_bool(mods, "battery", m.battery);
  m.windows_features = json_bool(mods, "windows_features", m.windows_features);
  m.office = json_bool(mods, "office", m.office);
  m.usb_history = json_bool(mods, "usb_history", m.usb_history);
  m.docker_wsl = json_bool(mods, "docker_wsl", m.docker_wsl);
}

void apply_json(AgentConfig& cfg, const std::string& json) {
  if (json.empty()) return;
  auto s = json_string(json, "server_url");
  if (!s.empty()) cfg.server_url = s;
  s = json_string(json, "agent_token");
  if (!s.empty()) cfg.agent_token = s;
  s = json_string(json, "INVENTORY_SERVER");
  if (!s.empty()) cfg.server_url = s;
  s = json_string(json, "AGENT_TOKEN");
  if (!s.empty()) cfg.agent_token = s;
  s = json_string(json, "agent_version");
  if (!s.empty()) cfg.agent_version = s;
  s = json_string(json, "profile");
  if (!s.empty()) cfg.profile = s;
  cfg.silent = json_bool(json, "silent", cfg.silent);
  cfg.software_max = json_int(json, "software_max", cfg.software_max);

  auto limits = extract_object(json, "limits");
  if (!limits.empty()) {
    cfg.software_max = json_int(limits, "software_max", cfg.software_max);
    cfg.services_max = json_int(limits, "services_max", cfg.services_max);
    cfg.patches_max = json_int(limits, "patches_max", cfg.patches_max);
  }
  apply_modules(cfg.modules, extract_object(json, "modules"));
}

std::string slot_json() {
  // Marker strings also exist as short C-literals in the PE; pick the widest span.
  const char* best_b = nullptr;
  const char* best_e = nullptr;
  size_t best_cap = 0;
  for (size_t i = 0; i + 21 < kConfigSlotBytes; ++i) {
    if (std::memcmp(CORAX_CONFIG_SLOT + i, "<<<CORAX_CFG_BEGIN>>>", 21) != 0) continue;
    const char* b = CORAX_CONFIG_SLOT + i;
    const char* e = find_bytes(b + 21, kConfigSlotBytes - (i + 21), "<<<CORAX_CFG_END>>>");
    if (!e) continue;
    size_t cap = (size_t)(e - (b + 21));
    if (cap > best_cap) {
      best_cap = cap;
      best_b = b;
      best_e = e;
    }
  }
  if (!best_b || !best_e || best_cap < 8) return {};
  const char* begin = best_b + 21;
  std::string raw(begin, best_e);
  while (!raw.empty() && (raw.back() == '\0' || raw.back() == ' ')) raw.pop_back();
  return util::trim(raw);
}

}  // namespace

AgentConfig load_agent_config() {
  AgentConfig cfg;

  // Weak defaults: sidecar files, then env — only fill empty fields.
  std::string side = util::read_file_utf8(util::exe_dir() + "\\agent.json");
  if (side.empty()) side = util::read_file_utf8(util::exe_dir() + "\\agent_config.json");
  apply_json(cfg, side);

  auto env_server = util::getenv_utf8("INVENTORY_SERVER");
  auto env_token = util::getenv_utf8("AGENT_TOKEN");
  if (cfg.server_url.empty() && !env_server.empty()) cfg.server_url = env_server;
  if (cfg.agent_token.empty() && !env_token.empty()) cfg.agent_token = env_token;

  // Stamped PE slot always wins (panel-built EXE).
  auto slot = slot_json();
  if (!slot.empty() && slot != "{}") apply_json(cfg, slot);

  while (!cfg.server_url.empty() && (cfg.server_url.back() == '/' || cfg.server_url.back() == '\\')) {
    cfg.server_url.pop_back();
  }
  return cfg;
}

std::string modules_enabled_csv(const AgentModules& m) {
  std::string out;
  auto add = [&](const char* name, bool on) {
    if (!on) return;
    if (!out.empty()) out += ',';
    out += name;
  };
  add("patches", m.patches);
  add("network", m.network);
  add("domain_sessions", m.domain_sessions);
  add("bitlocker", m.bitlocker);
  add("tpm_secureboot", m.tpm_secureboot);
  add("antivirus", m.antivirus);
  add("startup", m.startup);
  add("services", m.services);
  add("storage_health", m.storage_health);
  add("battery", m.battery);
  add("windows_features", m.windows_features);
  add("office", m.office);
  add("usb_history", m.usb_history);
  add("docker_wsl", m.docker_wsl);
  return out;
}
