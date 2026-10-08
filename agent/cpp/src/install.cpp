#include "install.hpp"
#include "util.hpp"

#include <windows.h>
#include <shellapi.h>

#include <cctype>
#include <cstdio>
#include <string>

namespace {

std::wstring exe_path_w() {
  wchar_t buf[MAX_PATH * 4];
  DWORD n = GetModuleFileNameW(nullptr, buf, (DWORD)(sizeof(buf) / sizeof(buf[0])));
  if (!n) return L"";
  return std::wstring(buf, n);
}

bool same_path(const std::wstring& a, const std::wstring& b) {
  return util::to_lower(util::narrow(a)) == util::to_lower(util::narrow(b));
}

bool copy_if_present(const std::wstring& from_dir, const std::wstring& to_dir, const wchar_t* name) {
  std::wstring src = from_dir + L"\\" + name;
  if (GetFileAttributesW(src.c_str()) == INVALID_FILE_ATTRIBUTES) return true;
  std::wstring dst = to_dir + L"\\" + name;
  return CopyFileW(src.c_str(), dst.c_str(), FALSE) == TRUE;
}

bool run_hidden(const std::wstring& cmd, DWORD& exit_code) {
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION pi{};
  std::wstring mutable_cmd = cmd;
  if (!CreateProcessW(nullptr, mutable_cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr,
                      &si, &pi)) {
    return false;
  }
  WaitForSingleObject(pi.hProcess, 20000);
  exit_code = 1;
  GetExitCodeProcess(pi.hProcess, &exit_code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return true;
}

bool run_schtasks(const std::wstring& args, DWORD& exit_code) {
  return run_hidden(L"schtasks.exe " + args, exit_code);
}

bool write_utf16_file(const std::wstring& path, const std::wstring& text) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  const wchar_t bom = 0xFEFF;
  DWORD written = 0;
  WriteFile(file, &bom, sizeof(bom), &written, nullptr);
  BOOL ok = WriteFile(file, text.data(), (DWORD)(text.size() * sizeof(wchar_t)), &written, nullptr);
  CloseHandle(file);
  return ok == TRUE;
}

std::wstring xml_escape(const std::wstring& raw) {
  std::wstring out;
  for (wchar_t c : raw) {
    if (c == L'&') out += L"&amp;";
    else if (c == L'<') out += L"&lt;";
    else if (c == L'>') out += L"&gt;";
    else if (c == L'"') out += L"&quot;";
    else out.push_back(c);
  }
  return out;
}

std::wstring task_xml(const std::wstring& command, const std::wstring& arguments, bool at_logon, bool as_system) {
  std::wstring trigger = at_logon
      ? L"<LogonTrigger><Enabled>true</Enabled></LogonTrigger>"
      : L"<TimeTrigger><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled>"
        L"<Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>";
  std::wstring principal = as_system
      ? L"<Principals><Principal id=\"Author\"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>"
      : L"<Principals><Principal id=\"Author\"><GroupId>S-1-5-32-545</GroupId><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>";
  std::wstring limit = at_logon ? L"PT0S" : L"PT10M";
  return L"<?xml version=\"1.0\" encoding=\"UTF-16\"?>"
         L"<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">" +
         principal + L"<Triggers>" + trigger +
         L"</Triggers><Settings>"
         L"<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"
         L"<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"
         L"<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"
         L"<StartWhenAvailable>true</StartWhenAvailable>"
         L"<ExecutionTimeLimit>" + limit + L"</ExecutionTimeLimit>"
         L"<Enabled>true</Enabled>"
         L"</Settings><Actions Context=\"Author\"><Exec><Command>" +
         xml_escape(command) + L"</Command><Arguments>" + xml_escape(arguments) +
         L"</Arguments></Exec></Actions></Task>";
}

bool register_task(const wchar_t* name, const wchar_t* file_name, const std::wstring& xml) {
  wchar_t temp[MAX_PATH];
  DWORD n = GetTempPathW(MAX_PATH, temp);
  if (!n || n >= MAX_PATH) return false;
  std::wstring path = std::wstring(temp) + file_name;
  if (!write_utf16_file(path, xml)) return false;
  DWORD code = 1;
  bool started = run_schtasks(L"/Create /F /TN \"" + std::wstring(name) + L"\" /XML \"" + path + L"\"", code);
  DeleteFileW(path.c_str());
  return started && code == 0;
}

void register_run_key(HKEY root, const std::wstring& dest_exe, REGSAM extra) {
  HKEY key = nullptr;
  if (RegCreateKeyExW(root, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0, nullptr, 0,
                      KEY_SET_VALUE | extra, nullptr, &key, nullptr) != ERROR_SUCCESS) {
    return;
  }
  std::wstring cmd = L"\"" + dest_exe + L"\" --tray";
  RegSetValueExW(key, L"CORAX Agent", 0, REG_SZ, reinterpret_cast<const BYTE*>(cmd.c_str()),
                 static_cast<DWORD>((cmd.size() + 1) * sizeof(wchar_t)));
  RegCloseKey(key);
}

void register_tray_autostart(const std::wstring& dest_exe) {
  register_task(L"CORAX Agent Tray", L"corax-tray-task.xml", task_xml(dest_exe, L"--tray", true, false));
  register_run_key(HKEY_LOCAL_MACHINE, dest_exe, KEY_WOW64_64KEY);
}

bool ensure_dir(const std::wstring& path) {
  if (CreateDirectoryW(path.c_str(), nullptr)) return true;
  return GetLastError() == ERROR_ALREADY_EXISTS;
}

std::string percent_decode(const std::string& raw) {
  std::string out;
  for (size_t i = 0; i < raw.size(); ++i) {
    if (raw[i] == '%' && i + 2 < raw.size() && std::isxdigit(static_cast<unsigned char>(raw[i + 1])) &&
        std::isxdigit(static_cast<unsigned char>(raw[i + 2]))) {
      auto hex = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return 0;
      };
      out.push_back(static_cast<char>((hex(raw[i + 1]) << 4) | hex(raw[i + 2])));
      i += 2;
    } else {
      out.push_back(raw[i]);
    }
  }
  return out;
}

bool valid_rdp_host(const std::string& value) {
  if (value.empty() || value.size() > 255) return false;
  if (value.find("..") != std::string::npos) return false;
  for (unsigned char c : value) {
    if (c == ' ' || c == '\\' || c == '/' || c == '"' || c == '\'' || c == '`' || c == ';' || c == '|' ||
        c == '$' || c == '&' || c == '<' || c == '>') {
      return false;
    }
  }
  int o1 = 0, o2 = 0, o3 = 0, o4 = 0;
  char extra = 0;
  if (sscanf_s(value.c_str(), "%d.%d.%d.%d%c", &o1, &o2, &o3, &o4, &extra, 1) == 4) {
    if (o1 <= 0 || o1 == 127 || o1 >= 224) return false;
    return o1 <= 255 && o2 >= 0 && o2 <= 255 && o3 >= 0 && o3 <= 255 && o4 >= 0 && o4 <= 255;
  }
  if (!std::isalnum(static_cast<unsigned char>(value.front())) ||
      !std::isalnum(static_cast<unsigned char>(value.back()))) {
    return false;
  }
  for (unsigned char c : value) {
    if (!std::isalnum(c) && c != '.' && c != '_' && c != '-') return false;
  }
  return true;
}

std::string rdp_host_from_spec(std::string spec) {
  spec = util::trim(spec);
  if (spec.size() >= 2 && spec.front() == '"' && spec.back() == '"') spec = spec.substr(1, spec.size() - 2);
  if (spec.size() >= 10 && util::to_lower(spec.substr(0, 10)) == "corax-rdp:") spec = spec.substr(10);
  while (!spec.empty() && spec.front() == '/') spec.erase(spec.begin());
  if (!spec.empty() && spec.back() == '/') spec.pop_back();
  spec = percent_decode(spec);
  return valid_rdp_host(spec) ? spec : "";
}

void register_rdp_protocol_key(HKEY root, const std::wstring& dest_exe, REGSAM extra) {
  HKEY key = nullptr;
  if (RegCreateKeyExW(root, L"Software\\Classes\\corax-rdp", 0, nullptr, 0, KEY_SET_VALUE | extra, nullptr, &key,
                      nullptr) != ERROR_SUCCESS) {
    return;
  }
  const wchar_t* desc = L"URL:CORAX Remote Desktop";
  RegSetValueExW(key, nullptr, 0, REG_SZ, reinterpret_cast<const BYTE*>(desc),
                 static_cast<DWORD>((wcslen(desc) + 1) * sizeof(wchar_t)));
  const wchar_t empty[] = L"";
  RegSetValueExW(key, L"URL Protocol", 0, REG_SZ, reinterpret_cast<const BYTE*>(empty), sizeof(wchar_t));
  RegCloseKey(key);
  key = nullptr;
  if (RegCreateKeyExW(root, L"Software\\Classes\\corax-rdp\\shell\\open\\command", 0, nullptr, 0, KEY_SET_VALUE | extra,
                      nullptr, &key, nullptr) != ERROR_SUCCESS) {
    return;
  }
  std::wstring cmd = L"\"" + dest_exe + L"\" --rdp \"%1\"";
  RegSetValueExW(key, nullptr, 0, REG_SZ, reinterpret_cast<const BYTE*>(cmd.c_str()),
                 static_cast<DWORD>((cmd.size() + 1) * sizeof(wchar_t)));
  RegCloseKey(key);
}

}  // namespace

void ensure_rdp_protocol() {
  std::wstring self = exe_path_w();
  if (self.empty()) return;
  register_rdp_protocol_key(HKEY_CURRENT_USER, self, 0);
}

int launch_rdp_from_spec(const std::string& spec) {
  const std::string host = rdp_host_from_spec(spec);
  if (host.empty()) return 1;
  std::wstring args = L"/v:" + util::widen(host);
  HINSTANCE n = ShellExecuteW(nullptr, L"open", L"mstsc.exe", args.c_str(), nullptr, SW_SHOWNORMAL);
  return reinterpret_cast<INT_PTR>(n) > 32 ? 0 : 1;
}

std::string generation_path_for(const std::string& dir) { return dir + "\\agent.seen"; }

int read_seen_generation(const std::string& dir) {
  std::string raw = util::trim(util::read_file_utf8(generation_path_for(dir)));
  if (raw.empty()) return 0;
  try {
    return std::stoi(raw);
  } catch (...) {
    return 0;
  }
}

void write_seen_generation(const std::string& dir, int generation) {
  util::write_file_utf8(generation_path_for(dir), std::to_string(generation));
}

InstallResult install_agent() {
  InstallResult out;
  std::wstring self = exe_path_w();
  if (self.empty()) {
    out.message = "Не удалось определить путь к EXE.";
    return out;
  }
  size_t slash = self.find_last_of(L"\\/");
  std::wstring src_dir = slash == std::wstring::npos ? L"." : self.substr(0, slash);

  const wchar_t* program_data = _wgetenv(L"ProgramData");
  std::wstring machine_root = (program_data && *program_data) ? std::wstring(program_data) : L"C:\\ProgramData";
  std::wstring machine_dir = machine_root + L"\\CORAX\\Agent";
  bool machine = ensure_dir(machine_root + L"\\CORAX") && ensure_dir(machine_dir);

  std::wstring dir = machine_dir;
  if (!machine) {
    const wchar_t* local_app = _wgetenv(L"LOCALAPPDATA");
    std::wstring user_root = (local_app && *local_app) ? std::wstring(local_app) : L"C:\\Users\\Public";
    dir = user_root + L"\\CORAX\\Agent";
    if (!ensure_dir(user_root + L"\\CORAX") || !ensure_dir(dir)) dir = src_dir;
  }

  std::wstring dest_exe = dir + L"\\CORAX-Agent.exe";
  if (!same_path(self, dest_exe)) {
    if (!CopyFileW(self.c_str(), dest_exe.c_str(), FALSE)) {
      dest_exe = self;
      dir = src_dir;
    }
  }
  copy_if_present(src_dir, dir, L"agent.json");
  copy_if_present(src_dir, dir, L"agent.provision.json");
  copy_if_present(src_dir, dir, L"agent.cred");

  // Current user always gets a logon start, even without administrator rights.
  register_run_key(HKEY_CURRENT_USER, dest_exe, 0);
  register_rdp_protocol_key(HKEY_CURRENT_USER, dest_exe, 0);

  if (util::is_elevated()) {
    register_task(L"CORAX Agent", L"corax-poll-task.xml", task_xml(dest_exe, L"--poll --silent", false, true));
    register_tray_autostart(dest_exe);
  }

  out.ok = true;
  out.install_dir = util::narrow(dir);
  out.message = machine ? "Установлено. Агент в автозагрузке и в трее."
                        : "Установлено для этого пользователя. Агент в автозагрузке и в трее.";
  return out;
}
