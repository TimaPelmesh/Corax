#pragma once
#include <string>

// User-session icon. Sleeps between server polls. No windows unless the user asks.
int run_tray();
void launch_tray_process(const std::string& install_dir);
