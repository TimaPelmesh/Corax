/** English in-app documentation. */
import type { GuideCopy } from './guideTypes'

export const GUIDE_EN: GuideCopy = {
  eyebrow: 'CORAX',
  title: 'Documentation',
  subtitle:
    'How the panel is laid out, how to deploy agents, and how not to lose data. Windows and Linux have their own sections below.',
  toc: 'Sections',
  tip: 'Tip',
  tipBody:
    'Start the server with npm run docker:up. Build the agent from the panel on the LAN IP, not 127.0.0.1. Do not publish the panel on the public internet.',
  searchPlaceholder: 'Search a section or step…',
  searchEmpty: 'Nothing found. Try another word.',
  openLabel: 'Open',
  sections: [
    {
      id: 'start',
      title: 'Getting started',
      summary: 'Roles, sign-in, and a typical workflow.',
      steps: [
        {
          title: 'Sign-in',
          body: 'Open the panel in a browser (usually port 3000). Login is a local CORAX account. LDAP is a people directory for tickets, not panel login.',
        },
        {
          title: 'Roles',
          body: 'Observer — view only. Editor — change data. Admin — users, LDAP, agent tokens, backups, HTTPS.',
        },
        {
          title: 'Typical day',
          body: 'Dashboard → problem PCs/tickets → PC card or ticket → network/printers/warehouse if needed.',
        },
        {
          title: 'Left menu',
          body: 'Sidebar: fleet (dashboard, risks, PCs, software, printers, network, warehouse), tickets, knowledge base. Settings is last: on desktop a second pane slides out to the right (AI agent … HTTPS), no scrollbar.',
        },
      ],
      links: [{ to: '/', label: 'Dashboard' }],
    },
    {
      id: 'dashboard',
      title: 'Dashboard',
      summary: 'Fleet and active tickets at a glance.',
      steps: [
        {
          title: 'What to watch',
          body: 'Tiles: PC count, offline, tickets. Charts and fleet summaries below.',
        },
        {
          title: 'Click a number',
          body: 'Many tiles open the PC or ticket list with a filter already applied.',
        },
      ],
      links: [{ to: '/', label: 'Dashboard' }],
    },
    {
      id: 'risks',
      title: 'Risk center',
      summary: 'Fleet health: antivirus, disks, Windows updates.',
      steps: [
        {
          title: 'What to watch',
          body: 'Risk levels and open problems. Acknowledge/ignore applies to the problem type across the fleet, not one PC.',
        },
        {
          title: 'AI insights',
          body: 'Editors can ask the local model to comment on the calculated summary — it must not invent vulnerabilities.',
        },
      ],
      links: [
        { to: '/risks', label: 'Risk center' },
        { to: '/knowledge-base/zabbix', label: 'Zabbix data' },
      ],
    },
    {
      id: 'computers',
      title: 'Computers',
      summary: 'Fleet list, PC card, tags, wake.',
      steps: [
        {
          title: 'List',
          body: 'Filter by tag, OS, ping. Search hostname, IP, serial. Click a row for the full card.',
        },
        {
          title: 'PC card',
          body: 'Hardware, disks, network, software, peripherals, change history, related tickets, last domain user. An extended report also shows uptime, timezone, firewall, Defender, screen resolution, Windows activation, sessions, monitors, RAM sticks, SMART (temp/wear), ports, tasks, faults, expiring certificates, and RDP/SMB1/UAC risks.',
        },
        {
          title: 'PC tags',
          body: 'Create under Settings → PC tags, assign to PCs for grouping (floor, dept, criticality).',
        },
        {
          title: 'Wake-on-LAN',
          body: 'Wake button on offline PC cards when WOL is allowed and a MAC is known.',
        },
      ],
      links: [
        { to: '/computers', label: 'Computers' },
        { to: '/settings/tags', label: 'PC tags' },
        { to: '/settings/wol', label: 'Wake-on-LAN' },
      ],
    },
    {
      id: 'agent',
      title: 'Inventory agent',
      summary:
        'PCs do not appear by themselves. The agent reports them. Build only from the panel on the LAN IP. Windows: PowerShell ZIP (7/10/11). Linux: bash ZIP.',
      steps: [
        {
          title: 'Why you need an agent',
          body: 'Without an agent, Computers stays empty. On each PC the agent collects hostname, serial, CPU/RAM, disks, NIC/IP/MAC, OS, installed software and peripherals, then POSTs a report. It repeats on a schedule. Git sources under agent/ are templates with no URL or token — do not run them in production.',
        },
        {
          title: 'Two packages on the panel',
          body: 'Settings → Agent build.\n• ZIP PowerShell Windows — one archive for 7/10/11; run corax_send_silent.vbs (no window). After send, a “Оставить заявку” desktop shortcut opens /h#pc=HOSTNAME.\n• ZIP Linux (bash) — see the Linux section below.\nThe C++ EXE is not offered from the panel for now.',
        },
        {
          title: 'Before you build — LAN IP',
          body: 'Open the panel at http://192.168.x.x:3000, not 127.0.0.1 and not Docker 172.x. Otherwise the bundle gets an address other PCs cannot reach. Match http/https on the build page to the server HTTPS mode; port is usually 3000.',
        },
        {
          title: 'Build',
          body: 'Sign in as admin → Settings → Agent build. Check the URL, pick a package, download. Server URL and token are stamped into the file — you do not paste them by hand. Each build creates a new token. One downloaded ZIP can be rolled out to many PCs.',
        },
        {
          title: 'Tokens',
          body: 'Format: public_id.secret. The DB stores HMAC only; the full secret lives in agent_env.bat / agent_env.sh. List and revoke: Settings → Agent tokens. Rebuilding does not revoke the old token until you revoke it. Do not publish ZIPs or commit agent_env.*. If a secret leaked — revoke the token and change the admin password.',
        },
        {
          title: 'Where not to put the agent',
          body: 'Do not run scripts from the CORAX server tree: next to docker-compose.yml, backend\\.env, run.py, or from /opt/corax/agent/…. Those copies have __INVENTORY_SERVER__ placeholders; reports go nowhere and production looks “down”.\nWindows: unpack the ZIP to %ProgramData%\\CORAX\\agent or a share \\\\fileserver\\corax\\agent.\nLinux: only /opt/corax-agent (the server stays in /opt/corax).',
        },
        {
          title: 'ZIP Windows — contents',
          body: 'corax_send.bat — manual run: waits until collection finishes and shows status.\ncorax_send_silent.vbs — no window (Task Scheduler).\ncorax-last-run.txt — OK/FAILED after a run.\nagent_env.bat — URL and token; do not overwrite on script updates.\nagent_config.json — collection modules.\nupdate_scripts.bat — safe update.\nwin10\\ — PowerShell 5+ (Windows 10/11).\nwin7\\ — Windows 7 / old PowerShell.\nREADME_DEPLOY.txt — short cheat sheet inside the archive.',
        },
        {
          title: 'ZIP Windows — first run',
          body: 'Unpack to %ProgramData%\\CORAX\\agent (not the server tree).\ncd /d %ProgramData%\\CORAX\\agent\ncorax_send.bat\nThe window says Collecting inventory and closes when the report is sent (usually under a minute). Status OK/FAILED is shown and written to corax-last-run.txt.\nNo window: corax_send_silent.vbs.\nA “Оставить заявку” shortcut appears: http://LAN-IP:3000/h#pc=HOSTNAME.\nCheck: Computers — hostname and “last report”.',
        },
        {
          title: 'ZIP Windows — schedule',
          body: 'If auto-start was enabled at build time, the ZIP includes install_schedule.bat — run once as Administrator. It registers the CORAX-Agent SYSTEM task (no window for users) and starts the first report immediately. Later runs are on the timer via corax_send_silent.vbs. Do not put a bare corax_send.bat into Task Scheduler.',
        },
        {
          title: 'ZIP Windows — update without wiping the token',
          body: 'Do not extract a new ZIP over a live folder (“replace” / unzip -o). That overwrites agent_env.bat — URL and token vanish, reports stop.\nDo this:\n1. Extract the new panel ZIP to a temp folder, e.g. C:\\temp\\corax-agent-new.\n2. From the live folder:\ncd /d %ProgramData%\\CORAX\\agent\nupdate_scripts.bat C:\\temp\\corax-agent-new\nagent_env.bat stays. Or copy only win10\\, win7\\, corax_send.bat, corax_send_silent.vbs — leave agent_env.bat alone.',
        },
        {
          title: 'What it sends and how to verify',
          body: 'Hostname, serial, CPU/RAM, disks, NIC/IP/MAC, OS, software, peripherals.\nAPI: POST http://<LAN-IP>:3000/api/v1/agent/inventory\nAuthorization: Bearer <token>\nWithout a token the API rejects the report. If the PC never shows up: reachability of :3000, URL is not 127.0.0.1, agent is not from the server git tree, token is not revoked.',
        },
        {
          title: 'HTTPS',
          body: 'One port :3000 = one scheme. After enabling TLS in Settings → HTTPS, restart the container and rebuild agents with https://. An old http:// bundle will stop reporting. Agent PCs need a trusted ca.crt (GPO or scripts/install-corax-ca.bat in the repo).',
        },
        {
          title: 'Typical Windows mistakes',
          body: 'Running from the server git tree sends reports nowhere. Put the ZIP in %ProgramData%\\CORAX\\agent.\nURL 127.0.0.1 or Docker 172.x — build with the panel open on the LAN IP.\nExtracting a new ZIP over a live folder wipes the token. Use update_scripts.bat.\nA cmd window appears — run corax_send_silent.vbs or download a fresh ZIP (the bat hides itself). Debug: corax_send.bat visible.\nSwitched HTTP↔HTTPS — download a fresh bundle.',
        },
      ],
      links: [
        { to: '/settings/agent-bundle', label: 'Agent build' },
        { to: '/settings/agent-tokens', label: 'Tokens' },
        { to: '/computers', label: 'Computers' },
      ],
    },
    {
      id: 'agent-linux',
      title: 'Linux agent',
      summary:
        'Bash ZIP only in /opt/corax-agent. Do not confuse it with the server tree /opt/corax. Update scripts with update_scripts.sh — never unzip -o over a live folder.',
      steps: [
        {
          title: 'Two directories — do not mix them',
          body: '/opt/corax — the server (git, Docker). Do not run the agent from here.\n/opt/corax-agent — ZIP from the panel only. Unpack and run here.',
        },
        {
          title: 'First run',
          body: 'Panel → Agent build → ZIP Linux (bash) → download (panel opened on the LAN IP).\nOn the host:\nsudo mkdir -p /opt/corax-agent\nsudo unzip -o corax-agent-linux-*.zip -d /opt/corax-agent\ncd /opt/corax-agent\nchmod +x run_console.sh corax_send.sh inventory_agent.sh install_cron.sh update_scripts.sh\n/bin/sh ./run_console.sh\nDo not copy agent_env.sh.example without editing URL/token — the agent exits 2. Use the panel ZIP.',
        },
        {
          title: 'Files in the ZIP',
          body: 'run_console.sh — main console launcher (recommended).\ncorax_send.sh — same (alias).\ninventory_agent.sh — collection core.\nagent_env.sh — URL + token (panel-generated; do not commit).\nagent_config.json — modules.\ninstall_cron.sh — cron.\nsystemd/ — timer.\nupdate_scripts.sh — refresh scripts without touching agent_env.sh.\nREADME.txt — cheat sheet in the archive.',
        },
        {
          title: 'Schedule',
          body: 'sudo ./install_cron.sh from /opt/corax-agent.\nOr the systemd timer under systemd/ in the ZIP.',
        },
        {
          title: 'Update without wiping the token',
          body: 'unzip -o new.zip -d /opt/corax-agent overwrites agent_env.sh — URL and token vanish.\nDo this:\nsudo unzip -o corax-agent-linux-*.zip -d /tmp/corax-agent-new\nsudo /bin/sh /opt/corax-agent/update_scripts.sh /tmp/corax-agent-new\nOr: unzip -o new.zip -x agent_env.sh -d /opt/corax-agent — only if agent_env.sh already exists. First install: no -x.',
        },
        {
          title: 'Safety',
          body: 'The agent does not read or write the server backend/.env or the database. Temp files only under /tmp/corax-agent.* (marker .corax_workdir). Cleanup deletes that temp only — never /opt, .env, or volumes. Launch from the server tree is blocked unless CORAX_AGENT_ALLOW_IN_SOURCE=1 (not recommended in production).',
        },
        {
          title: 'Typical Linux mistakes',
          body: 'Launch from /opt/corax/agent/linux is wrong. Put the ZIP in /opt/corax-agent.\nunzip -o over a live agent wipes the token — use update_scripts.sh.\nURL 127.0.0.1 never reaches other hosts. Build on the LAN IP.',
        },
      ],
      links: [
        { to: '/settings/agent-bundle', label: 'Agent build' },
        { to: '/computers', label: 'Computers' },
      ],
    },
    {
      id: 'agent-audit',
      title: 'Windows full audit',
      summary:
        'A separate hands-on collector — not for GPO. Run it yourself when you need the maximum snapshot.',
      steps: [
        {
          title: 'How it differs',
          body: 'The panel ZIP is quiet and meant for rollout/schedule. Full audit lives in the repo: agent/audit-win/corax_audit.bat + Corax-FullAudit.ps1. Double-click → UAC → one window, collect hw/health/ops/security, POST the same /api/v1/agent/inventory payload.',
        },
        {
          title: 'Extra fields',
          body: 'SMART (temp, wear, hours), monitors, RAM sticks, BitLocker, Defender, firewall, local admins, RDP/SMB1/UAC, Windows activation, listening ports, autoruns, tasks, BSOD/faults, USB history, expiring certificates. Without admin rights some blocks are skipped; the run does not crash.',
        },
        {
          title: 'Shortcut after send',
          body: 'After a successful POST the desktop gets “Оставить заявку” → http://LAN-IP:3000/h#pc=HOSTNAME. If the agent URL was localhost, the server IPv4 is substituted.',
        },
      ],
      links: [
        { to: '/settings/agent-bundle', label: 'Agent build' },
        { to: '/computers', label: 'Computers' },
      ],
    },
    {
      id: 'software',
      title: 'Software catalog',
      summary: 'Fleet-wide software and hardware slices.',
      steps: [
        {
          title: 'Why',
          body: 'See how many PCs have an app, OS/RAM distribution, manufacturers.',
        },
        {
          title: 'How',
          body: 'Pick a slice (software, devices, OS…) and drill into host lists when needed.',
        },
      ],
      links: [{ to: '/software', label: 'Software' }],
    },
    {
      id: 'printers',
      title: 'Printers',
      summary: 'SNMP discovery and supply polling.',
      steps: [
        {
          title: 'Scan',
          body: 'Run subnet discovery (community often public). Found printers show up in the list.',
        },
        {
          title: 'Card',
          body: 'Model, page counter, toner/drum, status. Click a row for details.',
        },
        {
          title: 'Poll settings',
          body: 'Interval and community are on the Printers page.',
        },
      ],
      links: [{ to: '/printers', label: 'Printers' }],
    },
    {
      id: 'network',
      title: 'Network',
      summary: 'LAN device list and SNMP polling. The diagram lives on Network map.',
      steps: [
        {
          title: 'List',
          body: 'The page opens as a list: switches, routers, APs, PCs. Filter by role, add devices manually, configure SNMP.',
        },
        {
          title: 'Poll',
          body: '“Poll all” refreshes SNMP status of known devices. New hosts appear after a poll or a manual add.',
        },
        {
          title: 'Network map',
          body: 'Use the Network map menu item for several diagrams (blank canvas or auto-layout from topology). Add items, captions and pictures, then bind devices. Clearing a diagram needs a typed confirmation.',
        },
      ],
      links: [
        { to: '/network', label: 'Network' },
        { to: '/network-map', label: 'Network map' },
      ],
    },
    {
      id: 'requests',
      title: 'Tickets',
      summary: 'List, templates, stats. New ticket is a button, not a separate tab.',
      steps: [
        {
          title: 'Create or edit',
          body: 'On the ticket list, the “New ticket” button opens the form in a dialog. Clicking a ticket opens the same dialog to edit. Title, description, PC, category, priority, assignee — save from the dialog’s top bar.',
        },
        {
          title: 'Ticket list',
          body: 'Statuses: open / in progress / done / cancelled. Filters and search. The list can show 50, 100, or all tickets — no nested table scrollbar.',
        },
        {
          title: 'Templates',
          body: 'Reusable texts for common requests.',
        },
        {
          title: 'Stats',
          body: 'Period, KPIs, trend, assignee load. Automatic insights from the numbers plus a local-model report for the selected period.',
        },
        {
          title: 'Notifications',
          body: 'Profile in the top-right → Notifications. Theme, settings, and logout live there too.',
        },
        {
          title: 'Ticket categories',
          body: 'Category tree under Settings → Ticket categories.',
        },
      ],
      links: [
        { to: '/requests/database', label: 'List' },
        { to: '/requests/templates', label: 'Templates' },
        { to: '/requests/stats', label: 'Stats' },
        { to: '/settings/categories', label: 'Ticket categories' },
      ],
    },
    {
      id: 'shortcuts',
      title: 'Helpdesk shortcut /h',
      summary: 'A short page for end users without a full panel login.',
      steps: [
        {
          title: '/h — leave a ticket',
          body: 'The only public form. The ticket is created immediately as “waiting”. After sending, the same page lists tickets from this PC: accepted, taken into work, or done. AI later sets the category. The old /r URL only redirects here.',
        },
        {
          title: 'Desktop shortcut',
          body: 'After a report the agent drops “Оставить заявку”. Link: http://LAN-IP:3000/h#pc=PC-NAME — the server IP, not localhost. Shortcuts with the old names are removed on the next run.',
        },
      ],
    },
    {
      id: 'knowledge',
      title: 'Knowledge base',
      summary: 'WikiRAG, this guide, and team notes.',
      steps: [
        {
          title: 'Tabs',
          body: 'Knowledge base → Wiki / Assistant (chat over documents), Documentation (this text), Notes. The building map sits in inventory next to the network map. Zabbix data sits next to the risk center. Warehouse: /warehouse.',
        },
      ],
      links: [
        { to: '/knowledge-base/wikirag', label: 'WikiRAG' },
        { to: '/knowledge-base/guide', label: 'Documentation' },
        { to: '/knowledge-base/notes', label: 'Notes' },
      ],
    },
    {
      id: 'warehouse',
      title: 'Warehouse',
      summary: 'Manual warehouse items — not GLPI.',
      steps: [
        {
          title: 'How to track',
          body: 'Every item is the same: one row and a shelf quantity (RAM, SSD, toner, cables). Change quantity in the item card (+/−); write off or delete from the row actions. SK is an internal warehouse number, not the box barcode.',
        },
        {
          title: 'Write-off and history',
          body: '“Write off” asks how many: one piece or all. History shows receipts, moves, and write-offs. Deleting erases the record — prefer write-off to keep the audit trail.',
        },
        {
          title: 'Rooms',
          body: 'Storage locations (closet, server room) keep stock separated. You enter the data yourself.',
        },
      ],
      links: [{ to: '/warehouse', label: 'Warehouse' }],
    },
    {
      id: 'sitemap',
      title: 'Building map',
      summary: 'Floor plans in inventory, next to the network map.',
      steps: [
        {
          title: 'Floors',
          body: 'Upload a plan and place markers for PCs/equipment.',
        },
        {
          title: 'Binding',
          body: 'Markers link to CORAX objects — click opens the card.',
        },
      ],
      links: [{ to: '/knowledge-base/sitemap', label: 'Building map' }],
    },
    {
      id: 'wikirag',
      title: 'Wiki / Assistant',
      summary: 'CORAX knowledge base and chat over indexed documents.',
      steps: [
        {
          title: 'Import CORAX',
          body: 'On the WikiRAG page click “Import CORAX” — the fleet snapshot is saved as readable Markdown (computers, hardware, software, printers…).',
        },
        {
          title: 'Indexing',
          body: 'Wait until files show “ready”, or click “Reindex all”. After changing the embedding model, run a full reindex.',
        },
        {
          title: 'Chat',
          body: 'Wiki / Assistant is the chat itself. Answers use indexed documents only; sources appear under the reply. The file library opens as a knowledge drawer.',
        },
        {
          title: 'Models',
          body: 'Settings → AI agent: chat model (Ollama / LM Studio). Index embeddings are separate (default bge-m3); URL is set in server env.',
        },
      ],
      links: [
        { to: '/knowledge-base/wikirag', label: 'WikiRAG' },
        { to: '/settings/llm', label: 'AI agent' },
      ],
    },
    {
      id: 'notes',
      title: 'Notes / projects',
      summary: 'Internal team notes.',
      steps: [
        {
          title: 'Use',
          body: 'Checklists and agreements — separate from tickets and Wiki files.',
        },
      ],
      links: [{ to: '/knowledge-base/notes', label: 'Notes' }],
    },
    {
      id: 'zabbix',
      title: 'Zabbix',
      summary: 'Monitoring data next to the risk center; server connection under Settings.',
      steps: [
        {
          title: 'Data',
          body: 'In inventory, next to the risk center: problems and metrics for hosts matched to CORAX PCs. The PC card links here.',
        },
        {
          title: 'Connection',
          body: 'Admin: Settings → Zabbix — API URL, account, connection check. Without this the data tab stays empty.',
        },
      ],
      links: [
        { to: '/knowledge-base/zabbix', label: 'Zabbix data' },
        { to: '/settings/zabbix', label: 'Zabbix settings' },
      ],
    },
    {
      id: 'search',
      title: 'Global search',
      summary: 'Search box in the top bar.',
      steps: [
        {
          title: 'Scope',
          body: 'PCs (hostname, IP, serial), printers, ticket text — grouped by type.',
        },
      ],
    },
    {
      id: 'admin',
      title: 'Administration',
      summary: 'Admins (and some editor settings).',
      steps: [
        {
          title: 'Profile',
          body: 'Avatar in the top-right: theme, notifications, interface settings (a full modal), and logout. Profile settings are not the integrations flyout.',
        },
        {
          title: 'Settings flyout',
          body: 'Last button on the left (gear). On desktop a full list slides out: AI agent, tags, categories, users, LDAP, Bitrix24, Zabbix, DB, GLPI, tokens, agent build, Wake-on-LAN, HTTPS.',
        },
        {
          title: 'Users',
          body: 'Local panel accounts, roles, link to LDAP directory person for tickets.',
        },
        {
          title: 'LDAP',
          body: 'Sync people directory. Does not replace panel login.',
        },
        {
          title: 'Bitrix24 / GLPI',
          body: 'Optional people import / CSV exchange — check limits before bulk runs.',
        },
        {
          title: 'Database',
          body: 'Backup before imports and upgrades. Docker also schedules backups.',
        },
        {
          title: 'HTTPS',
          body: 'Local CA for a few admin PCs — no public DNS required.',
        },
      ],
      links: [
        { to: '/users', label: 'Users' },
        { to: '/settings/llm', label: 'AI agent' },
        { to: '/settings/tags', label: 'PC tags' },
        { to: '/settings/ldap', label: 'LDAP' },
        { to: '/settings/bitrix24', label: 'Bitrix24' },
        { to: '/settings/zabbix', label: 'Zabbix' },
        { to: '/settings/database', label: 'DB / backup' },
        { to: '/settings/glpi', label: 'GLPI' },
        { to: '/settings/agent-tokens', label: 'Tokens' },
        { to: '/settings/agent-bundle', label: 'Agent build' },
        { to: '/settings/wol', label: 'Wake-on-LAN' },
        { to: '/settings/https', label: 'HTTPS' },
      ],
    },
    {
      id: 'ops',
      title: 'Reliability',
      summary: 'How the panel survives a reboot, an update, and a brief network drop.',
      steps: [
        {
          title: 'Docker volumes',
          body: 'Postgres and files live in corax_pgdata, corax_data, corax_backups. npm run docker:down stops containers and keeps the data.',
        },
        {
          title: 'After a host reboot',
          body: 'Containers use restart: unless-stopped. If the panel is silent, docker:ps then docker:logs. A yellow “no connection” bar means the API is down.',
        },
        {
          title: 'Backups',
          body: 'Settings → Database: take a snapshot before update.sh and bulk imports. Docker also schedules dumps.',
        },
        {
          title: 'Updates',
          body: 'You do not need a nightly git pull. When you want new features: ./update.sh (or CORAX_FORCE_BUILD=1). Backup first. Do not break POST /api/v1/agent/inventory without rebuilding agent packages.',
        },
      ],
      links: [{ to: '/settings/database', label: 'DB / backup' }],
    },
    {
      id: 'security',
      title: 'Security',
      summary: 'The panel is for a trusted LAN. Do not expose it to the public internet.',
      steps: [
        {
          title: 'First login',
          body: 'admin / admin123 is only a bootstrap. The rest of the API stays locked until you change that password. Do not leave the default on a live network.',
        },
        {
          title: 'Roles and sessions',
          body: 'Observer is read-only (no SNMP community, no /h client secret). Logout and password change revoke older JWTs. LDAP is a people directory for tickets, not panel login.',
        },
        {
          title: 'Agents',
          body: 'The token in the database is HMAC; the full secret lives only in the ZIP. One archive can cover many PCs; a rebuild issues a new token. Do not commit agent_env.* or agent ZIPs.',
        },
        {
          title: 'HTTPS',
          body: 'For a few admin PCs use the local CA under Settings → HTTPS. No public DNS required. CORS and CORAX_ADVERTISE_HOST must include the LAN IP or agents will miss the server.',
        },
      ],
      links: [
        { to: '/settings/https', label: 'HTTPS' },
        { to: '/settings/agent-tokens', label: 'Tokens' },
      ],
    },
  ],
}
