#include "json_writer.hpp"
#include <cstdio>
#include <sstream>

void JsonWriter::comma_if_needed() {
  if (first_stack_.empty()) return;
  if (!first_stack_.back()) buf_ += ',';
  else first_stack_.back() = false;
}

std::string JsonWriter::escape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char tmp[8];
          std::snprintf(tmp, sizeof(tmp), "\\u%04x", c);
          out += tmp;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  return out;
}

void JsonWriter::begin_object() {
  comma_if_needed();
  buf_ += '{';
  first_stack_.push_back(true);
}

void JsonWriter::end_object() {
  buf_ += '}';
  if (!first_stack_.empty()) first_stack_.pop_back();
}

void JsonWriter::begin_array() {
  comma_if_needed();
  buf_ += '[';
  first_stack_.push_back(true);
}

void JsonWriter::end_array() {
  buf_ += ']';
  if (!first_stack_.empty()) first_stack_.pop_back();
}

void JsonWriter::key(const std::string& k) {
  comma_if_needed();
  buf_ += '"';
  buf_ += escape(k);
  buf_ += "\":";
  if (!first_stack_.empty()) first_stack_.back() = true;
}

void JsonWriter::null_value() {
  comma_if_needed();
  buf_ += "null";
}

void JsonWriter::value(bool v) {
  comma_if_needed();
  buf_ += v ? "true" : "false";
}

void JsonWriter::value(int64_t v) {
  comma_if_needed();
  buf_ += std::to_string(v);
}

void JsonWriter::value(double v) {
  comma_if_needed();
  char tmp[64];
  std::snprintf(tmp, sizeof(tmp), "%.4g", v);
  buf_ += tmp;
}

void JsonWriter::value(const std::string& v) {
  comma_if_needed();
  buf_ += '"';
  buf_ += escape(v);
  buf_ += '"';
}

void JsonWriter::value(const char* v) {
  if (!v) {
    null_value();
    return;
  }
  value(std::string(v));
}

void JsonWriter::raw(const std::string& json_fragment) {
  comma_if_needed();
  buf_ += json_fragment;
}
