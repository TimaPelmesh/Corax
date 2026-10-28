import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { api, type NetworkPrinter, type PrinterSupply } from '../api'
import { useAuth } from '../AuthContext'
import { useConfirmDialog } from './ConfirmDialog'
import { useLocale, useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'
import { IconClose, IconPencil } from './icons'
import { partitionSupplies, printerStatusChip, supplyTone } from './printerSupplies'

function fmtWhen(iso: string | null | undefined, locale: 'ru' | 'en') {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function displayTitle(row: NetworkPrinter) {
  const name = row.name?.trim() || ''
  if (name) return name
  return row.snmp_model?.trim() || row.ip_address || ''
}

function SupplyCard({ s, colored }: { s: PrinterSupply; colored: boolean }) {
  const t = useT()
  const low = s.level_percent != null && s.level_percent <= 15
  const tone = colored
    ? supplyTone(s.name)
    : { dot: 'bg-slate-300', track: 'bg-[var(--color-surface-muted)]', fill: 'bg-slate-400', text: 'text-[var(--color-fg)]' }
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
          <span className={`truncate text-sm ${tone.text}`}>{s.name}</span>
        </span>
        <span className="shrink-0 text-sm tabular-nums text-[var(--color-fg-muted)]">
          {s.level_percent != null
            ? `${s.level_percent}%`
            : s.level_raw === -3
              ? t('printerDetail.supplySome')
              : t('printerDetail.noData')}
        </span>
      </div>
      <div className={`mt-1 h-1 w-full overflow-hidden rounded-full ${tone.track}`}>
        <div
          className={`h-full rounded-full ${low && colored ? 'bg-[var(--color-warning-fg)]' : tone.fill}`}
          style={{
            width: `${s.level_percent != null ? Math.max(4, Math.min(100, s.level_percent)) : s.level_raw === -3 ? 40 : 0}%`,
          }}
        />
      </div>
    </div>
  )
}

type Props = {
  printer: NetworkPrinter | null
  onClose: () => void
  onChanged?: (row: NetworkPrinter) => void
  onDeleted?: (id: number) => void
  overlayZClass?: string
}

export function PrinterDetailModal({
  printer: initial,
  onClose,
  onChanged,
  onDeleted,
  overlayZClass = 'z-50',
}: Props) {
  const t = useT()
  const toast = useToast()
  const { ask, dialog: confirmDialog } = useConfirmDialog()
  const { locale } = useLocale()
  const { user } = useAuth()
  const canEdit = Boolean(user?.is_superuser || user?.role === 'editor')
  const [row, setRow] = useState<NetworkPrinter | null>(initial)
  const [nameDraft, setNameDraft] = useState('')
  const [locationDraft, setLocationDraft] = useState('')
  const [notesDraft, setNotesDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [polling, setPolling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [editingName, setEditingName] = useState(false)

  useEffect(() => {
    setRow(initial)
    setNameDraft(initial?.name ?? '')
    setLocationDraft(initial?.location ?? '')
    setNotesDraft(initial?.notes ?? '')
    setEditingName(false)
  }, [initial])

  useEffect(() => {
    if (!initial) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [initial])

  useEffect(() => {
    if (!initial) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [initial, onClose])

  const title = useMemo(() => (row ? displayTitle(row) || t('printerDetail.defaultTitle') : ''), [row, t])
  const supplies = useMemo(() => partitionSupplies(row?.supplies ?? []), [row])

  const saveMeta = useCallback(async () => {
    if (!row || !canEdit) return
    const nm = nameDraft.trim()
    if (!nm) {
      toast.error(t('printerDetail.nameRequired'))
      return
    }
    setSaving(true)
    try {
      const updated = await api.patchPrinter(row.id, {
        name: nm,
        location: locationDraft.trim() || null,
        notes: notesDraft.trim() || null,
      })
      setRow(updated)
      setNameDraft(updated.name)
      setEditingName(false)
      onChanged?.(updated)
      toast.ok(t('printerDetail.saved'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('printerDetail.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [row, canEdit, nameDraft, locationDraft, notesDraft, onChanged, t, toast])

  const saveNameOnly = useCallback(async () => {
    if (!row || !canEdit) return
    const nm = nameDraft.trim()
    if (!nm) {
      toast.error(t('printerDetail.nameRequired'))
      return
    }
    setSaving(true)
    try {
      const updated = await api.patchPrinter(row.id, { name: nm })
      setRow(updated)
      setNameDraft(updated.name)
      setEditingName(false)
      onChanged?.(updated)
      toast.ok(t('printerDetail.saved'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('printerDetail.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [row, canEdit, nameDraft, onChanged, t, toast])

  const pollNow = useCallback(async () => {
    if (!row || !canEdit || !row.ip_address) return
    setPolling(true)
    try {
      const updated = await api.pollPrinter(row.id)
      setRow(updated)
      onChanged?.(updated)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('printerDetail.pollFailed'))
    } finally {
      setPolling(false)
    }
  }, [row, canEdit, onChanged, t, toast])

  if (!initial || !row) return null

  const pollBadge =
    row.poll_status === 'online'
      ? printerStatusChip('online')
      : row.poll_status === 'offline'
        ? printerStatusChip('offline')
        : printerStatusChip('unknown')
  const snmpBadge =
    row.snmp_status === 'ok'
      ? printerStatusChip('ok')
      : row.snmp_status === 'error'
        ? printerStatusChip('error')
        : printerStatusChip('unknown')

  return createPortal(
    <div
      className={`fixed inset-0 ${overlayZClass} flex items-stretch justify-center bg-[color-mix(in_srgb,var(--color-bg)_50%,black)] p-0 sm:items-center sm:p-3`}
      role="dialog"
      aria-modal
      aria-labelledby="printer-detail-title"
      onClick={onClose}
    >
      <div
        className="pc-card-shell app-card relative z-10 flex max-h-[100dvh] w-full max-w-none flex-col overflow-hidden rounded-none border-0 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.5rem,env(safe-area-inset-top))] shadow-none sm:max-h-[min(92dvh,720px)] sm:max-w-[min(920px,calc(100vw-1.5rem))] sm:rounded-xl sm:border sm:border-[var(--color-border)] sm:p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--color-border)] px-1 pb-3 sm:px-2 sm:pb-4">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                {editingName && canEdit ? (
                  <input
                    className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm font-medium text-[var(--color-fg)]"
                    value={nameDraft}
                    autoFocus
                    disabled={saving}
                    aria-label={t('printerDetail.coraxName')}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void saveNameOnly()
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setNameDraft(row.name ?? '')
                        setEditingName(false)
                      }
                    }}
                  />
                ) : (
                  <h2 id="printer-detail-title" className="truncate text-lg font-semibold text-[var(--color-fg)]">
                    {title}
                  </h2>
                )}
              </div>
              {canEdit ? (
                editingName ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      className="app-btn app-btn-primary !min-h-0 !px-2.5 !py-1 text-sm"
                      disabled={saving || !nameDraft.trim()}
                      onClick={() => void saveNameOnly()}
                    >
                      {saving ? '…' : t('common.save')}
                    </button>
                    <button
                      type="button"
                      className="app-btn app-btn-secondary !min-h-0 !px-2.5 !py-1 text-sm"
                      disabled={saving}
                      onClick={() => {
                        setNameDraft(row.name ?? '')
                        setEditingName(false)
                      }}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="shrink-0 rounded-md p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
                    title={t('printers.editName')}
                    aria-label={t('printers.editName')}
                    onClick={() => {
                      setNameDraft(row.name?.trim() || title)
                      setEditingName(true)
                    }}
                  >
                    <IconPencil className="h-4 w-4" />
                  </button>
                )
              ) : null}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {row.printer_kind && row.printer_kind !== 'unknown' ? (
                <span className="rounded-md bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-xs text-[var(--color-fg)]">
                  {row.printer_kind === 'label'
                    ? t('printers.kindLabel')
                    : row.printer_kind === 'mfp'
                      ? t('printers.kindMfp')
                      : row.printer_kind === 'inkjet'
                        ? t('printers.kindInkjet')
                        : row.printer_kind === 'laser'
                          ? t('printers.kindLaser')
                          : row.printer_kind}
                </span>
              ) : null}
              <span className={`rounded-md px-1.5 py-0.5 text-xs ring-1 ${pollBadge}`}>
                {row.poll_status === 'online'
                  ? t('printerDetail.status.online')
                  : row.poll_status === 'offline'
                    ? t('printerDetail.status.offline')
                    : 'unknown'}
              </span>
              <span className={`rounded-md px-1.5 py-0.5 text-xs ring-1 ${snmpBadge}`} title={row.snmp_error || undefined}>
                SNMP{' '}
                {row.snmp_status === 'ok'
                  ? t('printerDetail.status.ok')
                  : row.snmp_status === 'error'
                    ? t('printerDetail.status.error')
                    : t('printerDetail.status.unknown')}
              </span>
              {row.source ? (
                <span className="text-xs text-[var(--color-fg-muted)]">{t('printerDetail.source', { source: row.source })}</span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-lg border border-[var(--color-border)] p-1.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
            onClick={onClose}
            aria-label={t('printerDetail.close')}
          >
            <IconClose className="h-4 w-4" />
          </button>
        </header>

        <div className="mt-3 grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden px-1 sm:px-2 lg:grid-cols-2">
          <section className="app-scroll flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto">
            <h3 className="text-sm font-medium text-[var(--color-fg)]">{t('printerDetail.device')}</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 [&_dd]:break-words [&_dd]:text-sm [&_dd]:leading-5 [&_dd]:text-[var(--color-fg)] [&_dt]:text-xs [&_dt]:leading-4 [&_dt]:text-[var(--color-fg-muted)]">
              {row.snmp_model?.trim() && row.snmp_model.trim() !== (row.name?.trim() || '') ? (
                <div className="min-w-0 col-span-2">
                  <dt>{t('printerDetail.snmpModel')}</dt>
                  <dd title={row.snmp_model.trim()}>{row.snmp_model.trim()}</dd>
                </div>
              ) : null}
              <div className="min-w-0">
                <dt>{t('printerDetail.ip')}</dt>
                <dd className="font-mono" title={row.ip_address ?? undefined}>{row.ip_address ?? '—'}</dd>
              </div>
              <div className="min-w-0">
                <dt>{t('printerDetail.pages')}</dt>
                <dd className="tabular-nums">
                  {row.page_count != null ? row.page_count.toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU') : '—'}
                </dd>
              </div>
              {row.serial_number ? (
                <div className="min-w-0">
                  <dt>{t('printerDetail.serial')}</dt>
                  <dd className="font-mono" title={row.serial_number}>{row.serial_number}</dd>
                </div>
              ) : null}
              {row.snmp_sys_name ? (
                <div className="min-w-0">
                  <dt>{t('printerDetail.snmpSysName')}</dt>
                  <dd className="font-mono" title={row.snmp_sys_name}>{row.snmp_sys_name}</dd>
                </div>
              ) : null}
              <div className="min-w-0">
                <dt>{t('printerDetail.lastPoll')}</dt>
                <dd>{fmtWhen(row.last_poll_at, locale)}</dd>
              </div>
              <div className="min-w-0">
                <dt>{t('printerDetail.lastSnmp')}</dt>
                <dd>{fmtWhen(row.last_snmp_at, locale)}</dd>
              </div>
              {row.driver_name ? (
                <div className="min-w-0 col-span-2">
                  <dt>{t('printerDetail.driver')}</dt>
                  <dd title={row.driver_name}>{row.driver_name}</dd>
                </div>
              ) : null}
              {row.port_name ? (
                <div className="min-w-0 col-span-2">
                  <dt>{t('printerDetail.port')}</dt>
                  <dd className="font-mono" title={row.port_name}>{row.port_name}</dd>
                </div>
              ) : null}
              {row.computer_hostname || row.computer_id ? (
                <div className="min-w-0 col-span-2">
                  <dt>{t('printerDetail.linkedComputer')}</dt>
                  <dd>
                    {row.computer_id ? (
                      <Link className="text-[var(--color-primary)] underline" to="/computers">
                        {row.computer_hostname || `ID ${row.computer_id}`}
                      </Link>
                    ) : (
                      row.computer_hostname
                    )}
                  </dd>
                </div>
              ) : null}
              {!canEdit && row.location ? (
                <div className="min-w-0 col-span-2">
                  <dt>{t('printerDetail.location')}</dt>
                  <dd title={row.location}>{row.location}</dd>
                </div>
              ) : null}
              {!canEdit && row.notes ? (
                <div className="min-w-0 col-span-2">
                  <dt>{t('printerDetail.notes')}</dt>
                  <dd className="whitespace-pre-wrap" title={row.notes}>{row.notes}</dd>
                </div>
              ) : null}
              {row.snmp_error ? (
                <div className="min-w-0 col-span-2">
                  <dt>{t('printerDetail.snmpError')}</dt>
                  <dd className="break-words text-[var(--color-error-fg)]" title={row.snmp_error}>{row.snmp_error}</dd>
                </div>
              ) : null}
            </dl>

            {canEdit ? (
              <div className="grid grid-cols-1 gap-2 border-t border-[var(--color-border)] pt-3 sm:grid-cols-2">
                <label className="block min-w-0">
                  <span className="text-xs text-[var(--color-fg-muted)]">{t('printerDetail.location')}</span>
                  <input
                    className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-fg)]"
                    value={locationDraft}
                    onChange={(e) => setLocationDraft(e.target.value)}
                    placeholder={t('printerDetail.locationPlaceholder')}
                  />
                </label>
                <label className="block min-w-0">
                  <span className="text-xs text-[var(--color-fg-muted)]">{t('printerDetail.notes')}</span>
                  <input
                    className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-fg)]"
                    value={notesDraft}
                    onChange={(e) => setNotesDraft(e.target.value)}
                    placeholder={t('printerDetail.notesPlaceholder')}
                  />
                </label>
                <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:flex-wrap sm:items-center">
                  <button type="button" className="app-btn app-btn-primary w-full !min-h-9 sm:w-auto" disabled={saving} onClick={() => void saveMeta()}>
                    {saving ? t('printerDetail.saving') : t('common.save')}
                  </button>
                  <button
                    type="button"
                    className="app-btn app-btn-secondary w-full !min-h-9 sm:w-auto"
                    disabled={polling || !row.ip_address}
                    onClick={() => void pollNow()}
                  >
                    {polling ? t('printerDetail.polling') : t('printerDetail.pollNow')}
                  </button>
                  <button
                    type="button"
                    className="app-btn app-btn-danger w-full !min-h-9 sm:w-auto"
                    disabled={deleting}
                    onClick={() => {
                      if (!row) return
                      void (async () => {
                        const ok = await ask({
                          title: t('common.delete'),
                          body: t('printers.deleteOne'),
                          confirmLabel: t('common.delete'),
                          tone: 'danger',
                        })
                        if (!ok) return
                        setDeleting(true)
                        try {
                          await api.deletePrinter(row.id)
                          onDeleted?.(row.id)
                          onClose()
                        } catch (e: unknown) {
                          toast.error(e instanceof Error ? e.message : t('printers.deleteFailed'))
                        } finally {
                          setDeleting(false)
                        }
                      })()
                    }}
                  >
                    {deleting ? t('common.loading') : t('common.delete')}
                  </button>
                </div>
              </div>
            ) : null}
          </section>

          <section className="app-scroll flex min-h-0 min-w-0 flex-col overflow-y-auto">
            <h3 className="text-sm font-medium text-[var(--color-fg)]">{t('printerDetail.supplies')}</h3>
            {(row.supplies?.length ?? 0) === 0 ? (
              <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{t('printerDetail.noSupplies')}</p>
            ) : (
              <div className="mt-2 min-h-0 space-y-3 overflow-hidden">
                {supplies.toners.length > 0 ? (
                  <div>
                    <div className="mb-1.5 text-xs text-[var(--color-fg-muted)]">{t('printerDetail.toner')}</div>
                    <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                      {supplies.toners.map((s) => (
                        <SupplyCard key={s.name} s={s} colored />
                      ))}
                    </div>
                  </div>
                ) : null}
                {supplies.service.length > 0 ? (
                  <div>
                    <div className="mb-1.5 text-xs text-[var(--color-fg-muted)]">{t('printerDetail.service')}</div>
                    <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                      {supplies.service.map((s) => (
                        <SupplyCard key={s.name} s={s} colored={false} />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </div>

      </div>
      {confirmDialog}
    </div>,
    document.body,
  )
}
