# CORAX Agent v5 (C++)

Native Windows inventory agent. One portable `CORAX-Agent.exe` for Win7 / Win10 / Win11.

## How CORAX server uses it

| Host OS | What happens |
|---------|----------------|
| **Linux / Docker** | Packages the immutable `prebuilt/CORAX-Agent.template.exe` with public config and one-time provisioning. No MSVC. |
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

## Runtime configuration and credential protection

1. `agent.json` contains public configuration only.
2. On first launch, `agent.provision.json` is protected with Windows DPAPI
   `LocalMachine`, written as hidden `agent.cred`, then removed.
3. Environment variables remain available for managed deployment.
4. The old embedded config slot remains read-only for compatibility with
   previously generated agents. New panel bundles never patch the EXE.

The server stores an HMAC hash of the token secret. HTTPS is still required to
encrypt the token and inventory in transit; DPAPI protects only endpoint storage.

## Run

```text
CORAX-Agent.exe
CORAX-Agent.exe --verbose
CORAX-Agent.exe --silent
```

Log: `corax-agent.log` next to the EXE. Posts to `POST {server}/api/v1/agent/inventory`.
