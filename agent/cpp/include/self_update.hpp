#pragma once
#include "config.hpp"
#include <string>

// If the panel's template is newer, download it, keep this PC's server and
// token, replace the running exe, and (for the tray) restart with no window.
// Returns when nothing was applied. A successful tray restart does not return.
void maybe_self_update(const AgentConfig& cfg, const std::string& directive_body, bool relaunch_tray);
