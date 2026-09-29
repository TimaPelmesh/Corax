#pragma once
#include <functional>
#include <string>

// Asks the inventory server (baked into the installer, or found on the LAN) for a token.
// Writes agent.provision.json next to the EXE. Does not replace an existing agent.json.
// wait_for_approval keeps polling only when the server still expects a manual connect.
bool enroll_on_lan(
    const std::function<void(const std::string&)>& status,
    const std::string& known_server = "",
    bool wait_for_approval = false);
