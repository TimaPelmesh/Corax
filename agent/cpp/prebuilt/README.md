# Prebuilt CORAX-Agent.template.exe

Windows PE binary with an empty config slot (`<<<CORAX_CFG_BEGIN>>>` … `END`).

- **Linux / Docker CORAX server:** does **not** compile MSVC. It packages this
  immutable binary in a portable ZIP with public config and one-time provisioning.
- **Windows with VS Build Tools:** may rebuild from `agent/cpp` sources; the
  release script can publish the new EXE here.

Do not put real tokens into this file. New panel bundles never modify its bytes,
so a trusted Authenticode signature remains valid across every deployment.
