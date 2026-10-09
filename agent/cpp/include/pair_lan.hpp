#pragma once
#include <functional>
#include <string>

enum class EnrollResult { Failed, Pending, Enrolled };

// Announces this PC. A token is written only after an admin approves it in CORAX.
EnrollResult enroll_on_lan(
    const std::function<void(const std::string&)>& status,
    const std::string& known_server = "",
    int wait_ms = 0);
