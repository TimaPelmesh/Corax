#pragma once
#include "config.hpp"

// Ask the server. Collect only when it says so. Returns the next wait in minutes.
int poll_and_maybe_collect(const AgentConfig& cfg);
