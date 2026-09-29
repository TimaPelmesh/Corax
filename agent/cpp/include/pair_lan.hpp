#pragma once
#include <functional>
#include <string>

// Asks the inventory server for a token and writes it next to the EXE.
// The server issues the token immediately. There is no panel approval step.
bool enroll_on_lan(
    const std::function<void(const std::string&)>& status,
    const std::string& known_server = "");
