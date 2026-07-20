# CORAX Agent v4 (C++)

Native Windows inventory agent. One portable `CORAX-Agent.exe` for Win7 / Win10 / Win11.

## Build (developers)

Requires Visual Studio 2022 Build Tools (MSVC + CMake).

```powershell
cmake -S agent/cpp -B agent/cpp/build -G "Visual Studio 17 2022" -A x64
cmake --build agent/cpp/build --config Release --target CORAX-Agent
```

Or let the CORAX panel build it: **Settings → Bundle → EXE C++**.

## Runtime config (priority)

1. **Embedded slot** (panel stamp) — always wins when present  
2. `agent.json` / `agent_config.json` beside the EXE — only if slot empty for that field  
3. Env `INVENTORY_SERVER` / `AGENT_TOKEN` — only if still empty  

(Earlier builds let env override the stamp — that forced localhost when `INVENTORY_SERVER` was set in the user profile.)

## Run

```text
run.bat
CORAX-Agent.exe
CORAX-Agent.exe --verbose --pause
CORAX-Agent.exe --silent
```

On success/error (interactive) a MessageBox appears. Log file: `corax-agent.log` next to the EXE.

Posts to `POST {server}/api/v1/agent/inventory`.
