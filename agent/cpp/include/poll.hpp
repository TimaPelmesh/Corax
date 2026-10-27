#pragma once
#include "config.hpp"

constexpr int kPollAuthRejected = -403;

// Ask the server. Collect only when it says so. Returns the next wait in minutes,
// or kPollAuthRejected when the token was revoked.
int poll_and_maybe_collect(const AgentConfig& cfg);
