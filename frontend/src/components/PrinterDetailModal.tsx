import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { api, type NetworkPrinter, type PrinterSupply } from '../api'
import { useAuth } from '../AuthContext'
import { useLocale, useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'
import { IconClose, IconPrinter } from './icons'

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
  const model = row.snmp_model?.trim()
  const name = row.name?.trim() || ''
  if (model) return model
  return name || row.ip_address || ''
}

function isTonerSupply(name: string): boolean {
  const s = name.toLowerCase()
  if (
    /(?:imaging unit|imageur|drum|фотобарабан|барабан|photoconductor)/i.test(s) ||
    /(?:fuser|fusing|печь|fuse)/i.test(s) ||
    /(?:filter|фильтр|ozone|озон|paper dust|remover|waste|бункер|отработ)/i.test(s) ||
    /(?:developer|transfer|belt|kit|maintenance)/i.test(s)
  ) {
    return false
  }
  return /(?:toner|cartridge|тонер|картридж|черн|cyan|magenta|yellow|голуб|жёлт|желт|пурпур|\bcf\d{3}|\bce40)/i.test(
    s,
  )
}

function partitionSupplies(supplies: PrinterSupply[]) {
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

function supplyTone(name: string): { dot: string; track: string; fill: string; text: string } {
  const s = name.toLowerCase()
  if (/(cyan|голуб|ce401a|cf411)/i.test(s)) {
    return { dot: 'bg-cyan-500', track: 'bg-cyan-50', fill: 'bg-cyan-500', text: 'text-cyan-800' }
  }
  if (/(magenta|пурпур|маджент|ce403a|cf413)/i.test(s)) {
    return { dot: 'bg-fuchsia-500', track: 'bg-fuchsia-50', fill: 'bg-fuchsia-500', text: 'text-fuchsia-800' }
  }
  if (/(yellow|желт|жёлт|ce402a|cf412)/i.test(s)) {
    return { dot: 'bg-yellow-400', track: 'bg-yellow-50', fill: 'bg-yellow-400', text: 'text-yellow-800' }
  }
  if (/(black|ч[её]рн|carbon|ce400a|ce400x|cf410|cf226)/i.test(s)) {
    return { dot: 'bg-slate-950', track: 'bg-slate-100', fill: 'bg-slate-900', text: 'text-slate-900' }
  }
  return { dot: 'bg-slate-400', track: 'bg-slate-100', fill: 'bg-slate-400', text: 'text-slate-700' }
}

function SupplyCard({ s, colored }: { s: PrinterSupply; colored: boolean }) {
  const t = useT()
  const low = s.level_percent != null && s.level_percent <= 15
  const tone = colored
    ? supplyTone(s.name)
    : { dot: 'bg-slate-300', track: 'bg-slate-100', fill: 'bg-slate-400', text: 'text-slate-600' }
  return (
    <div
      className={`rounded-xl border px-3 py-2.5 ${
        low && colored ? 'border-amber-200 bg-amber-50/60' : 'border-slate-200/90 bg-white'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ring-1 ring-black/10 ${tone.dot}`} />
        <div className="min-w-0 flex-1">
          <div className={`break-words text-sm font-medium leading-snug ${tone.text}`}>{s.name}</div>
          <div className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-500">
            <span className="font-mono tabular-nums text-slate-800">
              {s.level_percent != null ? `${s.level_percent}%` : t('printerDetail.noData')}
            </span>
            {s.max_capacity != null && s.level_raw != null ? (
              <span className="font-mono tabular-nums text-slate-400">
                {s.level_raw}/{s.max_capacity}
              </span>
            ) : null}
          </div>
          <div className={`mt-2 h-2 w-full overflow-hidden rounded-full ${tone.track}`}>
            <div
              className={`h-full rounded-full ${low && colored ? 'bg-amber-500' : tone.fill}`}
              style={{ width: `${Math.max(4, Math.min(100, s.level_percent ?? 0))}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

type Props = {
  printer: NetworkPrinter | null
  onClose: () => void
  onChanged?: (row: NetworkPrinter) => void
  overlayZClass?: string
}

export function PrinterDetailModal({
  printer: initial,
  onClose,
  onChanged,
  overlayZClass = 'z-50',
}: Props) {
  const t = useT()
  const toast = useToast()
  const { locale } = useLocale()
  const { user } = useAuth()
  const canEdit = Boolean(user?.is_superuser || user?.role === 'editor')
  const [row, setRow] = useState<NetworkPrinter | null>(initial)
  const [locationDraft, setLocationDraft] = useState('')
  const [notesDraft, setNotesDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [polling, setPolling] = useState(false)

  useEffect(() => {
    setRow(initial)
    setLocationDraft(initial?.location ?? '')
    setNotesDraft(initial?.notes ?? '')
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
    setSaving(true)
    try {
      const updated = await api.patchPrinter(row.id, {
        location: locationDraft.trim() || null,
        notes: notesDraft.trim() || null,
      })
      setRow(updated)
      onChanged?.(updated)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('printerDetail.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [row, canEdit, locationDraft, notesDraft, onChanged, t, toast])

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
      ? 'bg-slate-100 text-slate-700 ring-slate-200'
      : row.poll_status === 'offline'
        ? 'bg-amber-50 text-amber-900 ring-amber-200'
        : 'bg-slate-50 text-slate-600 ring-slate-200'
  const snmpBadge =
    row.snmp_status === 'ok'
      ? 'bg-slate-100 text-slate-700 ring-slate-200'
      : row.snmp_status === 'error'
        ? 'bg-rose-50 text-rose-800 ring-rose-200'
        : 'bg-slate-50 text-slate-600 ring-slate-200'

  return createPortal(
    <div
      className={`fixed inset-0 ${overlayZClass} flex items-stretch justify-center bg-slate-900/40 p-0 backdrop-blur-sm sm:items-center sm:p-4`}
      role="dialog"
      aria-modal
      onClick={onClose}
    >
      <div
        className="app-card flex max-h-[100dvh] w-full max-w-none flex-col overflow-y-auto overscroll-contain rounded-none border-0 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] shadow-none ring-0 sm:max-h-[min(96vh,calc(100vh-0.5rem))] sm:max-w-[min(1100px,calc(100vw-1rem))] sm:rounded-2xl sm:border sm:border-slate-200/90 sm:p-6 sm:pt-6 sm:shadow-2xl sm:shadow-slate-900/15 sm:ring-1 sm:ring-white/40 lg:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="page-hero-icon mt-0.5 shrink-0">
              <IconPrinter className="h-6 w-6" />
            </div>
            <div className="min-w-0 pr-2">
              <h2 className="break-words text-xl font-semibold leading-snug text-slate-900">{title}</h2>
              <p className="mt-1 break-words text-sm text-slate-500">
                {row.ip_address ?? t('printerDetail.noIp')}
                {row.location ? ` · ${row.location}` : ''}
                {row.source ? ` · ${t('printerDetail.source', { source: row.source })}` : ''}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${pollBadge}`}>
                  {row.poll_status === 'online'
                    ? t('printerDetail.status.online')
                    : row.poll_status === 'offline'
                      ? t('printerDetail.status.offline')
                      : 'unknown'}
                </span>
                <span
                  className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${snmpBadge}`}
                  title={row.snmp_error || undefined}
                >
                  SNMP{' '}
                  {row.snmp_status === 'ok'
                    ? t('printerDetail.status.ok')
                    : row.snmp_status === 'error'
                      ? t('printerDetail.status.error')
                      : t('printerDetail.status.unknown')}
                </span>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="group shrink-0 rounded-xl border-2 border-slate-300 bg-white p-2.5 text-slate-600 shadow-md shadow-slate-900/10 ring-2 ring-slate-200/80 transition hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700 hover:ring-blue-200/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
            onClick={onClose}
            aria-label={t('printerDetail.close')}
          >
            <IconClose className="h-6 w-6" />
          </button>
        </div>

        <div className="mt-5 grid shrink-0 grid-cols-1 gap-6 lg:grid-cols-2 lg:gap-8">
          <section className="flex min-w-0 flex-col">
            <h3 className="shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
              {t('printerDetail.device')}
            </h3>
            <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 sm:gap-x-4 sm:gap-y-3">
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-slate-500">{t('printerDetail.snmpModel')}</dt>
                <dd className="break-words font-medium text-slate-900">{row.snmp_model?.trim() || '—'}</dd>
              </div>
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-slate-500">{t('printerDetail.coraxName')}</dt>
                <dd className="break-words text-slate-900">{row.name?.trim() || '—'}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-slate-500">{t('printerDetail.ip')}</dt>
                <dd className="font-mono text-slate-800">{row.ip_address ?? '—'}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-slate-500">{t('printerDetail.pages')}</dt>
                <dd className="font-mono text-lg font-semibold tabular-nums text-slate-900">
                  {row.page_count != null
                    ? row.page_count.toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU')
                    : '—'}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-slate-500">{t('printerDetail.lastPoll')}</dt>
                <dd className="text-slate-800">{fmtWhen(row.last_poll_at, locale)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-slate-500">{t('printerDetail.lastSnmp')}</dt>
                <dd className="text-slate-800">{fmtWhen(row.last_snmp_at, locale)}</dd>
              </div>
              {row.driver_name ? (
                <div className="min-w-0 sm:col-span-2">
                  <dt className="text-slate-500">{t('printerDetail.driver')}</dt>
                  <dd className="break-words text-slate-800">{row.driver_name}</dd>
                </div>
              ) : null}
              {row.port_name ? (
                <div className="min-w-0 sm:col-span-2">
                  <dt className="text-slate-500">{t('printerDetail.port')}</dt>
                  <dd className="break-words font-mono text-slate-700">{row.port_name}</dd>
                </div>
              ) : null}
              {row.computer_hostname || row.computer_id ? (
                <div className="min-w-0 sm:col-span-2">
                  <dt className="text-slate-500">{t('printerDetail.linkedComputer')}</dt>
                  <dd className="text-slate-900">
                    {row.computer_id ? (
                      <Link className="text-blue-700 underline" to="/computers">
                        {row.computer_hostname || `ID ${row.computer_id}`}
                      </Link>
                    ) : (
                      row.computer_hostname
                    )}
                  </dd>
                </div>
              ) : null}
              {row.snmp_error ? (
                <div className="min-w-0 sm:col-span-2">
                  <dt className="text-slate-500">{t('printerDetail.snmpError')}</dt>
                  <dd className="break-words rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">
                    {row.snmp_error}
                  </dd>
                </div>
              ) : null}
            </dl>

            {canEdit ? (
              <div className="mt-5 space-y-3 border-t border-slate-100 pt-4">
                <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                  {t('printerDetail.edit')}
                </h3>
                <label className="block text-sm">
                  <span className="app-label">{t('printerDetail.location')}</span>
                  <input
                    className="app-input"
                    value={locationDraft}
                    onChange={(e) => setLocationDraft(e.target.value)}
                    placeholder={t('printerDetail.locationPlaceholder')}
                  />
                </label>
                <label className="block text-sm">
                  <span className="app-label">{t('printerDetail.notes')}</span>
                  <textarea
                    className="app-input min-h-[5rem]"
                    value={notesDraft}
                    onChange={(e) => setNotesDraft(e.target.value)}
                    placeholder={t('printerDetail.notesPlaceholder')}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="app-btn app-btn-primary"
                    disabled={saving}
                    onClick={() => void saveMeta()}
                  >
                    {saving ? t('printerDetail.saving') : t('common.save')}
                  </button>
                  <button
                    type="button"
                    className="app-btn app-btn-secondary"
                    disabled={polling || !row.ip_address}
                    onClick={() => void pollNow()}
                  >
                    {polling ? t('printerDetail.polling') : t('printerDetail.pollNow')}
                  </button>
                </div>
              </div>
            ) : row.notes ? (
              <div className="mt-5 border-t border-slate-100 pt-4">
                <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">{t('printerDetail.notes')}</h3>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-800">{row.notes}</p>
              </div>
            ) : null}
          </section>

          <section className="flex min-w-0 flex-col">
            <h3 className="shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
              {t('printerDetail.supplies')}
            </h3>
            {(row.supplies?.length ?? 0) === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                {t('printerDetail.noSupplies')}
              </p>
            ) : (
              <div className="mt-3 space-y-4">
                {supplies.toners.length > 0 ? (
                  <div>
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      {t('printerDetail.toner')}
                    </div>
                    <div className="grid gap-2 sm:grid-cols-1">
                      {supplies.toners.map((s) => (
                        <SupplyCard key={s.name} s={s} colored />
                      ))}
                    </div>
                  </div>
                ) : null}
                {supplies.service.length > 0 ? (
                  <div>
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      {t('printerDetail.service')}
                    </div>
                    <div className="grid gap-2">
                      {supplies.service.map((s) => (
                        <SupplyCard key={s.name} s={s} colored={false} />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            <div className="mt-6 rounded-xl border border-slate-200/90 bg-slate-50/80 px-4 py-3 text-xs text-slate-600">
              <div className="font-semibold text-slate-800">{t('printerDetail.technical')}</div>
              <div className="mt-1 grid gap-1 font-mono">
                <div>id: {row.id}</div>
                <div>{t('printerDetail.created', { date: fmtWhen(row.created_at, locale) })}</div>
                <div>{t('printerDetail.updated', { date: fmtWhen(row.updated_at, locale) })}</div>
                <div>{t('printerDetail.seen', { date: fmtWhen(row.last_seen_at, locale) })}</div>
              </div>
            </div>
          </section>
        </div>

      </div>
    </div>,
    document.body,
  )
}
