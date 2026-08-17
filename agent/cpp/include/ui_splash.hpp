#pragma once
#include <string>

// Lightweight branded splash while the agent runs (Win32 + progress bar).
class AgentSplash {
 public:
  AgentSplash();
  ~AgentSplash();

  void show(const std::string& title_hint);
  void set_status(const std::string& text);
  void set_progress(int percent_0_100);
  void set_busy(bool busy);  // indeterminate marquee while long work runs
  void pump();  // process UI messages briefly
  void finish_ok(const std::string& detail);
  void finish_error(const std::string& detail);
  void close();

  bool visible() const { return hwnd_ != nullptr; }

 private:
  void* hwnd_ = nullptr;  // HWND without including windows.h here
  void* status_ = nullptr;
  void* bar_ = nullptr;
};
