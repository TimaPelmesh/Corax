export function hostKeys(value: string) {
  const raw = value.trim().toLowerCase()
  if (!raw) return []
  const short = raw.split('.')[0]
  return short && short !== raw ? [raw, short] : [raw]
}

export function severityRank(value: number) {
  return Number.isFinite(value) ? value : 0
}

/** Zabbix severity chip classes from semantic design tokens. */
export function severityClass(value: number) {
  if (value >= 5) {
    return 'bg-[var(--color-error-bg)] text-[var(--color-error-fg)]'
  }
  if (value >= 4) {
    return 'bg-[var(--color-warning-bg)] text-[var(--color-warning-fg)]'
  }
  if (value >= 3) {
    return 'bg-[var(--color-warning-bg)] text-[var(--color-warning-fg)]'
  }
  if (value >= 2) {
    return 'bg-[var(--color-info-bg)] text-[var(--color-info-fg)]'
  }
  return 'bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]'
}

export function normalizeZabbixHref(raw: string | null | undefined) {
  const value = (raw || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  if (/^[a-zA-Z0-9.-]+(:\d+)?(\/.*)?$/.test(value)) return `http://${value}`
  return ''
}

export function catalogFilterKey(kind: string, name: string) {
  return `${kind}::${name}`
}
