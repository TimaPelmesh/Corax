#pragma once
#include "config.hpp"
#include "json_writer.hpp"
#include "osdetect.hpp"

std::string build_inventory_payload(const AgentConfig& cfg, const OsInfo& os);
