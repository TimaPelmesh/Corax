#pragma once
#include <string>

struct HttpResult {
  bool ok = false;
  int status = 0;
  std::string body;
  std::string error;
};

HttpResult http_post_json(const std::string& base_url, const std::string& path,
                          const std::string& bearer_token, const std::string& json_body);

HttpResult http_post_bytes(const std::string& base_url, const std::string& path,
                           const std::string& bearer_token, const std::string& content_type,
                           const void* data, size_t size);

HttpResult http_get(const std::string& base_url, const std::string& path,
                    const std::string& bearer_token);
