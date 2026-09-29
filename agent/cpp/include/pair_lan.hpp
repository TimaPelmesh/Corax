#pragma once
#include <functional>
#include <string>

// Asks the inventory server (baked into the installer, or found on the LAN) for a token.
// Writes agent.provision.json next to the EXE. Does not replace an existing agent.json.
bool enroll_on_lan(const std::function<void(const std::string&)>& status, const std::string& known_server = "");
