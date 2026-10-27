#pragma once
#include <string>

void assist_ui_offer(void* tray_hwnd, const std::string& admin_name);
void assist_ui_live(void* tray_hwnd);
void assist_ui_hide();
bool assist_ui_visible();
