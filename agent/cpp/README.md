# CORAX Agent v5 (C++)

Native Windows inventory agent. One portable `CORAX-Agent.exe` for Win7 / Win10 / Win11.

## How CORAX server uses it

| Host OS | What happens |
|---------|----------------|
| **Linux / Docker** | Stamps server URL and token into `prebuilt/CORAX-Agent.template.exe` and returns that single EXE. No MSVC. |
| **Windows + VS Build Tools** | Can rebuild the same immutable EXE. Falls back to prebuilt if CMake is missing. |

Agents always run on **Windows PCs**. The Linux box only packages the EXE.

## Build and publish template (developers on Windows)

Requires Visual Studio 2022 Build Tools (MSVC + CMake).

```powershell
.\agent\Build-WindowsAgent.ps1 -Configuration Release -UpdatePrebuiltTemplate
```

Production signing:

```powershell
$env:CORAX_SIGN_CERT_THUMBPRINT = "CERTIFICATE_THUMBPRINT"
.\agent\Build-WindowsAgent.ps1 -Configuration Release -Sign -UpdatePrebuiltTemplate
```

All generation, signing, verification, and offline packaging scripts live in `agent/`.

## Runtime configuration

The panel stamps `server_url` and `agent_token` into the EXE config slot.
That file is the whole Windows agent. On launch it copies itself into
`%ProgramData%\CORAX\Agent` (or the user profile without administrator rights),
sends an inventory report, and stays in the tray. A sidecar `agent.json` is
still read if it is present.

The server stores an HMAC hash of the token secret. HTTPS is still required to
encrypt the token and inventory in transit; DPAPI protects only endpoint storage.

## Run

```text
CORAX-Agent.exe
CORAX-Agent.exe --verbose
CORAX-Agent.exe --silent
```

Log: `corax-agent.log` next to the EXE. Posts to `POST {server}/api/v1/agent/inventory`.
