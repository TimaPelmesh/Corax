#pragma once
#include <string>

/** Notify-only banner: who is connected + Hang up. No consent dialog. */
void assist_ui_live(void* tray_hwnd, const std::string& admin_name);
void assist_ui_hide();
bool assist_ui_visible();
