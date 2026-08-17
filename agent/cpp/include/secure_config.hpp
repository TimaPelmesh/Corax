#pragma once

#include <string>

// Reads the DPAPI-protected credential stored beside the agent. If a
// one-time agent.provision.json exists, it is migrated to DPAPI
// (CRYPTPROTECT_LOCAL_MACHINE) and then removed.
std::string load_or_provision_agent_token(const std::string& directory);

// Human-readable status for diagnostics/UI. Never contains the token.
std::string secure_config_status();
