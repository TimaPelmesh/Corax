#include "collect.hpp"
#include "config.hpp"
#include "http.hpp"
#include "osdetect.hpp"
#include "ui_splash.hpp"
#include "util.hpp"

#include <windows.h>

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

}  // namespace

int main(int argc, char** argv) {
  RunOpts opt = parse_args(argc, argv);
  AgentConfig cfg = load_agent_config();

  const bool silent_mode = (opt.silent || (cfg.silent && !opt.verbose && !opt.pause)) && !opt.pause;
  const bool use_splash = !silent_mode && !opt.no_gui;
  const bool console_out = !silent_mode && (opt.console || opt.verbose || !use_splash);
  const bool do_pause = !silent_mode && !opt.no_pause && (opt.pause || opt.console || opt.verbose);

  if (console_out || do_pause) ensure_console();
  else if (GetConsoleWindow()) {
    // Double-click with GUI: no console noise.
    FreeConsole();
  }

  AgentSplash splash;
  if (use_splash) {
    splash.show("Агент инвентаризации v" + cfg.agent_version);
    splash.set_status(cfg.server_url.empty() ? "Чтение конфигурации…" : ("Сервер: " + cfg.server_url));
    splash.set_progress(8);
  }

  say("=== CORAX-Agent start ===", console_out);
  say("log=" + log_path(), console_out);

  if (cfg.server_url.empty() || cfg.agent_token.empty()) {
    const std::string msg =
        "Нет настроек сервера или токена.\n\n"
        "Скачайте пакет из панели CORAX:\n"
        "Настройки → Сборка → EXE C++\n\n"
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

  say("1/2 Сбор инвентаризации…", console_out);

  std::string payload;
  try {
    payload = run_with_ui(splash, use_splash, 20, 70, "Сбор инвентаризации…",
                          [&] { return build_inventory_payload(cfg, os); });
  } catch (const std::exception& ex) {
    std::string err = std::string("Сбой сбора: ") + ex.what();
    say("ERROR: " + err, true);
    if (use_splash) splash.finish_error(err + "\n\nЛог: " + log_path());
    else if (do_pause) wait_enter("\nНажмите Enter… ");
    return 3;
  } catch (...) {
    say("ERROR: collect failed", true);
    if (use_splash) splash.finish_error("Сбой сбора данных.\n\nЛог: " + log_path());
    else if (do_pause) wait_enter("\nНажмите Enter… ");
    return 3;
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
  say("=== CORAX-Agent done ===", console_out);

  if (use_splash) {
    splash.set_progress(100);
    splash.finish_ok("Готово — отчёт отправлен.\n\nСервер:\n" + cfg.server_url + "\n\nОС: " +
                     os.family + " / " + os.arch + "\nРазмер: " + std::to_string(payload.size()) +
                     " байт\n\nОткройте в панели: Компьютеры");
  } else if (do_pause) {
    wait_enter("\nГотово. Enter — закрыть… ");
  }
  return 0;
}
