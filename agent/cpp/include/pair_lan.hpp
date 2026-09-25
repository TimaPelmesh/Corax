#pragma once
#include <functional>
#include <string>

// Finds a CORAX panel on the local /24, waits until an admin connects this PC,
// then writes agent.json and agent.provision.json next to the EXE.
bool enroll_on_lan(const std::function<void(const std::string&)>& status);
