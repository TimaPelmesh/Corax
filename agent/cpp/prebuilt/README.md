# Prebuilt CORAX-Agent.template.exe

Windows PE binary with an empty config slot (`<<<CORAX_CFG_BEGIN>>>` … `END`).

- **Linux / Docker CORAX server:** does **not** compile MSVC. It only stamps
  `server_url` + `agent_token` into this file and returns `CORAX-Agent-*.exe`.
- **Windows with VS Build Tools:** may rebuild from `agent/cpp` sources; the
  new EXE is copied here automatically when the panel rebuilds.

Do not put real tokens into this file — the panel injects them per download.
