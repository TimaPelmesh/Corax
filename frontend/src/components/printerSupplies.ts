import type { PrinterSupply } from '../api'

/** Consumable toner/cartridge/ribbon — not drums, fusers, filters, etc. */
export function isTonerSupply(name: string): boolean {
  const s = name.toLowerCase()
  if (
    /(?:imaging unit|imageur|drum|фотобарабан|барабан|photoconductor)/i.test(s) ||
    /(?:fuser|fusing|печь|fuse)/i.test(s) ||
    /(?:filter|фильтр|ozone|озон|paper dust|remover|waste|бункер|отработ)/i.test(s) ||
    /(?:developer|transfer|belt|kit|maintenance|батарея|battery)/i.test(s)
  ) {
    return false
  }
  return /(?:toner|cartridge|тонер|картридж|черн|cyan|magenta|yellow|голуб|жёлт|желт|пурпур|\bcf\d{3}|\bce40|ribbon|лента)/i.test(
    s,
  )
}

export function partitionSupplies(supplies: PrinterSupply[]) {
  const toners: PrinterSupply[] = []
  const service: PrinterSupply[] = []
  for (const s of supplies) {
    if (isTonerSupply(s.name)) toners.push(s)
    else service.push(s)
  }
  const byName = (a: PrinterSupply, b: PrinterSupply) => a.name.localeCompare(b.name, 'ru')
  const tonerOrder = (name: string) => {
    const s = name.toLowerCase()
    if (/black|черн|ce400|cf410|cf226/i.test(s)) return 0
    if (/cyan|голуб|ce401|cf411/i.test(s)) return 1
    if (/magenta|пурпур|ce403|cf413/i.test(s)) return 2
    if (/yellow|жёлт|желт|ce402|cf412/i.test(s)) return 3
    return 4
  }
  toners.sort((a, b) => tonerOrder(a.name) - tonerOrder(b.name) || byName(a, b))
  service.sort(byName)
  return { toners, service }
}

/** CMYK-ish visual cues for toner bars (identity colors, not status tokens). */
export function supplyTone(name: string): { dot: string; track: string; fill: string; text: string } {
  const s = name.toLowerCase()
  if (/(cyan|голуб|ce401a|cf411)/i.test(s)) {
    return { dot: 'bg-cyan-500', track: 'bg-cyan-50 dark:bg-cyan-950/40', fill: 'bg-cyan-500', text: 'text-cyan-800 dark:text-cyan-200' }
  }
  if (/(magenta|пурпур|маджент|ce403a|cf413)/i.test(s)) {
    return {
      dot: 'bg-fuchsia-500',
      track: 'bg-fuchsia-50 dark:bg-fuchsia-950/40',
      fill: 'bg-fuchsia-500',
      text: 'text-fuchsia-800 dark:text-fuchsia-200',
    }
  }
  if (/(yellow|желт|жёлт|ce402a|cf412)/i.test(s)) {
    return {
      dot: 'bg-yellow-400',
      track: 'bg-yellow-50 dark:bg-yellow-950/40',
      fill: 'bg-yellow-400',
      text: 'text-yellow-800 dark:text-yellow-200',
    }
  }
  if (/(black|ч[её]рн|carbon|ce400a|ce400x|cf410|cf226)/i.test(s)) {
    return {
      dot: 'bg-slate-950 dark:bg-slate-100',
      track: 'bg-[var(--color-surface-muted)]',
      fill: 'bg-slate-900 dark:bg-slate-200',
      text: 'text-[var(--color-fg)]',
    }
  }
  return {
    dot: 'bg-slate-400',
    track: 'bg-[var(--color-surface-muted)]',
    fill: 'bg-slate-400',
    text: 'text-[var(--color-fg-muted)]',
  }
}

export function hasLowToner(supplies: PrinterSupply[] | undefined, threshold = 15) {
  return (supplies ?? []).some(
    (s) => isTonerSupply(s.name) && s.level_percent != null && s.level_percent <= threshold,
  )
}

export function tonerShort(name: string) {
  const s = name.toLowerCase()
  if (/black|черн/.test(s)) return 'K'
  if (/cyan|голуб/.test(s)) return 'C'
  if (/magenta|пурпур/.test(s)) return 'M'
  if (/yellow|жёлт|желт/.test(s)) return 'Y'
  return name.length > 10 ? `${name.slice(0, 9)}…` : name
}

/** Poll / SNMP status chip classes from design tokens. */
export function printerStatusChip(kind: 'online' | 'offline' | 'unknown' | 'ok' | 'error' | 'skipped') {
  switch (kind) {
    case 'online':
    case 'ok':
      return 'bg-[var(--color-success-bg)] text-[var(--color-success-fg)] ring-1 ring-[var(--color-success-border)]'
    case 'offline':
      return 'bg-[var(--color-warning-bg)] text-[var(--color-warning-fg)] ring-1 ring-[var(--color-warning-border)]'
    case 'error':
      return 'bg-[var(--color-error-bg)] text-[var(--color-error-fg)] ring-1 ring-[var(--color-error-border)]'
    case 'skipped':
    case 'unknown':
    default:
      return 'bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)] ring-1 ring-[var(--color-border)]'
  }
}
