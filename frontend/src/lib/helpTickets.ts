export type HelpTicketPhase = 'waiting' | 'taken' | 'done' | 'cancelled'

export function helpTicketPhase(
  status: string | null | undefined,
  assignees: string[] | null | undefined,
): HelpTicketPhase {
  const s = (status || '').trim().toLowerCase()
  if (s === 'cancelled') return 'cancelled'
  if (s === 'done' || s === 'closed') return 'done'
  const takenByPerson = (assignees ?? []).some((name) => name.trim())
  if (takenByPerson || s === 'in_progress') return 'taken'
  return 'waiting'
}

export function helpTicketAssigneesLine(assignees: string[]): string {
  const names = assignees.map((s) => s.trim()).filter(Boolean)
  if (names.length === 0) return ''
  if (names.length > 2) return 'IT-поддержка'
  return names.join(', ')
}

export function helpTicketNo(ticketNo: number | null | undefined, id: number): string {
  return ticketNo != null ? `№${ticketNo}` : `№${id}`
}

export function helpTicketWhen(iso: string | null | undefined, locale: 'ru' | 'en'): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(locale === 'en' ? 'en-GB' : 'ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export type HelpTicketPhaseSnap = {
  id: number
  phase: HelpTicketPhase
  ticketNo: string
}

export type HelpTicketPhaseChange = {
  id: number
  ticketNo: string
  from: HelpTicketPhase
  to: HelpTicketPhase
}

export function helpTicketPhaseSnaps(
  rows: Array<{
    id: number
    ticket_no?: number | null
    status?: string | null
    assignees?: string[] | null
  }>,
): HelpTicketPhaseSnap[] {
  return rows.map((row) => ({
    id: row.id,
    phase: helpTicketPhase(row.status, row.assignees),
    ticketNo: helpTicketNo(row.ticket_no, row.id),
  }))
}

/** Status changes since the last poll. First snapshot is silent (no “from”). */
export function helpTicketPhaseChanges(
  prev: HelpTicketPhaseSnap[] | null,
  next: HelpTicketPhaseSnap[],
): HelpTicketPhaseChange[] {
  if (!prev) return []
  const before = new Map(prev.map((row) => [row.id, row]))
  const out: HelpTicketPhaseChange[] = []
  for (const row of next) {
    const was = before.get(row.id)
    if (!was || was.phase === row.phase) continue
    if (row.phase === 'taken' || row.phase === 'done' || row.phase === 'cancelled') {
      out.push({ id: row.id, ticketNo: row.ticketNo, from: was.phase, to: row.phase })
    }
  }
  return out
}

export function helpFormDocumentTitle(base: string, notice: string | null, unread: number): string {
  const head = unread > 0 ? `(${unread}) ${base}` : base
  return notice && notice !== head ? notice : head
}
