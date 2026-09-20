#pragma once
#include <string>
#include <vector>

// Minimal JSON builder (UTF-8). Enough for CORAX inventory payload.
class JsonWriter {
 public:
  void begin_object();
  void end_object();
  void begin_array();
  void end_array();

  void key(const std::string& k);
  void null_value();
  void value(bool v);
  void value(int64_t v);
  void value(double v);
  void value(const std::string& v);
  void value(const char* v);

  void raw(const std::string& json_fragment);

  std::string str() const { return buf_; }

 private:
  std::string buf_;
  std::vector<bool> first_stack_;
  void comma_if_needed();
  static std::string escape(const std::string& s);
};
