#pragma once

#include <string>

// Wire the process-wide crash handler exactly once, as early as possible in
// `main()`. On any unhandled SEH exception (access violation, stack overflow,
// int-divide-by-zero, WMI provider crashing inside a proxy call, etc.) the
// handler:
//
//   * writes `corax-agent.log` line "crash: code=0x… address=0x… module=…"
//   * writes a full minidump `corax-agent-crash-<timestamp>.dmp` next to the
//     EXE (best-effort — needs dbghelp.dll on Windows, always present since
//     Vista);
//   * shows a MessageBox with a short human sentence and dmp path, so a user
//     running the agent by double-click stops seeing "just disappeared after
//     splash" and has an artifact to forward to the operator.
//
// `log_path` is passed in so the handler doesn't depend on util:: (util.cpp
// pulls in `<regex>` which itself can throw when the process is already in a
// broken state — the handler must be dependency-minimal).
void install_process_crash_handler(const std::string& log_path);

// Convert Windows structured exceptions into std::runtime_error inside the
// *current* thread. Requires the whole target built with `/EHa` (see
// CMakeLists.txt). Must be called at the top of every std::thread body that
// runs code the C++ layer expects to unwind cleanly (WMI, DPAPI, WinHTTP —
// all of these can and do raise SEH in the wild).
//
// Cheap (installs a thread-local translator) and idempotent.
void install_seh_translator();
