CORAX AGENT — PORTABLE WINDOWS PACKAGE
======================================

1. Extract the ZIP to a private local folder, for example:
   C:\ProgramData\CORAX Agent
2. Double-click "Run CORAX Agent.cmd".
3. Optional: run "Install scheduled task.cmd" as Administrator.

SECURITY
--------
- CORAX-Agent.exe is identical in every package and can be Authenticode-signed.
- agent.json contains the inventory server address. The same ZIP installs on every PC.
- There is no token in the ZIP. On first launch the installer asks the server
  for one. An admin confirms the PC under Settings -> Agent tokens.
- The issued token is then encrypted with Windows DPAPI (LocalMachine).
- Prefer HTTPS. With HTTP, the token and inventory are not encrypted in transit.

ANTIVIRUS / SMARTSCREEN
-----------------------
No build script can guarantee zero detections. For production distribution:
- sign CORAX-Agent.exe with a trusted Authenticode code-signing certificate;
- timestamp the signature;
- do not modify the EXE after signing;
- publish stable version metadata and hashes;
- submit false positives to the antivirus vendor instead of adding exclusions.

- CORAX-Agent.exe                 Native Win7/10/11 x64 agent
- agent.json                     Server address and public settings
- agent.cred                     DPAPI credential (created after the server issues a token)
- SHA256SUMS.txt                 Integrity hash for the immutable EXE

After a successful inventory POST the agent writes a desktop shortcut "Заявка CORAX"
that opens /h#pc=<this-PC-name>. Disable with "helpdesk_shortcut": false in agent.json.
