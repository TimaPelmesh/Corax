#include "install.hpp"
#include "util.hpp"

#include <windows.h>

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
      : L"";
  return L"<?xml version=\"1.0\" encoding=\"UTF-16\"?>"
         L"<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">" +
         principal + L"<Triggers>" + trigger +
         L"</Triggers><Settings>"
         L"<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"
         L"<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"
         L"<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"
         L"<StartWhenAvailable>true</StartWhenAvailable>"
         L"<ExecutionTimeLimit>PT10M</ExecutionTimeLimit>"
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

}  // namespace

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
  const wchar_t* env = _wgetenv(L"ProgramData");
  std::wstring root = (env && *env) ? std::wstring(env) : L"C:\\ProgramData";
  std::wstring dir = root + L"\\CORAX\\Agent";
  if (!CreateDirectoryW((root + L"\\CORAX").c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) {
    out.message = "Нет прав создать C:\\ProgramData\\CORAX. Запустите EXE от администратора.";
    return out;
  }
  if (!CreateDirectoryW(dir.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) {
    out.message = "Нет прав создать папку агента. Запустите EXE от администратора.";
    return out;
  }

  std::wstring dest_exe = dir + L"\\CORAX-Agent.exe";
  if (!same_path(self, dest_exe)) {
    if (!CopyFileW(self.c_str(), dest_exe.c_str(), FALSE)) {
      out.message = "Не удалось скопировать EXE в ProgramData\\CORAX\\Agent.";
      return out;
    }
  }
  size_t slash = self.find_last_of(L"\\/");
  std::wstring src_dir = slash == std::wstring::npos ? L"." : self.substr(0, slash);
  copy_if_present(src_dir, dir, L"agent.json");
  copy_if_present(src_dir, dir, L"agent.provision.json");
  copy_if_present(src_dir, dir, L"agent.cred");

  const bool elevated = util::is_elevated();
  bool tray_ok = register_task(
      L"CORAX Agent Tray", L"corax-tray-task.xml",
      task_xml(dest_exe, L"--tray", true, false));
  bool poll_ok = register_task(
      L"CORAX Agent", L"corax-poll-task.xml",
      task_xml(dest_exe, L"--poll --silent", false, elevated));
  (void)tray_ok;
  if (!poll_ok) {
    out.message = "EXE скопирован, но задача планировщика не создана. Запустите от администратора.";
    out.install_dir = util::narrow(dir);
    return out;
  }
  out.ok = true;
  out.install_dir = util::narrow(dir);
  out.message = "Установлено. Опрос сервера каждую минуту и из трея: сбор по команде или в заданное на сервере время.";
  return out;
}
