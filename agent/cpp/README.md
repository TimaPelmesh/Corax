# CORAX Agent v4 (C++)

Native Windows inventory agent. One portable `CORAX-Agent.exe` for Win7 / Win10 / Win11.

## How CORAX server uses it

| Host OS | What happens |
|---------|----------------|
| **Linux / Docker** | Uses `prebuilt/CORAX-Agent.template.exe` and **only stamps** config (URL + token). No MSVC. |
| **Windows + VS Build Tools** | Can rebuild from source, then stamp. Falls back to prebuilt if CMake missing. |

Agents always run on **Windows PCs**. The Linux box only packages the EXE.

## Build template (developers on Windows)

Requires Visual Studio 2022 Build Tools (MSVC + CMake).

```powershell
cmake -S agent/cpp -B agent/cpp/build -G "Visual Studio 17 2022" -A x64
cmake --build agent/cpp/build --config Release --target CORAX-Agent
copy agent\cpp\build\Release\CORAX-Agent.exe agent\cpp\prebuilt\CORAX-Agent.template.exe
```

Or let a Windows CORAX panel rebuild and refresh `prebuilt/`.

## Runtime config (priority)

1. **Embedded slot** (panel stamp) — always wins when present  
2. `agent.json` / `agent_config.json` beside the EXE — only if slot empty for that field  
3. Env `INVENTORY_SERVER` / `AGENT_TOKEN` — only if still empty  

## Run

```text
CORAX-Agent.exe
CORAX-Agent.exe --verbose
CORAX-Agent.exe --silent
```

Log: `corax-agent.log` next to the EXE. Posts to `POST {server}/api/v1/agent/inventory`.
