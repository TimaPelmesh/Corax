#pragma once
#include <string>

// Writes/refreshes a desktop Internet Shortcut to /h#pc=<hostname>.
// Public desktop plus the current user (or every profile when running as SYSTEM).
std::string ensure_helpdesk_shortcut(const std::string& server_url, const std::string& hostname);
