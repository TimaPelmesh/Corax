import { useMemo, useState } from 'react'
import { api, type GlpiRemoteTicket, type GlpiTicketField, type ServiceRequestRow } from '../api'
import { useT, type MessageKey } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'
import { requestPriorityLabel, requestStatusLabel } from './service-requests/shared'

const FIELDS: { key: GlpiTicketField; label: MessageKey }[] = [
  { key: 'content', label: 'settingsGlpi.fieldContent' },
  { key: 'status', label: 'settingsGlpi.fieldStatus' },
  { key: 'priority', label: 'settingsGlpi.fieldPriority' },
  { key: 'requester', label: 'settingsGlpi.fieldRequester' },
  { key: 'assignee', label: 'settingsGlpi.fieldAssignee' },
  { key: 'category', label: 'settingsGlpi.fieldCategory' },
  { key: 'opened_at', label: 'settingsGlpi.fieldOpened' },
]

function clip(value: string | null | undefined, max = 220) {
  const text = (value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function when(value: string | null | undefined) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function Payload({
  title,
  rows,
}: {
  title: string
  rows: { label: string; value: string; off?: boolean }[]
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 px-3 py-2">
      <p className="text-[12px] font-semibold text-[var(--color-fg)]">{title}</p>
      <dl className="mt-2 space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex gap-2 text-[12px]">
            <dt className="w-28 shrink-0 text-[var(--color-fg-subtle)]">{row.label}</dt>
            <dd className={row.off ? 'text-[var(--color-fg-subtle)] line-through' : 'min-w-0 break-words text-[var(--color-fg)]'}>
              {row.off ? row.value : row.value || '—'}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function GlpiTicketTransfer({
  enabled,
  prepare,
}: {
  enabled: boolean
  prepare: () => Promise<boolean>
}) {
  const t = useT()
  const toast = useToast()
  const [fields, setFields] = useState<Record<GlpiTicketField, boolean>>({
    content: true,
    status: true,
    priority: true,
    requester: true,
    assignee: true,
    category: true,
    opened_at: true,
  })
  const [localRows, setLocalRows] = useState<ServiceRequestRow[]>([])
  const [localQuery, setLocalQuery] = useState('')
  const [localPicked, setLocalPicked] = useState<number[]>([])
  const [localLoading, setLocalLoading] = useState(false)
  const [remoteRows, setRemoteRows] = useState<GlpiRemoteTicket[]>([])
  const [remoteQuery, setRemoteQuery] = useState('')
  const [remotePicked, setRemotePicked] = useState<number[]>([])
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [sending, setSending] = useState<'export' | 'import' | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; percent: number } | null>(null)
  const [note, setNote] = useState('')

  const selectedFields = FIELDS.filter((field) => fields[field.key]).map((field) => field.key)
  const visibleLocal = useMemo(() => {
    const q = localQuery.trim().toLowerCase()
    if (!q) return localRows
    return localRows.filter((row) =>
      [String(row.id), row.title, row.requester_name, row.category, ...(row.assignee_usernames || [])]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [localQuery, localRows])
  const visibleRemote = useMemo(() => {
    const q = remoteQuery.trim().toLowerCase()
    if (!q) return remoteRows
    return remoteRows.filter((row) =>
      [String(row.glpi_id), row.title, row.requester, row.category, row.location].join(' ').toLowerCase().includes(q),
    )
  }, [remoteQuery, remoteRows])

  const focusLocal = visibleLocal.find((row) => localPicked.includes(row.id)) ?? null
  const focusRemote = visibleRemote.find((row) => remotePicked.includes(row.glpi_id)) ?? null

  function toggleField(key: GlpiTicketField) {
    setFields((current) => ({ ...current, [key]: !current[key] }))
  }

  function toggleId(list: number[], id: number, setList: (next: number[]) => void) {
    setList(list.includes(id) ? list.filter((item) => item !== id) : [...list, id])
  }

  async function loadLocal() {
    setLocalLoading(true)
    try {
      const result = await api.serviceRequestsAll()
      setLocalRows(result.items)
      setLocalPicked([])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.syncFailed'))
    } finally {
      setLocalLoading(false)
    }
  }

  async function loadRemote() {
    setRemoteLoading(true)
    try {
      const ready = await prepare()
      if (!ready) return
      const result = await api.glpiRemoteTickets(200)
      setRemoteRows(result.items)
      setRemotePicked([])
      if (!result.items.length) toast.error(t('settingsGlpi.checkEmpty'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.syncFailed'))
    } finally {
      setRemoteLoading(false)
    }
  }

  async function sendToGlpi() {
    if (!localPicked.length) {
      toast.error(t('settingsGlpi.exportIdsRequired'))
      return
    }
    setSending('export')
    setProgress(null)
    try {
      const ready = await prepare()
      if (!ready) return
      const result = await api.glpiExportTicketsStream(localPicked.length, {
        mode: 'selected_update',
        request_ids: localPicked,
        fields: selectedFields,
        onProgress: (item) => setProgress({ done: item.done, total: item.total, percent: item.percent }),
      })
      setNote(result.message)
      if (result.failed > 0 && result.created + result.updated === 0) {
        toast.error(result.errors[0] ? `${result.message}. ${result.errors[0]}` : result.message)
      } else if (result.failed > 0 && result.errors[0]) {
        toast.error(`${result.message}. ${result.errors[0]}`)
      } else {
        toast.ok(
          result.message ||
            t('settingsGlpi.exportApiDone', {
              created: result.created,
              updated: result.updated,
              failed: result.failed,
            }),
        )
      }
      await loadLocal()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.syncFailed'))
    } finally {
      setSending(null)
      setProgress(null)
    }
  }

  async function createInCorax() {
    if (!remotePicked.length) {
      toast.error(t('settingsGlpi.checkNeedId'))
      return
    }
    setSending('import')
    try {
      const ready = await prepare()
      if (!ready) return
      const result = await api.glpiImportTickets(Math.max(200, remoteRows.length), remotePicked)
      setNote(result.message)
      if (result.created + result.updated === 0) toast.error(result.message || t('settingsGlpi.syncFailed'))
      else {
        toast.ok(
          result.message ||
            t('settingsGlpi.importApiDone', {
              created: result.created,
              updated: result.updated,
              skipped: result.skipped,
              failed: result.failed,
            }),
        )
      }
      await loadRemote()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.syncFailed'))
    } finally {
      setSending(null)
    }
  }

  const busy = sending !== null || localLoading || remoteLoading
  const localPreview = focusLocal
    ? [
        { label: t('settingsGlpi.fieldTitle'), value: focusLocal.title },
        {
          label: t('settingsGlpi.fieldContent'),
          value: fields.content ? clip(focusLocal.description) : t('settingsGlpi.fieldOff'),
          off: !fields.content,
        },
        {
          label: t('settingsGlpi.fieldStatus'),
          value: fields.status ? requestStatusLabel(focusLocal.status) : t('settingsGlpi.fieldOff'),
          off: !fields.status,
        },
        {
          label: t('settingsGlpi.fieldPriority'),
          value: fields.priority ? requestPriorityLabel(focusLocal.priority) : t('settingsGlpi.fieldOff'),
          off: !fields.priority,
        },
        {
          label: t('settingsGlpi.fieldRequester'),
          value: fields.requester ? focusLocal.requester_name || '' : t('settingsGlpi.fieldOff'),
          off: !fields.requester,
        },
        {
          label: t('settingsGlpi.fieldAssignee'),
          value: fields.assignee ? (focusLocal.assignee_usernames || []).join(', ') : t('settingsGlpi.fieldOff'),
          off: !fields.assignee,
        },
        {
          label: t('settingsGlpi.fieldCategory'),
          value: fields.category ? focusLocal.category || '' : t('settingsGlpi.fieldOff'),
          off: !fields.category,
        },
        {
          label: t('settingsGlpi.fieldOpened'),
          value: fields.opened_at ? when(focusLocal.opened_at || focusLocal.created_at) : t('settingsGlpi.fieldOff'),
          off: !fields.opened_at,
        },
      ]
    : []
  const remotePreview = focusRemote
    ? [
        { label: t('settingsGlpi.fieldTitle'), value: focusRemote.title },
        { label: t('settingsGlpi.fieldContent'), value: clip(focusRemote.content) },
        { label: t('settingsGlpi.fieldStatus'), value: requestStatusLabel(focusRemote.status) },
        { label: t('settingsGlpi.fieldPriority'), value: requestPriorityLabel(focusRemote.priority) },
        { label: t('settingsGlpi.fieldRequester'), value: focusRemote.requester || '' },
        { label: t('settingsGlpi.fieldCategory'), value: focusRemote.category || '' },
        { label: t('settingsGlpi.locationLabel'), value: focusRemote.location || '' },
        { label: t('settingsGlpi.fieldOpened'), value: when(focusRemote.opened_at) },
      ]
    : []

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <section className="space-y-3 rounded-xl border border-[var(--color-border)] p-4">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.transferToGlpi')}</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">{t('settingsGlpi.transferToGlpiHint')}</p>
        </div>

        <div>
          <p className="mb-1.5 text-[12px] font-medium text-[var(--color-fg-subtle)]">{t('settingsGlpi.fieldsTitle')}</p>
          <div className="flex flex-wrap gap-1.5">
            <span className="rounded-md bg-[var(--color-primary-muted)] px-2 py-1 text-[12px] font-medium text-[var(--color-primary)]">
              {t('settingsGlpi.fieldTitle')} · {t('settingsGlpi.fieldTitleAlways')}
            </span>
            {FIELDS.map((field) => (
              <button
                key={field.key}
                type="button"
                aria-pressed={fields[field.key]}
                className={`rounded-md px-2 py-1 text-[12px] font-medium ${
                  fields[field.key]
                    ? 'bg-[var(--color-primary-muted)] text-[var(--color-primary)]'
                    : 'bg-[var(--color-bg-muted)] text-[var(--color-fg-subtle)] line-through'
                }`}
                onClick={() => toggleField(field.key)}
              >
                {t(field.label)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => void loadLocal()}>
            {localLoading ? t('common.loading') : t('settingsGlpi.showLocal')}
          </button>
          <input
            className="app-input min-w-[12rem] flex-1"
            value={localQuery}
            placeholder={t('settingsGlpi.pickerSearch')}
            onChange={(e) => setLocalQuery(e.target.value)}
          />
        </div>

        <TicketList
          empty={localRows.length === 0 ? t('settingsGlpi.previewPick') : t('settingsGlpi.pickerEmpty')}
          rows={visibleLocal.map((row) => ({
            id: row.id,
            title: row.title,
            meta: `CORAX #${row.ticket_no ?? row.id}${row.glpi_id != null ? ` · GLPI #${row.glpi_id}` : ''}`,
            checked: localPicked.includes(row.id),
          }))}
          onToggle={(id) => toggleId(localPicked, id, setLocalPicked)}
        />

        {focusLocal ? (
          <Payload title={t('settingsGlpi.previewToGlpi')} rows={localPreview} />
        ) : (
          <p className="text-[12px] text-[var(--color-fg-muted)]">{t('settingsGlpi.previewPick')}</p>
        )}

        {progress ? (
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
            <div className="h-full bg-[var(--color-primary)]" style={{ width: `${progress.percent}%` }} />
          </div>
        ) : null}

        <button
          type="button"
          className="app-btn app-btn-primary"
          disabled={busy || !enabled || localPicked.length === 0}
          onClick={() => void sendToGlpi()}
        >
          {sending === 'export' ? t('settingsGlpi.syncing') : `${t('settingsGlpi.sendToGlpi')} (${localPicked.length})`}
        </button>
      </section>

      <section className="space-y-3 rounded-xl border border-[var(--color-border)] p-4">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.transferToCorax')}</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">{t('settingsGlpi.transferToCoraxHint')}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="app-btn app-btn-secondary"
            disabled={busy || !enabled}
            onClick={() => void loadRemote()}
          >
            {remoteLoading ? t('common.loading') : t('settingsGlpi.loadFromGlpi')}
          </button>
          <input
            className="app-input min-w-[12rem] flex-1"
            value={remoteQuery}
            placeholder={t('settingsGlpi.pickerSearch')}
            onChange={(e) => setRemoteQuery(e.target.value)}
          />
        </div>

        <TicketList
          empty={remoteRows.length === 0 ? t('settingsGlpi.previewPickRemote') : t('settingsGlpi.pickerEmpty')}
          rows={visibleRemote.map((row) => ({
            id: row.glpi_id,
            title: row.title,
            meta:
              row.corax_id != null
                ? `GLPI #${row.glpi_id} · ${t('settingsGlpi.alreadyInCorax', { id: row.corax_id })}`
                : `GLPI #${row.glpi_id} · ${t('settingsGlpi.willCreate')}`,
            checked: remotePicked.includes(row.glpi_id),
          }))}
          onToggle={(id) => toggleId(remotePicked, id, setRemotePicked)}
        />

        {focusRemote ? (
          <Payload title={t('settingsGlpi.previewToCorax')} rows={remotePreview} />
        ) : (
          <p className="text-[12px] text-[var(--color-fg-muted)]">{t('settingsGlpi.previewPickRemote')}</p>
        )}

        <button
          type="button"
          className="app-btn app-btn-primary"
          disabled={busy || !enabled || remotePicked.length === 0}
          onClick={() => void createInCorax()}
        >
          {sending === 'import'
            ? t('settingsGlpi.syncing')
            : `${t('settingsGlpi.createInCorax')} (${remotePicked.length})`}
        </button>
      </section>

      {note ? <p className="text-[12px] text-[var(--color-fg-muted)] xl:col-span-2">{note}</p> : null}
      {!enabled ? (
        <p className="text-[12px] text-[var(--color-fg-muted)] xl:col-span-2">{t('settingsGlpi.enabledRequired')}</p>
      ) : null}
    </div>
  )
}

function TicketList({
  rows,
  empty,
  onToggle,
}: {
  rows: { id: number; title: string; meta: string; checked: boolean }[]
  empty: string
  onToggle: (id: number) => void
}) {
  if (!rows.length) {
    return <p className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-6 text-center text-[12px] text-[var(--color-fg-muted)]">{empty}</p>
  }
  return (
    <ul className="app-scroll max-h-64 divide-y divide-[var(--color-border)] overflow-auto rounded-lg border border-[var(--color-border)]">
      {rows.map((row) => (
        <li key={row.id}>
          <label className="flex cursor-pointer items-start gap-2 px-3 py-2">
            <input type="checkbox" className="mt-1" checked={row.checked} onChange={() => onToggle(row.id)} />
            <span className="min-w-0">
              <span className="block truncate text-sm text-[var(--color-fg)]">{row.title}</span>
              <span className="block truncate text-[11px] text-[var(--color-fg-muted)]">{row.meta}</span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  )
}
