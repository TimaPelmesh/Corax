#include "poll.hpp"

#include "collect.hpp"
#include "http.hpp"
#include "install.hpp"
#include "osdetect.hpp"
#include "util.hpp"

#include <windows.h>

#include <algorithm>
#include <string>

namespace {

std::string query_escape(const std::string& raw) {
  std::string out;
  for (unsigned char c : raw) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
        c == '.') {
      out.push_back(static_cast<char>(c));
    } else {
      char buf[8];
      sprintf_s(buf, "%%%02X", c);
      out += buf;
    }
  }
  return out;
}

int json_int_field(const std::string& body, const std::string& key, int fallback) {
  const std::string needle = "\"" + key + "\"";
  size_t pos = body.find(needle);
  if (pos == std::string::npos) return fallback;
  pos = body.find(':', pos + needle.size());
  if (pos == std::string::npos) return fallback;
  ++pos;
  while (pos < body.size() && (body[pos] == ' ' || body[pos] == '\t')) ++pos;
  try {
    return std::stoi(body.substr(pos));
  } catch (...) {
    return fallback;
  }
}

bool json_bool_field(const std::string& body, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  size_t pos = body.find(needle);
  if (pos == std::string::npos) return false;
  pos = body.find(':', pos + needle.size());
  if (pos == std::string::npos) return false;
  const size_t tru = body.find("true", pos);
  return tru != std::string::npos && tru < pos + 8;
}

}  // namespace

int poll_and_maybe_collect(const AgentConfig& cfg) {
  SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
  const std::string hostname = util::computer_hostname();
  const int seen = read_seen_generation(util::exe_dir());
  const std::string path = "/api/v1/agent/directive?hostname=" + query_escape(hostname) +
                           "&seen_generation=" + std::to_string(seen);
  HttpResult directive = http_get(cfg.server_url, path, cfg.agent_token);
  if (!directive.ok) return 5;
  const int minutes = std::max(1, json_int_field(directive.body, "poll_minutes", 5));
  if (!json_bool_field(directive.body, "collect")) return minutes;

  OsInfo os = detect_os();
  std::string payload;
  try {
    payload = build_inventory_payload(cfg, os);
  } catch (...) {
    payload = build_minimal_inventory_payload(cfg, os, "tray collect failed");
  }
  if (payload.empty()) payload = build_minimal_inventory_payload(cfg, os, "empty payload");
  HttpResult sent = http_post_json(cfg.server_url, "/api/v1/agent/inventory", cfg.agent_token, payload);
  if (sent.ok) {
    const int generation = json_int_field(directive.body, "generation", seen);
    write_seen_generation(util::exe_dir(), generation);
  }
  return minutes;
}
