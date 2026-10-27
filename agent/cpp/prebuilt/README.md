# Prebuilt CORAX-Agent.template.exe

Windows PE binary with an empty config slot (`<<<CORAX_CFG_BEGIN>>>` … `END`).

- **Linux / Docker CORAX server:** does **not** compile MSVC. It copies this
  file, stamps the server URL and token into the config slot, and returns one EXE.
- **Windows with VS Build Tools:** may rebuild from `agent/cpp` sources; the
  release script can publish the new EXE here.

Do not put real tokens into this template. The panel patches a copy at download time.
