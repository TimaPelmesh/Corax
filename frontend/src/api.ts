const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')
const API_PREFIX = '/api/v1'

/** WebSocket для онлайн-присутствия и уведомлений об изменениях карты этажа. */
export function diagramLiveWebSocketUrl(diagramId: number): string {
  const path = `${API_PREFIX}/diagrams/${diagramId}/live`
  if (API_BASE) {
    const base = API_BASE.startsWith('http') ? API_BASE : `http://${API_BASE}`
    const u = new URL(base)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    const root = u.pathname.replace(/\/$/, '')
    u.pathname = `${root}${path}`
    u.search = ''
    u.hash = ''
    return u.toString()
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}${path}`
}

/** Тот же базовый URL, что у `request()` — при пустом VITE_API_URL относительный `/api/v1/...` (прокси Vite / тот же origin). */
function apiUrl(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path
}

const REQUEST_TIMEOUT_MS = 25_000
/** WikiRAG: бэкенд ждёт LM Studio до lm_studio_timeout_seconds (по умолчанию 300 с). */
const WIKIRAG_LM_TIMEOUT_MS = 330_000
const WIKIRAG_IMPORT_TIMEOUT_MS = 120_000

function requestTimeoutMessage(path: string): string {
  if (path.includes('/wiki-rag/chat')) {
    return (
      'Модель не ответила вовремя (лимит ~5 мин). LM Studio: модель загружена в RAM, ' +
      'Server Timeout увеличен; для лёгких моделей ответ обычно 30–90 с.'
    )
  }
  if (path.includes('/wiki-rag/import/corax')) {
    return 'Импорт CORAX занял слишком много времени. Проверьте, что API запущен, и повторите.'
  }
  return (
    'Нет ответа от сервера (таймаут). Проверьте, что API запущен ' +
    '(Docker: npm run docker:up / docker compose ps; локально: npm start) и порт совпадает (обычно :3000).'
  )
}

function getCookie(name: string): string | null {
  try {
    const all = document.cookie ?? ''
    const parts = all.split(';')
    for (const p of parts) {
      const s = p.trim()
      if (!s) continue
      const eq = s.indexOf('=')
      if (eq <= 0) continue
      const k = s.slice(0, eq)
      if (k === name) return decodeURIComponent(s.slice(eq + 1))
    }
  } catch {
    // ignore
  }
  return null
}

function shouldAttachCsrf(method?: string): boolean {
  const m = (method ?? 'GET').toUpperCase()
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE'
}

async function request<T>(
  path: string,
  options: RequestInit & { json?: unknown; timeout_ms?: number } = {},
): Promise<T> {
  const { json, timeout_ms, ...fetchOpts } = options
  const headers = new Headers(options.headers)
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json')
  }
  if (shouldAttachCsrf(options.method)) {
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
  }

  const ctrl = new AbortController()
  const timeoutMs = timeout_ms ?? REQUEST_TIMEOUT_MS
  const tid = window.setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(apiUrl(path), {
      ...fetchOpts,
      credentials: 'include',
      headers,
      signal: ctrl.signal,
      body: json !== undefined ? JSON.stringify(json) : options.body,
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(requestTimeoutMessage(path))
    }
    throw e instanceof Error ? e : new Error(String(e))
  } finally {
    window.clearTimeout(tid)
  }
  if (!res.ok) {
    const parsed = await res.json().catch(() => null)
    const err = parsed && typeof parsed === 'object' ? parsed : null
    const detail =
      (err as { detail?: string } | null)?.detail ??
      (parsed == null ? await res.text().catch(() => '') : '') ??
      res.statusText
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export type User = {
  id: number
  username: string
  email: string | null
  full_name: string | null
  avatar_data?: string | null
  is_active: boolean
  is_superuser: boolean
  is_ldap: boolean
  role: 'observer' | 'editor' | 'directory'
  created_at: string
}

export type UserDirectoryItem = {
  id: number
  username: string
  full_name: string | null
}

export type Monitor = {
  id: number
  name: string
  manufacturer: string | null
  model: string | null
  serial_number: string | null
  inventory_number: string | null
  organization: string | null
  glpi_contact_raw: string | null
  assigned_user_id: number | null
  glpi_updated_at: string | null
}

export type Diagram = {
  id: number
  title: string
  source_filename: string
  created_at: string | null
  sort_order?: number
  has_visio_source?: boolean
}

export type FloorRoomRect = {
  id: string
  x: number
  y: number
  w: number
  h: number
  label: string
  fill: string
  stroke: string
}

export type FloorComputerMarker = {
  id: string
  computer_id: number
  x: number
  y: number
  label?: string | null
}

export type FloorIconKind =
  | 'pc'
  | 'server'
  | 'printer'
  | 'camera'
  | 'ap'
  | 'switch'
  | 'door'
  | 'stairs'
  | 'elevator'
  | 'text'
  | 'ethernet_outlet'
  | 'phone_outlet'

export type FloorObjectMeta = {
  title?: string | null
  computer_id?: string | null
  /** ID принтера из парка (для kind === 'printer'). */
  printer_id?: string | null
  employee_extension?: string | null
  /** Номер розетки (для значка ethernet_outlet / phone_outlet на карте). */
  outlet_number?: string | null
  /** ID маркера ПК на этом этаже — конец кабеля от розетки. */
  connected_pc_id?: string | null
  /** Номер розетки Ethernet на рабочем месте. */
  ethernet_outlet?: string | null
  /** Номер телефонной розетки на рабочем месте. */
  phone_outlet?: string | null
  os_name?: string | null
  cpu?: string | null
  ram_gb?: string | null
  manufacturer?: string | null
  model?: string | null
  ip?: string | null
  mac?: string | null
  notes?: string | null
  /** JSON-массив PlacePhoto: фото установки / места (сжатые data URL). */
  place_photos_json?: string | null
}

export type FloorIconMarker = {
  id: string
  kind: FloorIconKind
  x: number
  y: number
  label?: string | null
  rotation?: number | null
  scale?: number | null
  meta?: FloorObjectMeta | null
}

export type FloorPoint = { x: number; y: number }

export type FloorWallPolyline = {
  id: string
  points: FloorPoint[]
  stroke?: string
  stroke_width?: number
  opacity?: number
}

export type FloorLayout = {
  version: number
  rooms: FloorRoomRect[]
  computers: FloorComputerMarker[]
  icons?: FloorIconMarker[]
  walls?: FloorWallPolyline[]
}

export type DiagramBinding = {
  id: number
  shape_id: string
  object_type: 'tag' | 'user' | 'computer' | 'monitor' | 'request'
  object_id: number
  label: string | null
}

export type LdapSyncEntry = {
  username: string
  created: boolean
  one_time_password: string | null
}

export type LdapSyncResult = {
  created_count: number
  skipped_count: number
  entries: LdapSyncEntry[]
  scanned_count?: number
  missing_username_attr?: number
}

export type Bitrix24ImportResult = {
  created: number
  updated: number
  skipped: number
  fetched: number
  items: { username: string; action: 'created' | 'updated' }[]
}

export type LdapConfig = {
  enabled: boolean
  allow_anonymous: boolean
  uri: string
  bind_dn: string
  bind_password_set: boolean
  user_search_base: string
  user_filter: string
  username_attr: string
  display_name_attr: string
  email_attr: string
  sync_limit: number
}

export type LdapTestResponse = {
  ok: boolean
  message: string
  found: number
  sample_dn: string | null
}

export type SoftwareItem = { name: string; version: string | null }

export type PeripheralItem = { kind: string; name: string }

export type DiskVolume = {
  mount: string
  label: string | null
  total_gb: number | null
  used_percent: number | null
  free_gb: number | null
}

export type TagBrief = { id: number; name: string; color: string | null }

export type RequestCategoryTreeNode = {
  id: number
  parent_id: number | null
  name: string
  path: string
  sort_order: number
  children: RequestCategoryTreeNode[]
}

export type Computer = {
  id: number
  hostname: string
  serial_number: string | null
  mac_primary: string | null
  ip_address?: string | null
  ping_status?: 'online' | 'offline' | 'unknown' | string | null
  last_ping_at?: string | null
  cpu: string | null
  ram_gb: number | null
  memory_used_percent: number | null
  gpu_name: string | null
  disks: DiskVolume[]
  os_name: string | null
  os_version: string | null
  manufacturer: string | null
  model: string | null
  motherboard_manufacturer?: string | null
  motherboard_product?: string | null
  last_report_at: string | null
  location: string | null
  notes: string | null
  assigned_user_id: number | null
  software_count: number
  peripheral_count: number
  tags: TagBrief[]
}

export type ComputerDetail = Computer & {
  software: SoftwareItem[]
  peripherals: PeripheralItem[]
  agent_extended?: Record<string, unknown> | null
}

export type AssetChangeLog = {
  id: number
  created_at: string
  source: string
  kind: string
  field_key: string | null
  old_value: string | null
  new_value: string | null
  payload_json: string | null
}

export type WolConfig = {
  enabled: boolean
  force_disabled: boolean
  allowlist_computer_ids: number[]
  wake_user_ids?: number[]
  cooldown_seconds: number
}

export type TlsStatus = {
  enabled: boolean
  active: boolean
  files_ready: boolean
  ca_ready: boolean
  hostnames: string[]
  not_after: string | null
  fingerprint_sha256: string | null
  generated_at: string | null
  restart_required: boolean
  dev_blocked?: boolean
  tls_dir: string
}

export type WolStatus = {
  enabled: boolean
  force_disabled: boolean
  allowlisted: boolean
  user_may_wake?: boolean
  has_mac: boolean
  cooldown_remaining_seconds: number | null
  can_wake: boolean
}

export type WolWakeResult = {
  ok: boolean
  computer_id: number
  hostname: string
  mac: string
  sent: number
  message: string
}

export type ComputerPingResult = {
  computer_id: number
  hostname: string
  ip_address: string | null
  online: boolean | null
  checked: boolean
  message: string
}

export type ComputerMapItem = {
  id: number
  hostname: string
  serial_number: string | null
  model: string | null
  os_name: string | null
  ram_gb: number | null
  ip_address: string | null
  ping_status?: string | null
  last_ping_at?: string | null
}

export type ComputerListResponse = { items: Computer[]; total: number }
export type ComputerMapListResponse = { items: ComputerMapItem[]; total: number }

export type DashboardNameCount = { name: string; count: number }

export type SoftwareCatalogRow = { name: string; count: number; version?: string | null }
export type CatalogKind = 'software' | 'peripheral' | 'cpu' | 'os' | 'manufacturer'
export type DashboardRamBucket = { label: string; count: number }
export type DashboardPeripheralKind = { kind: string; label: string; pc_count: number }

export type DashboardDiskDeviceRank = {
  hostname: string
  avg_used_percent: number
  volume_count: number
}

export type DashboardSegmentKind =
  | 'os'
  | 'manufacturer'
  | 'system_model'
  | 'ram'
  | 'cpu'
  | 'monitor'
  | 'physical_disk'
  | 'software'
  | 'peripheral'
  | 'peripheral_kind'
  | 'hostname'

export type DashboardSegmentComputer = {
  id: number
  hostname: string
  os_name?: string | null
  os_version?: string | null
  os_summary?: string | null
  ram_gb?: number | null
  cpu?: string | null
  manufacturer?: string | null
  model?: string | null
  location?: string | null
  volumes_summary?: string | null
  physical_disks_summary?: string | null
}

export type DashboardSegmentComputers = {
  kind: DashboardSegmentKind
  name: string
  chart_title?: string | null
  total: number
  items: DashboardSegmentComputer[]
}

export type DashboardSummary = {
  computers_total: number
  software_installations_total: number
  software_unique_titles: number
  tags_in_directory: number
  snmp_printers_total: number
  /** Устаревшее поле API (до разделения SNMP / парк ПК) */
  workstation_printers_total?: number
  service_requests_total: number
  service_requests_active: number
  service_requests_by_status: DashboardNameCount[]
  by_os: DashboardNameCount[]
  by_manufacturer: DashboardNameCount[]
  by_system_model: DashboardNameCount[]
  ram_buckets: DashboardRamBucket[]
  top_cpu: DashboardNameCount[]
  top_software: DashboardNameCount[]
  top_monitors: DashboardNameCount[]
  peripheral_kinds: DashboardPeripheralKind[]
  top_peripherals: DashboardNameCount[]
  top_disk_devices: DashboardDiskDeviceRank[]
  physical_disks_total: number
  physical_disks_by_media: DashboardNameCount[]
  physical_disks_by_size: DashboardRamBucket[]
  physical_disks_by_variant: DashboardNameCount[]
  top_users?: DashboardNameCount[]
}

export type ServiceRequestRow = {
  id: number
  ticket_no?: number | null
  glpi_id?: number | null
  title: string
  location?: string | null
  description: string | null
  status: string
  priority: string
  glpi_status?: string | null
  glpi_priority?: string | null
  glpi_updated_at?: string | null
  external_source?: string | null
  external_id?: string | null
  external_url?: string | null
  requester_name?: string | null
  category?: string | null
  created_by_id: number
  created_by_username: string
  assignee_ids: number[]
  assignee_usernames: string[]
  computer_id: number | null
  computer_hostname: string | null
  created_at: string
  updated_at: string
  opened_at?: string | null
  planned_close_at?: string | null
  closed_at?: string | null
}

export type ServiceRequestListResponse = { items: ServiceRequestRow[]; total: number }

export type ServiceRequestTemplateRow = {
  id: number
  title: string
  description: string | null
  status: string
  priority: string
  requester_name?: string | null
  category?: string | null
  computer_id: number | null
  assignee_ids: number[]
  assignee_usernames: string[]
  opened_at: string | null
  planned_close_at: string | null
  closed_at: string | null
  created_by_id: number
  created_by_username: string
  created_at: string
  updated_at: string
}

export type ServiceRequestTemplateListResponse = { items: ServiceRequestTemplateRow[]; total: number }

export type Bitrix24Config = {
  enabled: boolean
  incoming_secret: string
  default_priority: string
  default_category: string
}

export type Bitrix24IncomingRequest = {
  title?: string | null
  text?: string | null
  description?: string | null
  requester_name?: string | null
  location?: string | null
  category?: string | null
  priority?: string | null
  external_id?: string | null
  external_url?: string | null
}

export type DatabaseBackupStatus = {
  pg_dump_available: boolean
  pg_restore_available: boolean
  pg_dump_path: string | null
  pg_restore_path: string | null
  pg_bin_dir_configured: string | null
  engine: string
  database: string | null
  host: string | null
  port: number | null
  single_database: boolean
  counts: {
    computers: number
    service_requests: number
    users: number
  }
}

export type DatabaseRestoreResult = {
  ok: boolean
  database: string
  bytes: number
  warnings: boolean
  log_tail: string
  restart_recommended: boolean
}

/** Защита от устаревшего/обрезанного JSON: без этого React падает с белым экраном при undefined[].map */
function normalizeDashboardSummary(raw: DashboardSummary): DashboardSummary {
  return {
    computers_total: raw.computers_total ?? 0,
    software_installations_total: raw.software_installations_total ?? 0,
    software_unique_titles: raw.software_unique_titles ?? 0,
    tags_in_directory: raw.tags_in_directory ?? 0,
    snmp_printers_total: raw.snmp_printers_total ?? raw.workstation_printers_total ?? 0,
    service_requests_total: raw.service_requests_total ?? 0,
    service_requests_active: raw.service_requests_active ?? 0,
    service_requests_by_status: raw.service_requests_by_status ?? [],
    by_os: raw.by_os ?? [],
    by_manufacturer: raw.by_manufacturer ?? [],
    by_system_model: raw.by_system_model ?? [],
    ram_buckets: raw.ram_buckets ?? [],
    top_cpu: raw.top_cpu ?? [],
    top_software: raw.top_software ?? [],
    top_monitors: raw.top_monitors ?? [],
    peripheral_kinds: raw.peripheral_kinds ?? [],
    top_peripherals: raw.top_peripherals ?? [],
    top_disk_devices: Array.isArray(raw.top_disk_devices) ? raw.top_disk_devices : [],
    physical_disks_total: raw.physical_disks_total ?? 0,
    physical_disks_by_media: raw.physical_disks_by_media ?? [],
    physical_disks_by_size: raw.physical_disks_by_size ?? [],
    physical_disks_by_variant: raw.physical_disks_by_variant ?? [],
    top_users: Array.isArray(raw.top_users) ? raw.top_users : [],
  }
}

export type SoftwareInstallHosts = { name: string; hostnames: string[] }

export type AgentTokenRow = {
  id: number
  public_id_prefix: string
  label: string | null
  allowed_hostname: string | null
  created_at: string
  revoked_at: string | null
  last_used_at: string | null
}

export type AgentTokenCreated = AgentTokenRow & { token: string }

export type AgentBundleProfile = 'full' | 'custom'

export type AgentBundleLanIp = {
  ip: string | null
  candidates: string[]
}

export type AgentBundleTarget = 'win10' | 'win7' | 'cpp'

export type AgentBundleCreateBody = {
  server_url: string
  target?: AgentBundleTarget
  profile?: AgentBundleProfile
  create_token?: boolean
  token_label?: string | null
  allowed_hostname?: string | null
  existing_token?: string | null
  modules?: Partial<Record<string, boolean>>
  schedule?: {
    enabled?: boolean
    mode?: 'DAILY' | 'WEEKLY' | 'MONTHLY'
    time?: string
    weekday?: string
    task_name?: string
  }
}

export const api = {
  login: (username: string, password: string) =>
    request<{ ok: boolean; access_token: string | null }>(`${API_PREFIX}/auth/login/json`, {
      method: 'POST',
      json: { username, password, return_token: false },
    }),

  logout: () => request<{ ok: boolean }>(`${API_PREFIX}/auth/logout`, { method: 'POST' }),

  me: () => request<User>(`${API_PREFIX}/auth/me`),

  dashboardSummary: async () =>
    normalizeDashboardSummary(await request<DashboardSummary>(`${API_PREFIX}/dashboard/summary`)),

  softwareCatalog: (q?: string, limit?: number) => {
    const p = new URLSearchParams()
    if (q !== undefined && q !== '') p.set('q', q)
    if (limit != null) p.set('limit', String(limit))
    const qs = p.toString()
    return request<SoftwareCatalogRow[]>(
      `${API_PREFIX}/dashboard/software-catalog${qs ? `?${qs}` : ''}`,
    )
  },

  softwareHosts: (name: string) => {
    const p = new URLSearchParams()
    p.set('name', name)
    return request<SoftwareInstallHosts>(`${API_PREFIX}/dashboard/software-hosts?${p}`)
  },

  catalog: (kind: CatalogKind, q?: string, limit?: number) => {
    const p = new URLSearchParams()
    p.set('kind', kind)
    if (q !== undefined && q !== '') p.set('q', q)
    if (limit != null) p.set('limit', String(limit))
    return request<SoftwareCatalogRow[]>(`${API_PREFIX}/dashboard/catalog?${p}`)
  },

  catalogHosts: (kind: CatalogKind, name: string) => {
    const p = new URLSearchParams()
    p.set('kind', kind)
    p.set('name', name)
    return request<SoftwareInstallHosts>(`${API_PREFIX}/dashboard/catalog-hosts?${p}`)
  },

  dashboardSegmentComputers: (kind: DashboardSegmentKind, name: string, chartTitle?: string) => {
    const p = new URLSearchParams()
    p.set('kind', kind)
    p.set('name', name)
    if (chartTitle) p.set('chart_title', chartTitle)
    return request<DashboardSegmentComputers>(`${API_PREFIX}/dashboard/segment-computers?${p}`)
  },

  computers: async <V extends 'list' | 'map' | 'full' = 'list'>(
    opts?: {
      skip?: number
      limit?: number
      q?: string
      tag_ids?: number[]
      view?: V
      ping_status?: 'online' | 'offline' | 'unknown'
      sort?: 'last' | 'host' | 'ram' | 'periph'
      sort_dir?: 'asc' | 'desc'
    },
  ): Promise<V extends 'map' ? ComputerMapListResponse : ComputerListResponse> => {
    const p = new URLSearchParams()
    if (opts?.skip != null) p.set('skip', String(opts.skip))
    if (opts?.limit != null) p.set('limit', String(opts.limit))
    if (opts?.q) p.set('q', opts.q)
    for (const id of opts?.tag_ids ?? []) p.append('tag_ids', String(id))
    if (opts?.view) p.set('view', opts.view)
    if (opts?.ping_status) p.set('ping_status', opts.ping_status)
    if (opts?.sort) p.set('sort', opts.sort)
    if (opts?.sort_dir) p.set('sort_dir', opts.sort_dir)
    const qs = p.toString()
    if (opts?.view === 'map') {
      return (await request<ComputerMapListResponse>(
        `${API_PREFIX}/computers${qs ? `?${qs}` : ''}`,
      )) as V extends 'map' ? ComputerMapListResponse : ComputerListResponse
    }
    return (await request<ComputerListResponse>(
      `${API_PREFIX}/computers${qs ? `?${qs}` : ''}`,
    )) as V extends 'map' ? ComputerMapListResponse : ComputerListResponse
  },

  computer: (id: number, opts?: { includeSoftware?: boolean }) => {
    const p = new URLSearchParams()
    if (opts?.includeSoftware === false) p.set('include_software', 'false')
    const qs = p.toString()
    return request<ComputerDetail>(`${API_PREFIX}/computers/${id}${qs ? `?${qs}` : ''}`)
  },

  computerSoftware: (id: number) =>
    request<SoftwareItem[]>(`${API_PREFIX}/computers/${id}/software`),

  computerHistory: (id: number, limit?: number) => {
    const p = new URLSearchParams()
    if (limit != null) p.set('limit', String(limit))
    const qs = p.toString()
    return request<AssetChangeLog[]>(`${API_PREFIX}/computers/${id}/history${qs ? `?${qs}` : ''}`)
  },

  wolConfig: () => request<WolConfig>(`${API_PREFIX}/computers/wol/config`),

  updateWolConfig: (body: {
    enabled?: boolean
    allowlist_computer_ids?: number[]
    wake_user_ids?: number[]
    cooldown_seconds?: number
  }) => request<WolConfig>(`${API_PREFIX}/computers/wol/config`, { method: 'PUT', json: body }),

  tlsStatus: () => request<TlsStatus>(`${API_PREFIX}/settings/tls`),
  tlsGenerate: (body: { hostnames: string[]; days?: number; rotate_ca?: boolean }) =>
    request<TlsStatus>(`${API_PREFIX}/settings/tls/generate`, { method: 'POST', json: body }),
  tlsEnable: (enabled: boolean) =>
    request<TlsStatus>(`${API_PREFIX}/settings/tls/enable`, { method: 'POST', json: { enabled } }),
  downloadTlsCa: async (): Promise<void> => {
    const headers = new Headers()
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(apiUrl(`${API_PREFIX}/settings/tls/ca.crt`), {
      credentials: 'include',
      headers,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = (err as { detail?: string }).detail ?? res.statusText
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'corax-local-ca.crt'
    a.click()
    URL.revokeObjectURL(url)
  },

  computerWolStatus: (id: number) =>
    request<WolStatus>(`${API_PREFIX}/computers/${id}/wol-status`),

  setComputerWolAllow: (id: number, allowed: boolean) =>
    request<WolStatus>(`${API_PREFIX}/computers/${id}/wol-allow`, {
      method: 'PUT',
      json: { allowed },
    }),

  pingComputer: (id: number) =>
    request<ComputerPingResult>(`${API_PREFIX}/computers/${id}/ping`, { method: 'POST' }),

  computersPingStatus: (kick = false) =>
    request<{
      items: Array<{
        id: number
        ping_status: string | null
        last_ping_at: string | null
        ip_address: string | null
      }>
      sweep: { started?: boolean; reason?: string; mode?: string } | null
    }>(`${API_PREFIX}/computers/ping-status${kick ? '?kick=true' : ''}`),

  computersPingSweep: () =>
    request<{ started: boolean; reason: string; mode: string }>(`${API_PREFIX}/computers/ping-sweep`, {
      method: 'POST',
    }),

  wakeComputer: (id: number) =>
    request<WolWakeResult>(`${API_PREFIX}/computers/${id}/wake`, { method: 'POST' }),

  updateComputer: (
    id: number,
    body: {
      notes?: string | null
      location?: string | null
      assigned_user_id?: number | null
      tag_ids?: number[] | null
    },
  ) => request<Computer>(`${API_PREFIX}/computers/${id}`, { method: 'PATCH', json: body }),

  exportComputersCsv: async (opts?: { q?: string; tag_ids?: number[] }) => {
    const p = new URLSearchParams()
    if (opts?.q) p.set('q', opts.q)
    for (const id of opts?.tag_ids ?? []) p.append('tag_ids', String(id))
    const qs = p.toString()
    const headers = new Headers()
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(`${API_BASE}${API_PREFIX}/computers/export.csv${qs ? `?${qs}` : ''}`, {
      credentials: 'include',
      headers,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = (err as { detail?: string }).detail ?? res.statusText
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `computers_export_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  },

  exportGlpiPcsCsv: async () => {
    const headers = new Headers()
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(apiUrl(`${API_PREFIX}/computers/export-glpi-pcs.csv`), { credentials: 'include', headers })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = (err as { detail?: string }).detail ?? res.statusText
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'glpi_pcs_export.csv'
    a.click()
    URL.revokeObjectURL(url)
  },

  importGlpiPcsCsv: async (file: File) => {
    const fd = new FormData()
    fd.set('file', file)
    const headers = new Headers()
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(apiUrl(`${API_PREFIX}/computers/import-glpi-pcs-csv`), {
      method: 'POST',
      credentials: 'include',
      headers,
      body: fd,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = (err as { detail?: string }).detail ?? res.statusText
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    return (await res.json()) as {
      filename: string
      saved_as: string
      rows_total: number
      unique_names: number
      created: number
      updated: number
      skipped: number
    }
  },

  monitors: (opts?: { assigned_user_id?: number; limit?: number }) => {
    const p = new URLSearchParams()
    if (opts?.assigned_user_id != null) p.set('assigned_user_id', String(opts.assigned_user_id))
    if (opts?.limit != null) p.set('limit', String(opts.limit))
    const qs = p.toString()
    return request<Monitor[]>(`${API_PREFIX}/monitors${qs ? `?${qs}` : ''}`)
  },

  importGlpiMonitorsCsv: async (file: File) => {
    const fd = new FormData()
    fd.set('file', file)
    const headers = new Headers()
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(apiUrl(`${API_PREFIX}/monitors/import-glpi-csv`), {
      method: 'POST',
      credentials: 'include',
      headers,
      body: fd,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = (err as { detail?: string }).detail ?? res.statusText
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    return (await res.json()) as {
      ok: boolean
      filename: string
      rows_total: number
      created: number
      updated: number
      skipped: number
      linked_users: number
      unlinked_rows: number
    }
  },

  diagrams: () => request<Diagram[]>(`${API_PREFIX}/diagrams`),

  diagramSvgUrl: (id: number) => apiUrl(`${API_PREFIX}/diagrams/${id}/svg`),

  diagramPngUrl: (id: number) => apiUrl(`${API_PREFIX}/diagrams/${id}/png`),

  diagramExportSvgUrl: (id: number, opts?: { include_labels?: boolean }) =>
    apiUrl(
      `${API_PREFIX}/diagrams/${id}/export.svg${
        opts?.include_labels === false ? '?include_labels=false' : ''
      }`,
    ),

  diagramExportPngUrl: (id: number, opts?: { include_labels?: boolean }) =>
    apiUrl(
      `${API_PREFIX}/diagrams/${id}/export.png${
        opts?.include_labels === false ? '?include_labels=false' : ''
      }`,
    ),

  diagramExportPdfUrl: (id: number, opts?: { include_labels?: boolean }) =>
    apiUrl(
      `${API_PREFIX}/diagrams/${id}/export.pdf${
        opts?.include_labels === false ? '?include_labels=false' : ''
      }`,
    ),

  diagramExportJson: (id: number) =>
    request<{ diagram_id: number; title: string; viewBox: string | null; layout: FloorLayout }>(
      `${API_PREFIX}/diagrams/${id}/export.json`,
    ),

  exportFloorsJson: () => request<{ version: number; floors: unknown[] }>(`${API_PREFIX}/diagrams/export-floors.json`),

  importFloorsJson: async (file: File) => {
    const fd = new FormData()
    fd.set('file', file)
    const headers = new Headers()
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(apiUrl(`${API_PREFIX}/diagrams/import-floors-json`), {
      method: 'POST',
      credentials: 'include',
      headers,
      body: fd,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = (err as { detail?: string }).detail ?? res.statusText
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    return (await res.json()) as { ok: boolean; created: number }
  },

  diagramBindings: (id: number) => request<DiagramBinding[]>(`${API_PREFIX}/diagrams/${id}/bindings`),

  replaceDiagramBindings: (id: number, bindings: Array<Omit<DiagramBinding, 'id'>>) =>
    request<{ ok: boolean; count: number }>(`${API_PREFIX}/diagrams/${id}/bindings`, {
      method: 'PUT',
      json: bindings.map((b) => ({
        shape_id: b.shape_id,
        object_type: b.object_type,
        object_id: b.object_id,
        label: b.label,
      })),
    }),

  importVisioDiagram: async (file: File) => {
    const fd = new FormData()
    fd.set('file', file)
    const headers = new Headers()
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(apiUrl(`${API_PREFIX}/diagrams/import-visio`), {
      method: 'POST',
      credentials: 'include',
      headers,
      body: fd,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = (err as { detail?: string }).detail ?? res.statusText
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    return (await res.json()) as { ok: boolean; diagram_id: number; title: string }
  },

  importDiagramBackgroundPng: async (file: File) => {
    const fd = new FormData()
    fd.set('file', file)
    const headers = new Headers()
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(apiUrl(`${API_PREFIX}/diagrams/import-background-png`), {
      method: 'POST',
      credentials: 'include',
      headers,
      body: fd,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = (err as { detail?: string }).detail ?? res.statusText
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    return (await res.json()) as Diagram
  },

  replaceDiagramBackgroundPng: async (id: number, file: File) => {
    const fd = new FormData()
    fd.set('file', file)
    const headers = new Headers()
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(apiUrl(`${API_PREFIX}/diagrams/${id}/background-png`), {
      method: 'PUT',
      credentials: 'include',
      headers,
      body: fd,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = (err as { detail?: string }).detail ?? res.statusText
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    return (await res.json()) as Diagram
  },

  deleteDiagram: (id: number) => request<{ ok: boolean }>(`${API_PREFIX}/diagrams/${id}`, { method: 'DELETE' }),

  createBlankFloor: (body?: { title?: string | null; sort_order?: number | null }) =>
    request<Diagram>(`${API_PREFIX}/diagrams/floor-blank`, { method: 'POST', json: body ?? {} }),

  diagramLayout: (id: number) => request<FloorLayout>(`${API_PREFIX}/diagrams/${id}/layout`),

  saveDiagramLayout: (id: number, layout: FloorLayout) =>
    request<{ ok: boolean }>(`${API_PREFIX}/diagrams/${id}/layout`, { method: 'PUT', json: layout }),

  patchDiagramLayout: (
    id: number,
    patch: {
      rooms?: FloorRoomRect[]
      computers?: FloorComputerMarker[]
      icons?: FloorIconMarker[]
      walls?: FloorWallPolyline[]
    },
  ) => request<{ ok: boolean }>(`${API_PREFIX}/diagrams/${id}/layout`, { method: 'PATCH', json: patch }),

  patchDiagram: (id: number, body: { title?: string; sort_order?: number }) =>
    request<Diagram>(`${API_PREFIX}/diagrams/${id}`, { method: 'PATCH', json: body }),

  tags: () => request<TagBrief[]>(`${API_PREFIX}/tags`),

  createTag: (body: { name: string; color?: string | null }) =>
    request<TagBrief>(`${API_PREFIX}/tags`, { method: 'POST', json: body }),

  updateTag: (id: number, body: { name?: string; color?: string | null }) =>
    request<TagBrief>(`${API_PREFIX}/tags/${id}`, { method: 'PATCH', json: body }),

  deleteTag: (id: number) => request<void>(`${API_PREFIX}/tags/${id}`, { method: 'DELETE' }),

  requestCategories: () => request<RequestCategoryTreeNode[]>(`${API_PREFIX}/request-categories`),

  requestCategoryPaths: () => request<string[]>(`${API_PREFIX}/request-categories/paths`),

  createRequestCategory: (body: { name: string; parent_id?: number | null }) =>
    request<RequestCategoryTreeNode>(`${API_PREFIX}/request-categories`, { method: 'POST', json: body }),

  updateRequestCategory: (id: number, body: { name?: string; parent_id?: number | null; sort_order?: number }) =>
    request<RequestCategoryTreeNode>(`${API_PREFIX}/request-categories/${id}`, { method: 'PATCH', json: body }),

  deleteRequestCategory: (id: number) =>
    request<void>(`${API_PREFIX}/request-categories/${id}`, { method: 'DELETE' }),

  deleteComputer: (id: number) => request<void>(`${API_PREFIX}/computers/${id}`, { method: 'DELETE' }),

  users: () => request<User[]>(`${API_PREFIX}/users`),

  setUserAdmin: (id: number, is_superuser: boolean) =>
    request<User>(`${API_PREFIX}/users/${id}/admin`, { method: 'PATCH', json: { is_superuser } }),

  setUserRole: (id: number, role: 'observer' | 'editor') =>
    request<User>(`${API_PREFIX}/users/${id}/role`, { method: 'PATCH', json: { role } }),

  deleteUser: (id: number) =>
    request<{ ok: boolean }>(`${API_PREFIX}/users/${id}/delete`, { method: 'POST' }),

  usersDirectory: () => request<UserDirectoryItem[]>(`${API_PREFIX}/users/directory`),

  // LDAP sync/status live under /users router in backend.
  ldapStatus: () => request<{ configured: boolean }>(`${API_PREFIX}/users/admin/ldap/status`),

  ldapSync: () =>
    request<LdapSyncResult>(`${API_PREFIX}/users/admin/ldap/sync`, {
      method: 'POST',
      timeout_ms: 180_000,
    }),

  bitrix24ImportUsers: () =>
    request<Bitrix24ImportResult>(`${API_PREFIX}/users/admin/bitrix24/import`, {
      method: 'POST',
      timeout_ms: 120_000,
    }),

  ldapConfig: () => request<LdapConfig>(`${API_PREFIX}/settings/ldap`),

  updateLdapConfig: (body: {
    enabled?: boolean
    allow_anonymous?: boolean
    uri?: string
    bind_dn?: string
    bind_password?: string | null
    user_search_base?: string
    user_filter?: string
    username_attr?: string
    display_name_attr?: string
    email_attr?: string
    sync_limit?: number
  }) => request<LdapConfig>(`${API_PREFIX}/settings/ldap`, { method: 'PUT', json: body }),

  bitrix24Config: () => request<Bitrix24Config>(`${API_PREFIX}/settings/bitrix24`),

  updateBitrix24Config: (body: Partial<Bitrix24Config>) =>
    request<Bitrix24Config>(`${API_PREFIX}/settings/bitrix24`, { method: 'PUT', json: body }),

  bitrix24IncomingTest: (body: Bitrix24IncomingRequest) =>
    request<{ ok: boolean; request_id: number }>(`${API_PREFIX}/integrations/bitrix24/incoming/test`, {
      method: 'POST',
      json: body,
    }),

  databaseBackupStatus: () => request<DatabaseBackupStatus>(`${API_PREFIX}/settings/database/status`),

  exportDatabaseDump: async () => {
    const headers = new Headers()
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(apiUrl(`${API_PREFIX}/settings/database/export`), {
      credentials: 'include',
      headers,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = (err as { detail?: string }).detail ?? res.statusText
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    const blob = await res.blob()
    const cd = res.headers.get('content-disposition') ?? ''
    const m = /filename="([^"]+)"/i.exec(cd)
    const filename = m?.[1] ?? `corax-backup-${new Date().toISOString().slice(0, 10)}.dump`
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  },

  importDatabaseDump: async (file: File, confirm: string) => {
    const fd = new FormData()
    fd.set('file', file)
    fd.set('confirm', confirm)
    const headers = new Headers()
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(apiUrl(`${API_PREFIX}/settings/database/import`), {
      method: 'POST',
      credentials: 'include',
      headers,
      body: fd,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = (err as { detail?: string }).detail ?? res.statusText
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    return (await res.json()) as DatabaseRestoreResult
  },

  testLdapConfig: (body: {
    allow_anonymous?: boolean
    uri?: string
    bind_dn?: string
    bind_password?: string
    user_search_base?: string
    user_filter?: string
    username_attr?: string
    display_name_attr?: string
    email_attr?: string
    probe_username?: string | null
  }) =>
    request<LdapTestResponse>(`${API_PREFIX}/settings/ldap/test`, {
      method: 'POST',
      json: body,
      timeout_ms: 60_000,
    }),

  createUser: (body: {
    username: string
    password: string
    email?: string | null
    full_name?: string | null
    is_superuser?: boolean
    role?: 'observer' | 'editor'
  }) => request<User>(`${API_PREFIX}/users`, { method: 'POST', json: body }),

  changeMyPassword: (body: { current_password: string; new_password: string }) =>
    request<{ ok: boolean }>(`${API_PREFIX}/users/me/change-password`, { method: 'POST', json: body }),

  updateMyProfile: (body: {
    username?: string
    full_name?: string | null
    email?: string | null
    avatar_data?: string | null
  }) => request<User>(`${API_PREFIX}/users/me/profile`, { method: 'PATCH', json: body }),

  updateUser: (
    id: number,
    body: { username?: string; full_name?: string | null; email?: string | null; password?: string },
  ) => request<User>(`${API_PREFIX}/users/${id}`, { method: 'PATCH', json: body }),

  agentTokens: () => request<AgentTokenRow[]>(`${API_PREFIX}/agent-tokens`),

  createAgentToken: (body: { label?: string | null; allowed_hostname?: string | null }) =>
    request<AgentTokenCreated>(`${API_PREFIX}/agent-tokens`, { method: 'POST', json: body }),

  revokeAgentToken: (id: number) =>
    request<void>(`${API_PREFIX}/agent-tokens/${id}`, { method: 'DELETE' }),

  agentBundleLanIp: async (): Promise<AgentBundleLanIp> => {
    try {
      return await request<AgentBundleLanIp>(`${API_PREFIX}/agent-bundles/lan-ip`)
    } catch {
      const h = await request<{ lan_ip?: string | null; lan_ips?: string[] }>(`${API_PREFIX}/health`)
      return { ip: h.lan_ip ?? null, candidates: h.lan_ips ?? [] }
    }
  },

  downloadAgentBundle: async (body: AgentBundleCreateBody): Promise<string> => {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(apiUrl(`${API_PREFIX}/agent-bundles`), {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const j = (await res.json()) as { detail?: string }
        if (j.detail) detail = String(j.detail)
      } catch {
        // ignore
      }
      throw new Error(detail)
    }
    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') ?? ''
    const m = /filename="([^"]+)"/i.exec(cd)
    const filename = m?.[1] ?? 'corax-agent-win10.zip'
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    return filename
  },

  serviceRequests: (opts?: { status?: string; limit?: number }) => {
    const p = new URLSearchParams()
    if (opts?.status) p.set('status', opts.status)
    if (opts?.limit != null) p.set('limit', String(opts.limit))
    const qs = p.toString()
    return request<ServiceRequestListResponse>(
      `${API_PREFIX}/service-requests${qs ? `?${qs}` : ''}`,
    )
  },

  createServiceRequest: (body: {
    title: string
    description?: string | null
    status?: string
    priority?: string
    location?: string | null
    requester_name?: string | null
    category?: string | null
    computer_id?: number | null
    assignee_ids?: number[]
    opened_at?: string | null
    planned_close_at?: string | null
    closed_at?: string | null
  }) => request<ServiceRequestRow>(`${API_PREFIX}/service-requests`, { method: 'POST', json: body }),

  updateServiceRequest: (
    id: number,
    body: {
      title?: string
      description?: string | null
      status?: string
      priority?: string
      location?: string | null
      requester_name?: string | null
      category?: string | null
      computer_id?: number | null
      assignee_ids?: number[]
      opened_at?: string | null
      planned_close_at?: string | null
      closed_at?: string | null
    },
  ) => request<ServiceRequestRow>(`${API_PREFIX}/service-requests/${id}`, { method: 'PATCH', json: body }),

  deleteServiceRequest: (id: number) =>
    request<void>(`${API_PREFIX}/service-requests/${id}/delete`, { method: 'POST' }),

  exportServiceRequestsPdf: async (opts?: { status?: string | null; limit?: number }) => {
    const p = new URLSearchParams()
    if (opts?.status) p.set('status', opts.status)
    if (opts?.limit != null) p.set('limit', String(opts.limit))
    const qs = p.toString()
    const path = `${API_PREFIX}/service-requests/export-pdf${qs ? `?${qs}` : ''}`
    const headers = new Headers()
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(apiUrl(path), { credentials: 'include', headers })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = (err as { detail?: string }).detail ?? res.statusText
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'service_requests_report.pdf'
    a.click()
    URL.revokeObjectURL(url)
  },

  importServiceRequestsGlpiCsv: async (file: File) => {
    const fd = new FormData()
    fd.set('file', file)
    const headers = new Headers()
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(apiUrl(`${API_PREFIX}/service-requests/import-glpi-csv`), {
      method: 'POST',
      credentials: 'include',
      headers,
      body: fd,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = (err as { detail?: string }).detail ?? res.statusText
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    return (await res.json()) as {
      ok: boolean
      created: number
      updated: number
      skipped: number
      errors: string[]
    }
  },

  exportServiceRequestsGlpiCsv: async (opts?: { status?: string | null }) => {
    const p = new URLSearchParams()
    if (opts?.status) p.set('status', opts.status)
    const qs = p.toString()
    const path = `${API_PREFIX}/service-requests/export-glpi-csv${qs ? `?${qs}` : ''}`
    const headers = new Headers()
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(apiUrl(path), { credentials: 'include', headers })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = (err as { detail?: string }).detail ?? res.statusText
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'glpi.csv'
    a.click()
    URL.revokeObjectURL(url)
  },

  serviceRequestTemplates: (opts?: { limit?: number }) => {
    const p = new URLSearchParams()
    if (opts?.limit != null) p.set('limit', String(opts.limit))
    const qs = p.toString()
    return request<ServiceRequestTemplateListResponse>(
      `${API_PREFIX}/service-requests/templates${qs ? `?${qs}` : ''}`,
    )
  },

  createServiceRequestTemplate: (body: {
    title: string
    description?: string | null
    status?: string
    priority?: string
    requester_name?: string | null
    category?: string | null
    computer_id?: number | null
    assignee_ids?: number[]
    opened_at?: string | null
    planned_close_at?: string | null
    closed_at?: string | null
  }) => request<ServiceRequestTemplateRow>(`${API_PREFIX}/service-requests/templates`, { method: 'POST', json: body }),

  updateServiceRequestTemplate: (
    id: number,
    body: {
      title?: string
      description?: string | null
      status?: string
      priority?: string
      requester_name?: string | null
      category?: string | null
      computer_id?: number | null
      assignee_ids?: number[] | null
      opened_at?: string | null
      planned_close_at?: string | null
      closed_at?: string | null
    },
  ) =>
    request<ServiceRequestTemplateRow>(`${API_PREFIX}/service-requests/templates/${id}`, {
      method: 'PATCH',
      json: body,
    }),

  deleteServiceRequestTemplate: (id: number) =>
    request<void>(`${API_PREFIX}/service-requests/templates/${id}/delete`, { method: 'POST' }),

  wikiRagDocuments: () => request<WikiRagDocumentRow[]>(`${API_PREFIX}/wiki-rag`),

  wikiRagFileUrl: (id: number) => apiUrl(`${API_PREFIX}/wiki-rag/${id}/file`),

  uploadWikiRagDocument: async (file: File, comment?: string | null) => {
    const fd = new FormData()
    fd.set('file', file)
    if (comment?.trim()) fd.set('comment', comment.trim())
    const headers = new Headers()
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const res = await fetch(apiUrl(`${API_PREFIX}/wiki-rag`), {
      method: 'POST',
      credentials: 'include',
      headers,
      body: fd,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = (err as { detail?: string }).detail ?? res.statusText
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    return (await res.json()) as WikiRagDocumentRow
  },

  updateWikiRagDocument: (id: number, body: { comment?: string | null }) =>
    request<WikiRagDocumentRow>(`${API_PREFIX}/wiki-rag/${id}`, { method: 'PATCH', json: body }),

  deleteWikiRagDocument: (id: number) =>
    request<void>(`${API_PREFIX}/wiki-rag/${id}`, { method: 'DELETE' }),

  wikiRagDocumentContent: (id: number) =>
    request<WikiRagDocContent>(`${API_PREFIX}/wiki-rag/${id}/content`),

  saveWikiRagDocumentContent: (id: number, content: string) =>
    request<WikiRagDocContent>(`${API_PREFIX}/wiki-rag/${id}/content`, {
      method: 'PUT',
      json: { content },
    }),

  wikiRagLmStudioStatus: (params?: { base_url?: string; model?: string }) => {
    const sp = new URLSearchParams()
    if (params?.base_url) sp.set('base_url', params.base_url)
    if (params?.model) sp.set('model', params.model)
    const qs = sp.toString()
    return request<WikiRagLmStudioStatus>(`${API_PREFIX}/wiki-rag/lm-studio/status${qs ? `?${qs}` : ''}`)
  },

  importWikiRagCorax: () =>
    request<WikiRagCoraxImportResult>(`${API_PREFIX}/wiki-rag/import/corax`, {
      method: 'POST',
      timeout_ms: WIKIRAG_IMPORT_TIMEOUT_MS,
    }),

  wikiRagChat: (body: {
    message: string
    document_ids?: number[] | null
    history?: { role: 'user' | 'assistant'; content: string }[]
    lm_base_url?: string | null
    lm_model?: string | null
    include_corax?: boolean
  }) =>
    request<WikiRagChatResponse>(`${API_PREFIX}/wiki-rag/chat`, {
      method: 'POST',
      json: body,
      timeout_ms: WIKIRAG_LM_TIMEOUT_MS,
    }),

  wikiRagChatPreview: (body: {
    message: string
    document_ids?: number[] | null
    history?: { role: 'user' | 'assistant'; content: string }[]
  }) =>
    request<WikiRagChatPreview>(`${API_PREFIX}/wiki-rag/chat/preview`, {
      method: 'POST',
      json: body,
      timeout_ms: WIKIRAG_LM_TIMEOUT_MS,
    }),

  warehousePresets: () => request<WarehousePreset[]>(`${API_PREFIX}/warehouse/presets`),

  warehouseRooms: () => request<WarehouseRoom[]>(`${API_PREFIX}/warehouse/rooms`),

  createWarehouseRoom: (body: { title: string; notes?: string | null }) =>
    request<WarehouseRoom>(`${API_PREFIX}/warehouse/rooms`, { method: 'POST', json: body }),

  patchWarehouseRoom: (id: number, body: { title?: string; notes?: string | null; sort_order?: number }) =>
    request<WarehouseRoom>(`${API_PREFIX}/warehouse/rooms/${id}`, { method: 'PATCH', json: body }),

  deleteWarehouseRoom: (id: number) =>
    request<void>(`${API_PREFIX}/warehouse/rooms/${id}`, { method: 'DELETE' }),

  warehouseItems: (params?: { room_id?: number; status?: string; preset_key?: string; q?: string }) => {
    const sp = new URLSearchParams()
    if (params?.room_id != null) sp.set('room_id', String(params.room_id))
    if (params?.status) sp.set('status', params.status)
    if (params?.preset_key) sp.set('preset_key', params.preset_key)
    if (params?.q) sp.set('q', params.q)
    const qs = sp.toString()
    return request<WarehouseStockItem[]>(`${API_PREFIX}/warehouse/items${qs ? `?${qs}` : ''}`)
  },

  createWarehouseItem: (body: WarehouseStockItemCreate) =>
    request<WarehouseStockItem>(`${API_PREFIX}/warehouse/items`, { method: 'POST', json: body }),

  patchWarehouseItem: (id: number, body: Partial<WarehouseStockItemCreate>) =>
    request<WarehouseStockItem>(`${API_PREFIX}/warehouse/items/${id}`, { method: 'PATCH', json: body }),

  transferWarehouseItem: (id: number, body: { to_room_id: number; comment?: string | null }) =>
    request<WarehouseStockItem>(`${API_PREFIX}/warehouse/items/${id}/transfer`, { method: 'POST', json: body }),

  writeOffWarehouseItem: (id: number, comment?: string | null) => {
    const sp = comment ? `?comment=${encodeURIComponent(comment)}` : ''
    return request<WarehouseStockItem>(`${API_PREFIX}/warehouse/items/${id}/write-off${sp}`, { method: 'POST' })
  },

  deleteWarehouseItem: (id: number) =>
    request<void>(`${API_PREFIX}/warehouse/items/${id}`, { method: 'DELETE' }),

  warehouseMovements: (params?: { item_id?: number; room_id?: number; limit?: number }) => {
    const sp = new URLSearchParams()
    if (params?.item_id != null) sp.set('item_id', String(params.item_id))
    if (params?.room_id != null) sp.set('room_id', String(params.room_id))
    if (params?.limit != null) sp.set('limit', String(params.limit))
    const qs = sp.toString()
    return request<WarehouseMovement[]>(`${API_PREFIX}/warehouse/movements${qs ? `?${qs}` : ''}`)
  },

  warehouseNextCode: () => request<{ internal_code: string }>(`${API_PREFIX}/warehouse/next-code`),

  printers: (params?: { q?: string; poll_status?: string; limit?: number; view?: 'full' | 'map' }) => {
    const sp = new URLSearchParams()
    if (params?.q) sp.set('q', params.q)
    if (params?.poll_status) sp.set('poll_status', params.poll_status)
    if (params?.limit != null) sp.set('limit', String(params.limit))
    if (params?.view) sp.set('view', params.view)
    const qs = sp.toString()
    return request<NetworkPrinter[]>(`${API_PREFIX}/printers${qs ? `?${qs}` : ''}`)
  },

  createPrinter: (body: NetworkPrinterCreate) =>
    request<NetworkPrinter>(`${API_PREFIX}/printers`, { method: 'POST', json: body }),

  patchPrinter: (id: number, body: { location?: string | null; notes?: string | null; ip_address?: string | null }) =>
    request<NetworkPrinter>(`${API_PREFIX}/printers/${id}`, { method: 'PATCH', json: body }),

  deletePrinter: (id: number) => request<void>(`${API_PREFIX}/printers/${id}`, { method: 'DELETE' }),

  bulkDeletePrinters: (ids: number[]) =>
    request<void>(`${API_PREFIX}/printers/bulk-delete`, { method: 'POST', json: { ids } }),

  cleanupPrinters: () =>
    request<PrinterCleanupResult>(`${API_PREFIX}/printers/cleanup`, { method: 'POST' }),

  discoverSnmpPrinters: () =>
    request<PrinterSnmpDiscoveryResult>(`${API_PREFIX}/printers/discover-snmp`, {
      method: 'POST',
      timeout_ms: 120_000,
    }),

  pollAllPrinters: () =>
    request<PrinterPollResult>(`${API_PREFIX}/printers/poll`, { method: 'POST', timeout_ms: 180_000 }),

  pollPrinter: (id: number) =>
    request<NetworkPrinter>(`${API_PREFIX}/printers/${id}/poll`, { method: 'POST' }),

  printerPollConfig: () => request<PrinterPollConfig>(`${API_PREFIX}/printers/poll-config`),

  updatePrinterPollConfig: (body: Partial<PrinterPollConfigUpdate>) =>
    request<PrinterPollConfig>(`${API_PREFIX}/printers/poll-config`, { method: 'PUT', json: body }),

  printerSchedulerStatus: () =>
    request<PrinterSchedulerStatus>(`${API_PREFIX}/printers/scheduler-status`),

  networkDevices: (params?: { q?: string; device_type?: string; role?: string; limit?: number }) => {
    const sp = new URLSearchParams()
    if (params?.q) sp.set('q', params.q)
    if (params?.device_type) sp.set('device_type', params.device_type)
    if (params?.role) sp.set('role', params.role)
    if (params?.limit != null) sp.set('limit', String(params.limit))
    const qs = sp.toString()
    return request<NetworkDevice[]>(`${API_PREFIX}/network/devices${qs ? `?${qs}` : ''}`)
  },

  networkDevice: (id: number) =>
    request<NetworkDevice>(`${API_PREFIX}/network/devices/${id}`),

  createNetworkDevice: (body: NetworkDeviceCreate) =>
    request<NetworkDevice>(`${API_PREFIX}/network/devices`, { method: 'POST', json: body }),

  patchNetworkDevice: (
    id: number,
    body: {
      hostname?: string | null
      device_type?: string | null
      location?: string | null
      notes?: string | null
      ip_address?: string | null
    },
  ) => request<NetworkDevice>(`${API_PREFIX}/network/devices/${id}`, { method: 'PATCH', json: body }),

  deleteNetworkDevice: (id: number) =>
    request<void>(`${API_PREFIX}/network/devices/${id}`, { method: 'DELETE' }),

  bulkDeleteNetworkDevices: (ids: number[]) =>
    request<void>(`${API_PREFIX}/network/devices/bulk-delete`, { method: 'POST', json: { ids } }),

  discoverNetworkDevices: () =>
    request<NetworkJobStatus>(`${API_PREFIX}/network/discover`, {
      method: 'POST',
      timeout_ms: 30_000,
    }),

  pollAllNetworkDevices: () =>
    request<NetworkJobStatus>(`${API_PREFIX}/network/poll`, { method: 'POST', timeout_ms: 30_000 }),

  networkJobStatus: () => request<NetworkJobStatus>(`${API_PREFIX}/network/job-status`),

  pollNetworkDevice: (id: number) =>
    request<NetworkDevice>(`${API_PREFIX}/network/devices/${id}/poll`, {
      method: 'POST',
      timeout_ms: 60_000,
    }),

  networkPollConfig: () => request<NetworkPollConfig>(`${API_PREFIX}/network/poll-config`),

  updateNetworkPollConfig: (body: Partial<NetworkPollConfigUpdate>) =>
    request<NetworkPollConfig>(`${API_PREFIX}/network/poll-config`, { method: 'PUT', json: body }),

  networkTopology: () => request<NetworkTopology>(`${API_PREFIX}/network/topology`),
}

export type WikiRagDocumentRow = {
  id: number
  original_filename: string
  mime_type: string | null
  size_bytes: number
  comment: string | null
  uploaded_by_id: number
  uploaded_by_username: string
  created_at: string
  updated_at: string
}

export type WikiRagDocContent = {
  id: number
  original_filename: string
  kind: string
  editable: boolean
  content: string | null
  preview_url: string | null
  truncated: boolean
  hint: string | null
}

export type WikiRagLmStudioStatus = {
  ok: boolean
  models: string[]
  detail?: string | null
  selected_model?: string | null
  base_url?: string | null
}

export type WikiRagCoraxImportResult = {
  document: WikiRagDocumentRow
  documents?: WikiRagDocumentRow[]
  computers: number
  requests: number
  tags: number
  chars: number
  files?: number
  created: boolean
}

export type WikiRagChatParsed = {
  answer?: string
  confidence?: 'low' | 'medium' | 'high' | string
  sources?: { document_id: number; filename: string; excerpt: string }[]
  follow_up_questions?: string[]
  suggested_actions?: { type: string; label: string; detail: string }[]
}

export type WikiRagChatResponse = {
  ok: boolean
  raw?: string | null
  parsed?: WikiRagChatParsed | null
  model?: string | null
  error?: string | null
  meta?: {
    mode?: string
    total_chars?: number
    documents?: { id: number; filename: string; chars: number }[]
    corax?: { computers?: number; requests?: number; tags?: number; chars?: number }
    lm_base_url?: string
    proxy_bypass?: boolean
  } | null
}

export type WikiRagChatPreview = {
  mode: string
  documents: { id: number; filename: string; chars: number }[]
  messages: { role: string; content: string }[]
  total_chars: number
  hint?: string | null
}

export type WarehousePreset = {
  key: string
  name: string
  group: 'components' | 'network' | 'other' | string
  default_tracking: 'unit' | 'lot' | string
}

export type WarehouseRoom = {
  id: number
  title: string
  sort_order: number
  notes: string | null
  item_count: number
  created_at: string | null
  updated_at: string | null
}

export type WarehouseStockItem = {
  id: number
  room_id: number
  preset_key: string
  preset_name: string | null
  name: string
  tracking_mode: 'unit' | 'lot' | string
  quantity: number
  quantity_available: number
  internal_code: string | null
  status: string
  condition: 'new' | 'used' | 'defective' | string
  serial_number: string | null
  batch_label: string | null
  attributes_json: string | null
  notes: string | null
  created_by_id: number | null
  created_at: string | null
  updated_at: string | null
}

export type WarehouseStockItemCreate = {
  room_id: number
  preset_key?: string
  name: string
  tracking_mode?: 'unit' | 'lot'
  quantity?: number
  internal_code?: string | null
  condition?: 'new' | 'used' | 'defective'
  serial_number?: string | null
  batch_label?: string | null
  attributes_json?: string | null
  notes?: string | null
  auto_code?: boolean
}

export type WarehouseMovement = {
  id: number
  item_id: number
  movement_kind: string
  quantity: number
  from_room_id: number | null
  to_room_id: number | null
  service_request_id: number | null
  computer_id: number | null
  comment: string | null
  created_by_id: number | null
  created_at: string | null
}

export type PrinterSupply = {
  name: string
  level_percent: number | null
  level_raw: number | null
  max_capacity: number | null
}

export type NetworkPrinter = {
  id: number
  name: string
  driver_name: string | null
  port_name: string | null
  ip_address: string | null
  is_network: boolean
  is_shared: boolean
  is_default: boolean
  agent_status: string | null
  work_offline: boolean | null
  poll_status: string | null
  computer_id: number | null
  computer_hostname: string | null
  location: string | null
  notes: string | null
  source: string
  snmp_model: string | null
  page_count: number | null
  supplies: PrinterSupply[]
  toner_min_percent?: number | null
  last_seen_at: string | null
  last_poll_at: string | null
  last_snmp_at: string | null
  snmp_status: string | null
  snmp_error: string | null
  created_at: string | null
  updated_at: string | null
}

export type NetworkPrinterCreate = {
  name: string
  ip_address: string
  location?: string | null
  notes?: string | null
}

export type PrinterPollResult = {
  polled: number
  online: number
  offline: number
  skipped: number
  snmp_ok: number
  snmp_error: number
  duration_ms: number
  triggered_by: string
  total_in_db: number
  with_ip: number
  without_ip: number
  discovered: number
  discovery_created: number
  discovery_updated: number
  message: string
}

export type PrinterSnmpDiscoveryResult = {
  scanned: number
  found: number
  created: number
  updated: number
  errors: number
  duration_ms: number
  networks: string[]
  message: string
}

export type PrinterCleanupResult = {
  deleted_noise: number
  deleted_no_ip: number
  deleted_duplicates: number
  keys_fixed: number
  remaining: number
}

export type PrinterPollConfig = {
  poll_enabled: boolean
  poll_interval_minutes: number
  snmp_enabled: boolean
  snmp_community: string
  snmp_community_set: boolean
  snmp_timeout_seconds: number
  ping_timeout_ms: number
  poll_concurrency: number
  last_run_at: string | null
}

export type PrinterPollConfigUpdate = {
  poll_enabled?: boolean
  poll_interval_minutes?: number
  snmp_enabled?: boolean
  snmp_community?: string
  snmp_timeout_seconds?: number
  ping_timeout_ms?: number
  poll_concurrency?: number
}

export type PrinterSchedulerStatus = {
  scheduler_active: boolean
  running_now: boolean
  poll_enabled: boolean
  poll_interval_minutes: number
  next_run_at: string | null
  last_run_at: string | null
  last_run_summary: PrinterPollResult | null
}

export type NetworkDeviceInterface = {
  if_index: string
  name: string | null
  descr: string | null
  if_type: number | null
  oper_status: string | null
  speed: number | null
  mac: string | null
}

export type NetworkDeviceNeighbor = {
  protocol: string
  remote_name: string | null
  remote_port: string | null
  remote_descr: string | null
  remote_ip: string | null
  local_if_index: string | null
  local_port: string | null
}

export type NetworkDeviceFdb = {
  mac: string
  port: string | null
  if_index: string | null
}

export type NetworkDevice = {
  id: number
  ip_address: string
  hostname: string | null
  sys_name: string | null
  sys_descr: string | null
  sys_object_id: string | null
  device_type: string
  /** UI role: gateway | dns | infra | switch | router | … */
  role: string
  vendor: string | null
  location: string | null
  snmp_status: string | null
  snmp_error: string | null
  last_snmp_at: string | null
  last_seen_at: string | null
  interfaces: NetworkDeviceInterface[]
  neighbors: NetworkDeviceNeighbor[]
  fdb: NetworkDeviceFdb[]
  extras: Record<string, unknown>
  source: string
  notes: string | null
  created_at: string | null
  updated_at: string | null
}

export type NetworkJobStatus = {
  running: boolean
  kind: string
  phase: string
  progress: number
  message: string
  started_at: string | null
  finished_at: string | null
  last_result: Record<string, unknown>
  error: string | null
}

export type NetworkDeviceCreate = {
  ip_address: string
  hostname?: string | null
  device_type?: string | null
  location?: string | null
  notes?: string | null
}

export type NetworkDiscoveryResult = {
  scanned: number
  found: number
  created: number
  updated: number
  skipped: number
  errors: number
  duration_ms: number
  networks: string[]
  message: string
}

export type NetworkPollResult = {
  polled: number
  online: number
  offline: number
  snmp_ok: number
  snmp_error: number
  duration_ms: number
  discovered: number
  discovery_created: number
  discovery_updated: number
  links_devices: number
  links_computers: number
  message: string
  networks: string[]
}

export type NetworkPollConfig = {
  poll_enabled: boolean
  poll_interval_minutes: number
  snmp_community: string
  snmp_community_set: boolean
  snmp_timeout_seconds: number
  poll_concurrency: number
  cidr_list: string[]
  last_run_at: string | null
}

export type NetworkPollConfigUpdate = {
  poll_enabled?: boolean
  poll_interval_minutes?: number
  snmp_community?: string
  snmp_timeout_seconds?: number
  poll_concurrency?: number
  cidr_list?: string[]
}

export type NetworkTopologyNode = {
  id: string
  kind: string
  ref_id: number
  label: string
  device_type: string | null
  ip_address: string | null
  vendor: string | null
  snmp_status: string | null
}

export type NetworkTopologyEdge = {
  id: string
  source: string
  target: string
  link_type: string
  local_port: string | null
  remote_port: string | null
  confidence: number
}

export type NetworkTopology = {
  nodes: NetworkTopologyNode[]
  edges: NetworkTopologyEdge[]
}
