# Next release prep (after 1.2.0)

Do not tag until the smoke list below is green on a LAN build.

## What landed in Unreleased

- Sidebar: text-only Corax wordmark, quieter nav
- Dashboard: browsers / office charts actually render; catalog search no longer 500s
- Software-family names match real agent DisplayName / package strings
- More unit tests (dashboard summary, prefs, families, ticket-handler pipeline)
- **Agent (C++): survives WMI/DPAPI/schannel crashes.** Every launch installs a
  SEH crash handler + `_set_se_translator` in worker threads. Access
  violations, WMI provider glitches, and TLS-provider faults are turned into
  readable `std::runtime_error` (splash shows a real message) and a minidump
  is written next to the EXE — no more "vanishes after animation".
- Ticket list: one-click **Close** on open tickets. Closing runs CORAX AI
  for category + cleaner title recommendations; operator applies or keeps
  the original, then the ticket becomes «Закрыта».

## Smoke before tag

1. `npm run docker:rebuild` on a VM (or `CORAX_FORCE_BUILD=1 ./update.sh`)
2. Login as admin → change bootstrap password if prompted
3. Dashboard: OS / browsers / office donuts have data if the fleet has Chrome and Office
3b. Click a browser / OS / office slice — a PC list must open (not “Нет ПК”)
4. Software catalog: type `Chrome` — list filters, no 500
5. Computers → open a PC card
6. Risk Center opens
7. Network → map when devices exist
8. Tickets: create + list
9. Settings → Agent bundle: download EXE or ZIP
10. `npm test` (pytest + vitest). Playwright if `E2E_*` points at the running panel.

## Tag (when ready)

```bash
# bump version in package.json, frontend/package.json, pyproject if present
# fill CHANGELOG date, add docs/release-v1.3.0.md from this file
git tag v1.3.0
```

Do not publish the panel on the public internet.
