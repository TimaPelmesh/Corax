## Inventory agent as EXE (PyInstaller)

This project already has a Python collector in `agent.py`.  
For an easy single-file entrypoint intended for packaging, use:

- `inventory_agent_embedded.py`

### 1) Put your token into the script

Open `inventory_agent_embedded.py` and set:

- `EMBEDDED_AGENT_TOKEN = "<paste token here>"`
- (optional) `DEFAULT_INVENTORY_SERVER = "http://<server>:3001"`

Environment variables still override these defaults:
- `INVENTORY_SERVER`
- `AGENT_TOKEN`
- `INVENTORY_QUEUE_DIR`

### 2) Create venv + install deps

From repo root:

```bash
python -m venv .venv
.\.venv\Scripts\activate
pip install -r agent/python/requirements.txt
pip install pyinstaller
```

### 3) Build .exe

Run:

```bash
pyinstaller --onefile --name inventory-agent --clean agent/python/inventory_agent_embedded.py
```

Output will be in:
- `dist/inventory-agent.exe`

### 4) Run

```bash
dist\inventory-agent.exe
```

Optional overrides:

```bash
dist\inventory-agent.exe --server http://192.168.1.10:3001
```

Notes:
- The agent uses a local queue by default on Windows: `%ProgramData%\InventoryAgent\pending_report.json`
- Make sure your server has inbound TCP `3001` open (firewall).

