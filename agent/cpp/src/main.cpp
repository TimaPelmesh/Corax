#include "collect.hpp"
#include "config.hpp"
#include "crash_handler.hpp"
#include "desktop_shortcut.hpp"
#include "http.hpp"
#include "install.hpp"
#include "pair_lan.hpp"
#include "tray.hpp"
#include "osdetect.hpp"
#include "secure_config.hpp"
#include "ui_splash.hpp"
#include "util.hpp"

#include <windows.h>
#include <objbase.h>

#include <atomic>
#include <cstdio>
#include <iostream>
#include <string>
#include <thread>

namespace {

struct RunOpts {
  bool verbose = false;
  bool silent = false;
  bool pause = false;
  bool no_pause = false;
  bool no_gui = false;
  bool console = false;
  bool provision_only = false;
  bool ui_demo = false;
  bool poll = false;
  bool install = false;
  bool tray = false;
  std::string dump_path;
};

void setup_console_utf8() {
  SetConsoleOutputCP(CP_UTF8);
  SetConsoleCP(CP_UTF8);
}

bool ensure_console() {
  if (GetConsoleWindow() != nullptr) return true;
  if (!AllocConsole()) return false;
  FILE* fp = nullptr;
  freopen_s(&fp, "CONOUT$", "w", stdout);
  freopen_s(&fp, "CONOUT$", "w", stderr);
  freopen_s(&fp, "CONIN$", "r", stdin);
  setup_console_utf8();
  return true;
}

std::string log_path() { return util::exe_dir() + "\\corax-agent.log"; }

void append_log(const std::string& line) {
  util::append_file_utf8(log_path(), util::iso8601_utc_now() + "  " + line + "\n");
}

void say(const std::string& line, bool to_console) {
  append_log(line);
  if (to_console) {
    std::cout << line << std::endl;
    std::cout.flush();
  }
}

void wait_enter(const std::string& prompt) {
  std::cout << prompt << std::flush;
  HANDLE h = GetStdHandle(STD_INPUT_HANDLE);
  if (h && h != INVALID_HANDLE_VALUE) FlushConsoleInputBuffer(h);
  std::string discard;
  std::getline(std::cin, discard);
}

RunOpts parse_args(int argc, char** argv) {
  RunOpts o;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i] ? argv[i] : "";
    if (a == "--verbose" || a == "-v") o.verbose = true;
    else if (a == "--silent" || a == "-s") o.silent = true;
    else if (a == "--pause") o.pause = true;
    else if (a == "--no-pause") o.no_pause = true;
    else if (a == "--no-gui") o.no_gui = true;
    else if (a == "--console") o.console = true;
    else if (a == "--provision-only") o.provision_only = true;
    else if (a == "--ui-demo") o.ui_demo = true;
    else if (a == "--poll") o.poll = true;
    else if (a == "--install") o.install = true;
    else if (a == "--tray") o.tray = true;
    else if (a == "--dump" && i + 1 < argc) {
      o.dump_path = argv[++i] ? argv[i] : "corax-payload.json";
    }
  }
  return o;
}

// Keep splash alive / animated while a long task runs on a worker thread.
template <typename Fn>
auto run_with_ui(AgentSplash& splash, bool use_splash, int progress_floor, int progress_ceil,
                 const std::string& status, Fn&& fn) -> decltype(fn()) {
  using R = decltype(fn());
  if (!use_splash) return fn();

  splash.set_status(status);
  splash.set_progress(progress_floor);

  std::atomic<bool> done{false};
  std::exception_ptr eptr;
  R result{};
  std::thread worker([&] {
    // Convert SEH (WMI provider AV, DPAPI fault, WinHTTP schannel bug, …)
    // into a std::runtime_error inside the worker so the catch(...) below
    // rethrows a readable message instead of the process disappearing.
    install_seh_translator();
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    try {
      result = fn();
    } catch (...) {
      eptr = std::current_exception();
    }
    done = true;
  });

  int p = progress_floor;
  while (!done.load()) {
    if (p < progress_ceil) {
      ++p;
      splash.set_progress(p);
    } else {
      splash.set_busy(true);
      splash.pump();
    }
    Sleep(100);
  }
  worker.join();
  splash.set_busy(false);
  splash.set_progress(progress_ceil);
  if (eptr) std::rethrow_exception(eptr);
  return result;
}

std::string query_escape(const std::string& raw) {
  std::string out;
  for (unsigned char c : raw) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
        c == '.') {
      out.push_back(static_cast<char>(c));
    } else {
      char buf[8];
      sprintf_s(buf, "%%%02X", c);
      out += buf;
    }
  }
  return out;
}

int json_int_field(const std::string& body, const std::string& key, int fallback) {
  const std::string needle = "\"" + key + "\"";
  size_t pos = body.find(needle);
  if (pos == std::string::npos) return fallback;
  pos = body.find(':', pos + needle.size());
  if (pos == std::string::npos) return fallback;
  ++pos;
  while (pos < body.size() && (body[pos] == ' ' || body[pos] == '\t')) ++pos;
  try {
    return std::stoi(body.substr(pos));
  } catch (...) {
    return fallback;
  }
}

bool json_bool_field(const std::string& body, const std::string& key, bool fallback) {
  const std::string needle = "\"" + key + "\"";
  size_t pos = body.find(needle);
  if (pos == std::string::npos) return fallback;
  pos = body.find(':', pos + needle.size());
  if (pos == std::string::npos) return fallback;
  if (body.find("true", pos) != std::string::npos && body.find("true", pos) < pos + 8) return true;
  if (body.find("false", pos) != std::string::npos && body.find("false", pos) < pos + 10) return false;
  return fallback;
}

}  // namespace

int main(int argc, char** argv) {
  // Must be first: any subsequent line (regex in load_agent_config, DPAPI,
  // WMI, GDI splash, WinHTTP) can raise SEH, and without a handler the
  // process just vanishes after splash — the exact symptom users report.
  install_process_crash_handler(log_path());
  install_seh_translator();

  RunOpts opt = parse_args(argc, argv);
  AgentConfig cfg = load_agent_config();

  if (opt.tray) {
    if (cfg.server_url.empty() || cfg.agent_token.empty()) return 2;
    if (!cfg.agent_token.empty()) SecureZeroMemory(cfg.agent_token.data(), cfg.agent_token.size());
    return run_tray();
  }

  if (opt.provision_only) {
    append_log("credential=" + secure_config_status());
    const bool ok = !cfg.agent_token.empty();
    if (!cfg.agent_token.empty()) SecureZeroMemory(cfg.agent_token.data(), cfg.agent_token.size());
    return ok ? 0 : 2;
  }

  const bool silent_mode =
      !opt.ui_demo && (opt.silent || (cfg.silent && !opt.verbose && !opt.pause)) && !opt.pause;
  const bool use_splash = !silent_mode && !opt.no_gui;
  const bool console_out = !silent_mode && (opt.console || opt.verbose || !use_splash);
  const bool do_pause = !silent_mode && !opt.no_pause && (opt.pause || opt.console || opt.verbose);

  if (console_out || do_pause) ensure_console();
  // Keep the inherited console attached. Detaching made `start /wait` in
  // corax_run.cmd return while the splash was still up (or about to crash).

  AgentSplash splash;
  if (use_splash) {
    splash.show("Агент инвентаризации v" + cfg.agent_version);
    splash.set_status(cfg.server_url.empty() ? "Чтение конфигурации…" : ("Сервер: " + cfg.server_url));
    splash.set_progress(8);
  }

  try {
  say("=== CORAX-Agent start ===", console_out);
  say("log=" + log_path(), console_out);
  say("credential=" + secure_config_status(), console_out);

  if (opt.ui_demo && use_splash) {
    struct DemoStage {
      int from;
      int to;
      const char* status;
    };
    const DemoStage stages[] = {
        {8, 22, "Проверяем защищённое подключение…"},
        {22, 72, "Бережно собираем сведения о компьютере…"},
        {72, 96, "Подготавливаем и отправляем отчёт…"},
    };
    for (const auto& stage : stages) {
      splash.set_status(stage.status);
      for (int progress = stage.from; progress <= stage.to; ++progress) {
        splash.set_progress(progress);
        splash.pump();
        Sleep(55);
      }
    }
    splash.finish_ok("Демонстрация интерфейса завершена");
    return 0;
  }

  if ((cfg.server_url.empty() || cfg.agent_token.empty()) && !silent_mode) {
    auto status = [&](const std::string& text) {
      if (use_splash) {
        splash.set_status(text);
        splash.pump();
      }
      say(text, console_out);
    };
    if (enroll_on_lan(status)) cfg = load_agent_config();
  }

  if (cfg.server_url.empty() || cfg.agent_token.empty()) {
    const std::string msg =
        "Сервер CORAX в локальной сети не подтвердил этот компьютер.\n\n"
        "Откройте панель → Токены агентов и нажмите «Подключить».\n\n"
        "Лог: " +
        log_path();
    say("ERROR: missing server_url / agent_token", true);
    if (use_splash) splash.finish_error(msg);
    else if (do_pause) wait_enter("\nНажмите Enter… ");
    return 2;
  }

  say("server=" + cfg.server_url, console_out);
  if (use_splash) {
    splash.set_status("Определение ОС…");
    splash.set_progress(15);
  }

  OsInfo os = detect_os();
  say("os=" + os.family + " / " + os.arch + " build " + std::to_string(os.build), console_out);

  const std::string hostname = util::computer_hostname();
  if (!hostname.empty()) say("hostname=" + hostname, console_out);

  const bool interactive_launch = !opt.poll && !opt.silent && !opt.ui_demo && !opt.tray;
  std::string tray_dir;
  if (opt.install || interactive_launch) {
    InstallResult installed = run_with_ui(splash, use_splash, 10, 18, "Установка агента…", [] { return install_agent(); });
    tray_dir = installed.install_dir;
    say(installed.message, console_out);
    if (!installed.ok) {
      if (use_splash) splash.finish_error(installed.message);
      else if (do_pause) wait_enter("\nНажмите Enter… ");
      return 5;
    }
    if (use_splash) splash.set_status("Установлено. Первый отчёт…");
  }

  int ack_generation = -1;
  if (opt.poll) {
    const int seen = read_seen_generation(util::exe_dir());
    const std::string path = "/api/v1/agent/directive?hostname=" + query_escape(hostname) +
                             "&seen_generation=" + std::to_string(seen);
    HttpResult directive = http_get(cfg.server_url, path, cfg.agent_token);
    if (!directive.ok) {
      say("poll: сервер недоступен: " + directive.error, console_out);
      return 0;
    }
    if (!json_bool_field(directive.body, "collect", false)) {
      say("poll: сервер не просил сбор", console_out);
      return 0;
    }
    ack_generation = json_int_field(directive.body, "generation", seen);
    say("poll: сбор, причина в ответе сервера", console_out);
  }

  say("1/2 Сбор инвентаризации…", console_out);

  std::string payload;
  try {
    payload = run_with_ui(splash, use_splash, 20, 70, "Сбор инвентаризации…",
                          [&] { return build_inventory_payload(cfg, os); });
  } catch (const std::exception& ex) {
    say(std::string("WARN: collect exception, sending minimal: ") + ex.what(), true);
    payload = build_minimal_inventory_payload(cfg, os, ex.what());
  } catch (...) {
    say("WARN: collect failed, sending minimal payload", true);
    payload = build_minimal_inventory_payload(cfg, os, "unhandled collect error");
  }
  if (payload.empty()) {
    payload = build_minimal_inventory_payload(cfg, os, "empty collect payload");
  }
  say("   собрано байт: " + std::to_string(payload.size()), console_out);
  if (!opt.dump_path.empty()) {
    util::write_file_utf8(opt.dump_path, payload);
    say("dump=" + opt.dump_path, console_out);
  }

  say("2/2 Отправка…", console_out);

  HttpResult res;
  try {
    res = run_with_ui(splash, use_splash, 75, 95, "Отправка на сервер…", [&] {
      return http_post_json(cfg.server_url, "/api/v1/agent/inventory", cfg.agent_token, payload);
    });
  } catch (const std::exception& ex) {
    say(std::string("ERROR: upload exception: ") + ex.what(), true);
    if (use_splash) splash.finish_error(std::string("Сбой отправки: ") + ex.what());
    else if (do_pause) wait_enter("\nНажмите Enter… ");
    return 4;
  }

  if (!res.ok) {
    std::string detail = res.error.empty() ? ("HTTP " + std::to_string(res.status)) : res.error;
    say("ERROR: upload failed: " + detail, true);
    if (use_splash) {
      splash.finish_error("Не удалось отправить отчёт.\n\n" + detail + "\n\nСервер:\n" +
                          cfg.server_url + "\n\nЛог: " + log_path());
    } else if (do_pause) {
      wait_enter("\nНажмите Enter… ");
    }
    return 4;
  }

  say("OK HTTP " + std::to_string(res.status), console_out);
  if (ack_generation >= 0) write_seen_generation(util::exe_dir(), ack_generation);
  say("=== CORAX-Agent done ===", console_out);

  if (cfg.helpdesk_shortcut) {
    const std::string shortcut = ensure_helpdesk_shortcut(cfg.server_url, hostname);
    say(shortcut, console_out);
  }

  if (use_splash) {
    splash.set_progress(100);
    splash.finish_ok("Готово — отчёт отправлен.\n\nДальше агент сидит в трее и молчит.\nСбор только по команде панели или в заданное время.\n\nСервер:\n" +
                     cfg.server_url);
  } else if (do_pause) {
    wait_enter("\nГотово. Enter — закрыть… ");
  }
  if (!tray_dir.empty()) launch_tray_process(tray_dir);
  return 0;
  } catch (const std::exception& ex) {
    say(std::string("ERROR: unhandled: ") + ex.what(), true);
    if (use_splash) {
      splash.finish_error(std::string("Сбой агента:\n") + ex.what() + "\n\nЛог: " + log_path());
    } else if (do_pause) {
      wait_enter("\nНажмите Enter… ");
    }
    return 1;
  } catch (...) {
    say("ERROR: unhandled unknown exception", true);
    if (use_splash) splash.finish_error("Необработанный сбой агента.\n\nЛог: " + log_path());
    else if (do_pause) wait_enter("\nНажмите Enter… ");
    return 1;
  }
}
