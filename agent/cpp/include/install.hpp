#pragma once
#include <string>

struct InstallResult {
  bool ok = false;
  std::string install_dir;
  std::string message;
};

// Copy the running EXE and its config into ProgramData and register a poll task.
InstallResult install_agent();

std::string generation_path_for(const std::string& dir);
int read_seen_generation(const std::string& dir);
void write_seen_generation(const std::string& dir, int generation);
