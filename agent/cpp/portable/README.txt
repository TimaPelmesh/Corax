CORAX AGENT — PORTABLE WINDOWS PACKAGE
======================================

1. Extract the ZIP to a private local folder, for example:
   C:\ProgramData\CORAX Agent
2. Double-click "Run CORAX Agent.cmd".
3. Optional: run "Install scheduled task.cmd" as Administrator.

SECURITY
--------
- CORAX-Agent.exe is identical in every package and can be Authenticode-signed.
- agent.json contains only public settings such as the server URL.
- agent.provision.json is a one-time token bootstrap. On first launch it is
  encrypted with Windows DPAPI (LocalMachine), saved as hidden agent.cred,
  overwritten where possible, and deleted.
- Keep the original ZIP private: it necessarily contains the bootstrap token.
- Prefer HTTPS. With HTTP, the Bearer token and inventory are not encrypted in
  transit. Application-level token obfuscation is not a substitute for TLS.
- The server stores only an HMAC hash of the token secret. Revoke a package's
  token in Settings -> Agent tokens if the ZIP is exposed.

ANTIVIRUS / SMARTSCREEN
-----------------------
No build script can guarantee zero detections. For production distribution:
- sign CORAX-Agent.exe with a trusted Authenticode code-signing certificate;
- timestamp the signature;
- do not modify the EXE after signing;
- publish stable version metadata and hashes;
- submit false positives to the antivirus vendor instead of adding exclusions.

FILES
-----
CORAX-Agent.exe                 Native Win7/10/11 x64 agent
agent.json                     Public configuration
agent.provision.json           One-time sensitive bootstrap (deleted on first run)
agent.cred                     DPAPI credential (created on first run)
SHA256SUMS.txt                 Integrity hash for the immutable EXE
