## CORAX 1.0.0

First public release of **CORAX** — a self-hosted LAN inventory panel and light helpdesk.

### Highlights

- **One command:** `npm run docker:up` (PostgreSQL + API + UI)
- **Agents:** Windows C++ EXE or ZIP (Win 7/10/11), Linux bash ZIP
- **Fleet:** computers, software, tickets, warehouse, SNMP printers
- **Network map:** routers, switches, PCs from LLDP/CDP/FDB and traceroute across neighboring subnets
- **Knowledge:** WikiRAG over your own documents (optional local LLM)
- **Integrations:** LDAP, Bitrix24, GLPI CSV import

### Install

```bash
git clone https://github.com/TimaPelmesh/Corax.git
cd Corax
npm run docker:up
```

Open `http://YOUR-LAN-IP:3000/` and sign in as `admin` / `admin123`. The panel **requires** a new password before anything else works.

This stack is for a **trusted LAN**. Do not publish it on the internet. See [SECURITY.md](https://github.com/TimaPelmesh/Corax/blob/v1.0.0/SECURITY.md).

### Docs

- [Getting started](https://github.com/TimaPelmesh/Corax/blob/v1.0.0/GETTING_STARTED.md)
- [Changelog](https://github.com/TimaPelmesh/Corax/blob/v1.0.0/CHANGELOG.md)
- [Contributing](https://github.com/TimaPelmesh/Corax/blob/v1.0.0/CONTRIBUTING.md)
