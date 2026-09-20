#pragma once
#include <map>
#include <string>
#include <vector>

struct WmiRowMap {
  std::map<std::string, std::string> fields;
  std::string get(const std::string& key) const {
    auto it = fields.find(key);
    return it == fields.end() ? std::string() : it->second;
  }
};

class WmiSession {
 public:
  WmiSession();
  ~WmiSession();
  WmiSession(const WmiSession&) = delete;
  WmiSession& operator=(const WmiSession&) = delete;

  bool ok() const { return ready_; }
  std::vector<WmiRowMap> query(const std::wstring& ns, const std::wstring& wql);
  std::vector<WmiRowMap> query_cimv2(const std::wstring& wql) {
    return query(L"ROOT\\CIMV2", wql);
  }

 private:
  bool ready_ = false;
};
