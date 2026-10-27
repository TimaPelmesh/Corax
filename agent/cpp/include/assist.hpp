#pragma once

void assist_tray_start(void* tray_hwnd);
void assist_tray_stop();
void assist_tray_handle(void* tray_hwnd, unsigned msg, unsigned long long wp);
