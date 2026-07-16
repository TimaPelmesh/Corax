import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import {
  api,
  type AssetChangeLog,
  type Computer,
  type ComputerDetail,
  type ComputerPingResult,
  type SoftwareItem,
  type TagBrief,
  type WolStatus,
} from '../api'
import { useAuth } from '../AuthContext'
import { parseAgentExtras } from '../computerAgentExtras'
import { useLocale, useT } from '../i18n/LocaleContext'
import { groupPeripheralsForDisplay } from '../peripheralDisplay'
import { useToast } from '../ToastContext'
import { IconClose } from './icons'

export function tagPillProps(t: TagBrief): { className: string; style?: CSSProperties } {
  const c = t.color
  if (c && /^#[0-9A-Fa-f]{6}$/.test(c)) {
    return {
      className:
        'rounded-full px-2 py-0.5 text-xs font-medium text-slate-900 ring-1 ring-inset ring-black/[0.08]',
      style: { backgroundColor: `${c}2e`, boxShadow: `inset 0 0 0 1px ${c}55` },
    }
  }
  return {
    className: 'rounded-full bg-zinc-50 px-2 py-0.5 text-xs text-neutral-900 ring-1 ring-zinc-200/80',
  }
}

export function fmtDate(iso: string | null, locale: 'ru' | 'en') {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU')
  } catch {
    return iso
  }
}

function describeChange(h: AssetChangeLog, t: ReturnType<typeof useT>): string {
  const src = h.source === 'agent' ? t('computerDetail.agentSource') : t('computerDetail.panelSource')
  if (h.kind === 'meta' && h.field_key === 'wake') {
    return t('computerDetail.wolWakeEvent', { mac: h.new_value ?? '—', source: src })
  }
  if (h.kind === 'meta' && h.field_key === 'wol_allowlist') {
    return t('computerDetail.wolAllowEvent', {
      state: h.new_value === '1' ? t('computerDetail.wolAllowed') : t('computerDetail.wolDenied'),
      source: src,
    })
  }
  if (h.kind === 'field' && h.field_key) {
    return t('computerDetail.fieldChange', {
      field: h.field_key,
      old: h.old_value ?? '—',
      new: h.new_value ?? '—',
      source: src,
    })
  }
  if (h.kind === 'software_list' && h.payload_json) {
    try {
      const p = JSON.parse(h.payload_json) as {
        added_total?: number
        removed_total?: number
        previous_count?: number
        new_count?: number
      }
      return t('computerDetail.softwareChange', {
        added: p.added_total ?? 0,
        removed: p.removed_total ?? 0,
        prev: p.previous_count ?? '?',
        next: p.new_count ?? '?',
        source: src,
      })
    } catch {
      return t('computerDetail.softwareChanged', { source: src })
    }
  }
  if (h.kind === 'peripheral_list' && h.payload_json) {
    try {
      const p = JSON.parse(h.payload_json) as {
        added_total?: number
        removed_total?: number
      }
      return t('computerDetail.peripheralsChange', {
        added: p.added_total ?? 0,
        removed: p.removed_total ?? 0,
        source: src,
      })
    } catch {
      return t('computerDetail.peripheralsChanged', { source: src })
    }
  }
  if (h.kind === 'meta' && h.field_key === 'tags' && h.payload_json) {
    return t('computerDetail.tagsUpdated', { source: src })
  }
  return `${h.kind} (${src})`
}

type Props = {
  computerId: number | null
  /** List-row snapshot so the shell paints before the detail API returns. */
  preview?: Computer | null
  onClose: () => void
  onChanged?: () => void
  overlayZClass?: string
}

function detailFromPreview(p: Computer): ComputerDetail {
  return {
    ...p,
    disks: p.disks ?? [],
    software: [],
    peripherals: [],
    agent_extended: null,
  }
}

export function ComputerDetailModal({
  computerId,
  preview = null,
  onClose,
  onChanged,
  overlayZClass = 'z-50',
}: Props) {
  const t = useT()
  const toast = useToast()
  const { locale } = useLocale()
  const { user } = useAuth()
  const [detail, setDetail] = useState<ComputerDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [softwareRows, setSoftwareRows] = useState<SoftwareItem[] | null>(null)
  const [softwareLoading, setSoftwareLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [notesDraft, setNotesDraft] = useState('')
  const [locationDraft, setLocationDraft] = useState('')
  const [historyRows, setHistoryRows] = useState<AssetChangeLog[] | null>(null)
  const [assignUserId, setAssignUserId] = useState('')
  const [swFilter, setSwFilter] = useState('')
  const [allTags, setAllTags] = useState<TagBrief[]>([])
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([])
  const [wolStatus, setWolStatus] = useState<WolStatus | null>(null)
  const [wolBusy, setWolBusy] = useState(false)
  const [pingResult, setPingResult] = useState<ComputerPingResult | null>(null)
  const [pingBusy, setPingBusy] = useState(false)
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  const previewRef = useRef(preview)
  previewRef.current = preview

  useEffect(() => {
    if (!computerId) {
      setDetail(null)
      setSoftwareRows(null)
      setHistoryRows(null)
      setWolStatus(null)
      setPingResult(null)
      setLoading(false)
      setSoftwareLoading(false)
      setHistoryLoading(false)
      return
    }
    let cancelled = false
    setWolStatus(null)
    setPingResult(null)
    setHistoryRows(null)
    setSoftwareRows(null)
    setSwFilter('')

    const snap = previewRef.current?.id === computerId ? previewRef.current : null
    if (snap) {
      const seeded = detailFromPreview(snap)
      setDetail(seeded)
      setNotesDraft(seeded.notes ?? '')
      setLocationDraft(seeded.location ?? '')
      setSelectedTagIds(seeded.tags.map((tag) => tag.id))
      setAssignUserId(seeded.assigned_user_id != null ? String(seeded.assigned_user_id) : '')
      setLoading(false)
    } else {
      setDetail(null)
      setLoading(true)
    }

    setSoftwareLoading(true)
    setHistoryLoading(true)

    // Core card first (no heavy software list) — paint ASAP.
    void api
      .computer(computerId, { includeSoftware: false })
      .then((d) => {
        if (cancelled) return
        setDetail(d)
        setNotesDraft(d.notes ?? '')
        setLocationDraft(d.location ?? '')
        setSelectedTagIds(d.tags.map((tag) => tag.id))
        setAssignUserId(d.assigned_user_id != null ? String(d.assigned_user_id) : '')
      })
      .catch((e: unknown) => {
        if (!cancelled) toast.error(e instanceof Error ? e.message : t('common.error'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    void api
      .computerSoftware(computerId)
      .then((sw) => {
        if (!cancelled) setSoftwareRows(sw)
      })
      .catch(() => {
        if (!cancelled) setSoftwareRows([])
      })
      .finally(() => {
        if (!cancelled) setSoftwareLoading(false)
      })

    void api
      .computerHistory(computerId, 120)
      .then((hist) => {
        if (!cancelled) setHistoryRows(hist)
      })
      .catch(() => {
        if (!cancelled) setHistoryRows([])
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [computerId, t, toast])

  useEffect(() => {
    if (!computerId || !user) {
      setWolStatus(null)
      return
    }
    let cancelled = false
    void api
      .computerWolStatus(computerId)
      .then((s) => {
        if (!cancelled) setWolStatus(s)
      })
      .catch(() => {
        if (!cancelled) setWolStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [computerId, user])

  useEffect(() => {
    void api
      .tags()
      .then(setAllTags)
      .catch(() => setAllTags([]))
  }, [])

  useEffect(() => {
    if (!computerId) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [computerId])

  useEffect(() => {
    if (!computerId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [computerId, onClose])

  const softwareList = softwareRows ?? detail?.software ?? []
  const softwareTotal = softwareRows?.length ?? detail?.software_count ?? softwareList.length

  const filteredSoftware = useMemo(() => {
    const q = swFilter.trim().toLowerCase()
    if (!q) return softwareList
    return softwareList.filter((s) => s.name.toLowerCase().includes(q))
  }, [softwareList, swFilter])

  const agentExtras = useMemo(
    () => parseAgentExtras(detail?.agent_extended ?? null),
    [detail?.agent_extended],
  )

  const peripheralGroups = useMemo(
    () => groupPeripheralsForDisplay(detail?.peripherals ?? []),
    [detail?.peripherals],
  )

  function toggleTag(id: number) {
    setSelectedTagIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const saveMeta = useCallback(async () => {
    if (!detail || !user?.is_superuser) return
    const userIdText = assignUserId.trim()
    let assigned: number | undefined
    if (userIdText === '') assigned = 0
    else {
      const n = Number.parseInt(userIdText, 10)
      assigned = Number.isFinite(n) ? n : 0
    }
    try {
      await api.updateComputer(detail.id, {
        notes: notesDraft || null,
        location: locationDraft.trim() || null,
        assigned_user_id: assigned,
        tag_ids: selectedTagIds,
      })
      onChanged?.()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('computerDetail.saveFailed'))
    }
  }, [
    detail,
    user?.is_superuser,
    assignUserId,
    notesDraft,
    locationDraft,
    selectedTagIds,
    onChanged,
    onClose,
    t,
    toast,
  ])

  const deletePc = useCallback(async () => {
    if (!detail || !user?.is_superuser) return
    if (
      !confirm(
        t('computerDetail.deleteConfirm', { hostname: detail.hostname }),
      )
    ) {
      return
    }
    try {
      await api.deleteComputer(detail.id)
      onChanged?.()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('computerDetail.deleteFailed'))
    }
  }, [detail, user?.is_superuser, onChanged, onClose, t, toast])

  const refreshWol = useCallback(async () => {
    if (!detail || !user) return
    try {
      setWolStatus(await api.computerWolStatus(detail.id))
    } catch {
      /* keep previous */
    }
  }, [detail, user])

  const checkPing = useCallback(async () => {
    if (!detail) return
    // Do not no-op when busy — previous auto-ping used to swallow the button click.
    setPingBusy(true)
    try {
      const r = await api.pingComputer(detail.id)
      setPingResult(r)
      onChangedRef.current?.()
      if (!r.checked) {
        toast.warn(r.message || t('computerDetail.pingUnknown'))
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setPingBusy(false)
    }
  }, [detail, t, toast])

  // Seed from DB cache immediately so the card matches the list before live ping returns.
  useEffect(() => {
    if (!detail) return
    const st = (detail.ping_status || '').toLowerCase()
    if (st === 'online' || st === 'offline') {
      setPingResult({
        computer_id: detail.id,
        hostname: detail.hostname,
        ip_address: detail.ip_address ?? null,
        online: st === 'online',
        checked: true,
        message: st === 'online' ? t('computerDetail.pingOnline') : t('computerDetail.pingOffline'),
      })
    } else {
      setPingResult(null)
    }
  }, [detail, t])

  // Live ping after first paint so ICMP does not compete with the detail request.
  useEffect(() => {
    if (!detail?.id) return
    let cancelled = false
    const tid = window.setTimeout(() => {
      if (cancelled) return
      setPingBusy(true)
      void api
        .pingComputer(detail.id)
        .then((r) => {
          if (cancelled) return
          setPingResult(r)
          onChangedRef.current?.()
        })
        .catch((e: unknown) => {
          if (cancelled) return
          toast.error(e instanceof Error ? e.message : t('common.error'))
        })
        .finally(() => {
          if (!cancelled) setPingBusy(false)
        })
    }, 150)
    return () => {
      cancelled = true
      window.clearTimeout(tid)
    }
  }, [detail?.id, t, toast])

  const cachedOnline = (detail?.ping_status || '').toLowerCase() === 'online'
  const cachedOffline = (detail?.ping_status || '').toLowerCase() === 'offline'
  const isOnline =
    (pingResult?.checked === true && pingResult.online === true) ||
    (pingResult == null && cachedOnline)
  const isOffline =
    (pingResult?.checked === true && pingResult.online === false) ||
    (pingResult == null && cachedOffline)
  const canShowWake =
    Boolean(wolStatus?.user_may_wake) &&
    Boolean(wolStatus?.can_wake) &&
    !wolStatus?.force_disabled &&
    isOffline

  const wakePc = useCallback(async () => {
    if (!detail || !wolStatus?.user_may_wake || wolBusy || !isOffline) return
    const mac = detail.mac_primary ?? '—'
    if (
      !confirm(
        t('computerDetail.wolWakeConfirm', { hostname: detail.hostname, mac }),
      )
    ) {
      return
    }
    setWolBusy(true)
    try {
      const res = await api.wakeComputer(detail.id)
      if (res.ok) toast.ok(t('computerDetail.wolOk', { sent: res.sent }))
      else toast.error(res.message || t('computerDetail.wolFailed'))
      await refreshWol()
      setHistoryRows(await api.computerHistory(detail.id, 120))
      void checkPing()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('computerDetail.wolFailed'))
      await refreshWol()
    } finally {
      setWolBusy(false)
    }
  }, [detail, wolStatus?.user_may_wake, wolBusy, isOffline, refreshWol, checkPing, t, toast])

  if (!computerId) return null

  return createPortal(
    <div
      className={`fixed inset-0 ${overlayZClass} flex items-stretch justify-center bg-slate-900/40 p-0 backdrop-blur-sm sm:items-center sm:p-4`}
      role="dialog"
      aria-modal
      onClick={onClose}
    >
      <div
        className="app-card flex max-h-[100dvh] w-full max-w-none flex-col overflow-y-auto overscroll-contain rounded-none border-0 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] shadow-none ring-0 sm:max-h-[min(96vh,calc(100vh-0.5rem))] sm:max-w-[min(1600px,calc(100vw-1rem))] sm:rounded-2xl sm:border sm:border-slate-200/90 sm:p-6 sm:pt-6 sm:shadow-2xl sm:shadow-slate-900/15 sm:ring-1 sm:ring-white/40 lg:p-8 lg:pt-8"
        onClick={(e) => e.stopPropagation()}
      >
        {loading && !detail ? (
          <div className="py-12 text-center text-slate-500">{t('computerDetail.loading')}</div>
        ) : !detail ? (
          <div className="py-8">
            <p className="text-center text-sm text-slate-500">{t('computerDetail.noData')}</p>
            <button type="button" className="app-btn app-btn-secondary mt-4" onClick={onClose}>
              {t('computerDetail.close')}
            </button>
          </div>
        ) : detail ? (
          <>
            <div className="flex shrink-0 items-start justify-between gap-4">
              <div className="min-w-0 pr-2">
                <h2 className="text-xl font-semibold text-slate-900">{detail.hostname}</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {detail.manufacturer} {detail.model} · {detail.serial_number ?? t('computerDetail.noSerial')}
                  {detail.location ? ` · ${detail.location}` : ''}
                </p>
              </div>
              <button
                type="button"
                className="group shrink-0 rounded-xl border-2 border-slate-300 bg-white p-2.5 text-slate-600 shadow-md shadow-slate-900/10 ring-2 ring-slate-200/80 transition hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700 hover:ring-blue-200/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                onClick={onClose}
                aria-label={t('computerDetail.close')}
              >
                <IconClose className="h-6 w-6" />
              </button>
            </div>

            <div className="mt-4 grid shrink-0 grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-8">
              <section className="flex min-w-0 flex-col">
                <h3 className="shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                  {t('computerDetail.systemAndHardware')}
                </h3>
                <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 sm:gap-x-4 sm:gap-y-3">
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-slate-500">{t('computerDetail.os')}</dt>
                    <dd className="break-words text-slate-900">
                      {detail.os_name ?? '—'}{' '}
                      {detail.os_version ? (
                        <span className="text-slate-600">({detail.os_version})</span>
                      ) : null}
                    </dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-slate-500">{t('computerDetail.cpu')}</dt>
                    <dd className="break-words text-slate-900">{detail.cpu ?? '—'}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-slate-500">{t('computerDetail.ram')}</dt>
                    <dd className="text-slate-900">
                      {detail.ram_gb != null ? (
                        <span className="font-medium">{t('computerDetail.gb', { n: Math.round(detail.ram_gb) })}</span>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-slate-500">{t('computerDetail.gpu')}</dt>
                    <dd className="break-words text-slate-900">{detail.gpu_name ?? '—'}</dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-slate-500">{t('computerDetail.motherboard')}</dt>
                    <dd className="break-words text-slate-900">
                      {detail.motherboard_product || detail.motherboard_manufacturer ? (
                        <>
                          {detail.motherboard_manufacturer ? `${detail.motherboard_manufacturer} · ` : null}
                          {detail.motherboard_product ?? '—'}
                        </>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-slate-500">{t('computerDetail.mac')}</dt>
                    <dd className="font-mono text-slate-700">{detail.mac_primary ?? '—'}</dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2 rounded-xl border border-slate-200/70 bg-slate-50/60 px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                          {t('computerDetail.pingTitle')}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                          {pingBusy && !pingResult ? (
                            <span className="text-slate-500">{t('computerDetail.pingChecking')}</span>
                          ) : isOnline ? (
                            <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
                              <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
                              {t('computerDetail.pingOnline')}
                            </span>
                          ) : isOffline ? (
                            <span className="inline-flex items-center gap-1.5 font-medium text-rose-700">
                              <span className="h-2 w-2 rounded-full bg-rose-500" aria-hidden />
                              {t('computerDetail.pingOffline')}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-slate-500">
                              <span className="h-2 w-2 rounded-full bg-slate-300" aria-hidden />
                              {detail.ip_address
                                ? t('computerDetail.pingIp', { ip: detail.ip_address })
                                : t('computerDetail.pingUnknown')}
                            </span>
                          )}
                          {pingResult?.ip_address ? (
                            <span className="font-mono text-xs text-slate-500">{pingResult.ip_address}</span>
                          ) : null}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="app-btn app-btn-secondary shrink-0 text-sm"
                        disabled={pingBusy}
                        onClick={() => void checkPing()}
                      >
                        {pingBusy ? t('computerDetail.pingChecking') : t('computerDetail.pingCheck')}
                      </button>
                    </div>

                    {wolStatus?.user_may_wake ? (
                      <div className="mt-3 border-t border-slate-200/80 pt-2.5">
                        {wolStatus.force_disabled ? (
                          <p className="text-xs text-amber-800">{t('computerDetail.wolForceOff')}</p>
                        ) : isOnline ? (
                          <p className="text-xs text-slate-500">{t('computerDetail.wolAlreadyOn')}</p>
                        ) : canShowWake ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              className="app-btn app-btn-primary text-sm"
                              disabled={wolBusy}
                              onClick={() => void wakePc()}
                            >
                              {wolBusy ? t('computerDetail.wolBusy') : t('computerDetail.wolWake')}
                            </button>
                            {wolStatus.cooldown_remaining_seconds != null ? (
                              <span className="text-xs text-slate-500">
                                {t('computerDetail.wolCooldown', {
                                  n: wolStatus.cooldown_remaining_seconds,
                                })}
                              </span>
                            ) : null}
                          </div>
                        ) : !wolStatus.has_mac ? (
                          <p className="text-xs text-slate-500">{t('computerDetail.wolNoMac')}</p>
                        ) : wolStatus.cooldown_remaining_seconds != null ? (
                          <p className="text-xs text-slate-500">
                            {t('computerDetail.wolCooldown', {
                              n: wolStatus.cooldown_remaining_seconds,
                            })}
                          </p>
                        ) : pingBusy ? (
                          <p className="text-xs text-slate-500">{t('computerDetail.pingChecking')}</p>
                        ) : (
                          <p className="text-xs text-slate-500">{t('computerDetail.wolNeedOffline')}</p>
                        )}
                      </div>
                    ) : null}
                  </div>
                  {agentExtras?.primaryUser ? (
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="text-slate-500">{t('computerDetail.user')}</dt>
                      <dd className="break-words text-slate-900">{agentExtras.primaryUser}</dd>
                    </div>
                  ) : null}
                  {agentExtras?.gateways.length ? (
                    <div className="min-w-0">
                      <dt className="text-slate-500">{t('computerDetail.gateway')}</dt>
                      <dd className="font-mono text-sm text-slate-800">{agentExtras.gateways.join(', ')}</dd>
                    </div>
                  ) : null}
                  {agentExtras?.dnsV4.length ? (
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="text-slate-500">{t('computerDetail.dns')}</dt>
                      <dd className="font-mono text-sm text-slate-800">{agentExtras.dnsV4.join(' · ')}</dd>
                    </div>
                  ) : null}
                  {agentExtras?.wifiSsid ? (
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="text-slate-500">{t('computerDetail.wifi')}</dt>
                      <dd className="text-slate-900">{agentExtras.wifiSsid}</dd>
                    </div>
                  ) : null}
                  {agentExtras?.securityHint ? (
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="text-slate-500">{t('computerDetail.security')}</dt>
                      <dd className="text-slate-900">{agentExtras.securityHint}</dd>
                    </div>
                  ) : null}
                </dl>
                {agentExtras && agentExtras.patchIds.length > 0 ? (
                  <div className="mt-4 border-t border-slate-100 pt-3">
                    <dt className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                      {t('computerDetail.windowsPatches')}
                      {agentExtras.patchTotal > agentExtras.patchIds.length
                        ? ` · ${agentExtras.patchTotal}`
                        : ''}
                    </dt>
                    <dd className="mt-2 flex flex-wrap gap-1.5">
                      {agentExtras.patchIds.map((kb) => (
                        <span
                          key={kb}
                          className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-800"
                        >
                          {kb}
                        </span>
                      ))}
                    </dd>
                  </div>
                ) : null}
              </section>

              <section className="flex min-w-0 flex-col border-t border-slate-200/80 pt-4 lg:border-l lg:border-t-0 lg:border-slate-200/80 lg:pl-8 lg:pt-0">
                <h3 className="shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">{t('computerDetail.disks')}</h3>
                {(detail.disks?.length ?? 0) > 0 ? (
                  <div className="mt-2 flex flex-wrap content-start gap-2">
                    {(detail.disks ?? []).map((d, i) => (
                      <div
                        key={`${d.mount}-${i}`}
                        className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-slate-200/90 bg-white px-3 py-2 text-sm shadow-sm ring-1 ring-slate-100/80"
                      >
                        <span className="shrink-0 font-mono font-semibold text-slate-900">{d.mount}</span>
                        {d.label ? (
                          <span className="max-w-[10rem] truncate text-slate-500" title={d.label}>
                            {d.label}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                        <span className="hidden h-3 w-px shrink-0 bg-slate-200 sm:inline" aria-hidden />
                        <span className="text-slate-700">
                          {d.total_gb != null ? t('computerDetail.gb', { n: d.total_gb.toFixed(1) }) : '—'}
                        </span>
                        <span className="text-slate-500">{t('computerDetail.free')}</span>
                        <span className="font-mono text-slate-800">
                          {d.free_gb != null ? t('computerDetail.gb', { n: d.free_gb.toFixed(1) }) : '—'}
                        </span>
                        {d.used_percent != null ? (
                          <span
                            className={`ml-auto shrink-0 rounded-md px-2 py-0.5 font-mono text-xs font-medium sm:ml-0 ${
                              d.used_percent >= 90
                                ? 'bg-blue-100 text-blue-900'
                                : d.used_percent >= 75
                                  ? 'bg-amber-50 text-amber-950'
                                  : 'bg-zinc-100 text-neutral-900'
                            }`}
                          >
                            {d.used_percent}%
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-slate-500">
                    {t('computerDetail.noDiskData')}
                  </p>
                )}
                {agentExtras && agentExtras.physicalDisks.length > 0 ? (
                  <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
                    <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                      {t('computerDetail.media')}
                    </div>
                    {agentExtras.physicalDisks.map((pd, i) => (
                      <div
                        key={i}
                        className="rounded-lg border border-slate-200/90 bg-slate-50/60 px-3 py-2 text-sm"
                      >
                        <div className="font-medium text-slate-900">{pd.name}</div>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-600">
                          {pd.media ? (
                            <span className="rounded bg-white px-1.5 py-0.5 ring-1 ring-slate-200">{pd.media}</span>
                          ) : null}
                          {pd.health ? <span>{pd.health}</span> : null}
                          {pd.sizeGb != null ? <span>{t('computerDetail.gb', { n: pd.sizeGb })}</span> : null}
                        </div>
                      </div>
                    ))}
                    {agentExtras.batteryPercent != null ? (
                      <div className="text-xs text-slate-600">{t('computerDetail.battery', { n: agentExtras.batteryPercent })}</div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            </div>

            <div className="mt-6 shrink-0">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">{t('computerDetail.tags')}</h3>
              {user?.is_superuser ? (
                <div className="mt-2">
                  {allTags.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      {t('computerDetail.tagsDirectoryEmpty')}{' '}
                      <Link to="/settings/tags" className="font-medium text-blue-700 underline underline-offset-2 hover:text-neutral-800">
                        {t('computerDetail.tagsPage')}
                      </Link>
                      .
                    </p>
                  ) : (
                    <div className="max-h-56 overflow-y-auto rounded-xl border border-slate-200/70 bg-white p-2">
                      {allTags.map((t) => (
                        <label
                          key={t.id}
                          className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                            selectedTagIds.includes(t.id)
                              ? 'border-zinc-400 bg-zinc-50 text-neutral-950'
                              : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                          } mb-2 last:mb-0`}
                        >
                          <input
                            type="checkbox"
                            className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                            checked={selectedTagIds.includes(t.id)}
                            onChange={() => toggleTag(t.id)}
                          />
                          <span className="min-w-0 flex-1 break-words">{t.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-1">
                  {detail.tags.length === 0 ? (
                    <span className="text-sm text-slate-500">—</span>
                  ) : (
                    detail.tags.map((t) => {
                      const pill = tagPillProps(t)
                      return (
                        <span key={t.id} className={`${pill.className} px-2.5 py-1`} style={pill.style}>
                          {t.name}
                        </span>
                      )
                    })
                  )}
                </div>
              )}
            </div>

            <div className="mt-4 grid shrink-0 grid-cols-1 gap-4 lg:mt-6 lg:grid-cols-2 lg:items-start lg:gap-8">
              <section className="flex min-w-0 flex-col border-t border-slate-200/80 pt-4 lg:border-t-0 lg:pt-0">
                <h3 className="shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                  {t('computerDetail.officeVersions')}
                </h3>
                {agentExtras && agentExtras.office.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {agentExtras.office.map((o, i) => (
                      <span
                        key={i}
                        className="rounded-lg border border-slate-200/90 bg-white px-2.5 py-1 text-xs text-slate-800"
                        title={o.path ?? undefined}
                      >
                        {o.label}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-slate-500">{t('computerDetail.noData')}</p>
                )}
                <h3 className="mt-5 shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                  {t('computerDetail.installedSoftware')}
                </h3>
                <input
                  type="search"
                  placeholder={t('computerDetail.softwareSearch')}
                  value={swFilter}
                  onChange={(e) => setSwFilter(e.target.value)}
                  className="mt-2 w-full shrink-0 rounded-xl border border-slate-200/90 bg-slate-50/50 px-3 py-2.5 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-zinc-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
                <p className="mt-1 shrink-0 text-xs text-slate-500">
                  {softwareLoading
                    ? t('computerDetail.softwareLoading')
                    : t('computerDetail.shownCount', {
                        shown: filteredSoftware.length,
                        total: softwareTotal,
                      })}
                </p>
                <ul className="mt-2 max-h-[min(70vh,36rem)] min-h-[min(28vh,12rem)] overflow-y-auto overflow-x-hidden overscroll-contain rounded-xl border border-slate-200/90 bg-slate-50/80 text-sm ring-1 ring-slate-100/80 sm:min-h-[min(45vh,20rem)]">
                  {softwareLoading && softwareList.length === 0 ? (
                    <li className="px-3 py-4 text-slate-500">{t('computerDetail.loading')}</li>
                  ) : softwareList.length === 0 ? (
                    <li className="px-3 py-4 text-slate-500">{t('computerDetail.noRecords')}</li>
                  ) : filteredSoftware.length === 0 ? (
                    <li className="px-3 py-4 text-slate-500">{t('computerDetail.noSearchMatches')}</li>
                  ) : (
                    filteredSoftware.map((s, i) => (
                      <li
                        key={`${s.name}-${i}`}
                        className="border-b border-slate-100 px-3 py-2.5 last:border-0"
                      >
                        <span className="text-slate-900">{s.name}</span>
                        {s.version && (
                          <span className="ml-2 font-mono text-[13px] text-slate-600">{s.version}</span>
                        )}
                      </li>
                    ))
                  )}
                </ul>
              </section>

              <section className="flex min-w-0 flex-col border-t border-slate-200/80 pt-4 lg:border-t-0 lg:border-l lg:border-slate-200/80 lg:pl-8 lg:pt-0">
                <h3 className="shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                  {t('computerDetail.peripherals')}
                </h3>
                <ul className="mt-2 grid max-h-[min(70vh,36rem)] min-h-[min(28vh,12rem)] grid-cols-2 gap-1.5 overflow-y-auto overscroll-contain rounded-xl border border-zinc-200/70 bg-zinc-50/40 p-2 text-sm sm:min-h-[min(45vh,20rem)]">
                  {!peripheralGroups.length ? (
                    <li className="col-span-2 px-2 py-4 text-slate-500">
                      {t('computerDetail.noPeripheralData')}
                    </li>
                  ) : (
                    peripheralGroups.flatMap((g) =>
                      g.items.map((p, i) => (
                        <li
                          key={`${p.kind}-${p.name}-${i}`}
                          className="flex min-w-0 items-center gap-1 rounded-lg border border-zinc-100/90 bg-white px-2 py-1.5"
                          title={p.name}
                        >
                          <span className="w-1/2 shrink-0 truncate text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                            {t(`computerDetail.kinds.${g.kind as 'keyboard' | 'mouse' | 'monitor' | 'camera' | 'audio' | 'printer' | 'biometric' | 'bluetooth' | 'touchpad' | 'net'}`)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-xs text-slate-900">{p.name}</span>
                        </li>
                      )),
                    )
                  )}
                </ul>
              </section>
            </div>

            <div className="mt-6 shrink-0 border-t border-slate-200/80 pt-6">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                {t('computerDetail.history')}
              </h3>
              {historyLoading ? (
                <p className="mt-2 text-sm text-slate-500">{t('computerDetail.loading')}</p>
              ) : historyRows && historyRows.length > 0 ? (
                <ul className="mt-2 max-h-48 overflow-y-auto overflow-x-hidden rounded-xl border border-slate-200/90 bg-slate-50/80 text-xs text-slate-700">
                  {historyRows.map((h) => (
                    <li key={h.id} className="border-b border-slate-100 px-3 py-2 last:border-0">
                      <span className="whitespace-nowrap text-slate-500">{fmtDate(h.created_at, locale)}</span>
                      <span className="mt-1 block break-words text-slate-800 [overflow-wrap:anywhere] sm:ml-2 sm:mt-0 sm:inline">
                        {describeChange(h, t)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-slate-500">
                  {t('computerDetail.noHistory')}
                </p>
              )}
            </div>

            {user?.is_superuser && (
              <div className="mt-6 border-t border-slate-200 pt-4">
                <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                  {t('computerDetail.locationAssignment')}
                </h3>
                <div className="mt-2 grid grid-cols-1 items-end gap-2 sm:grid-cols-2 lg:grid-cols-12 lg:gap-x-3 lg:gap-y-2">
                  <div className="sm:col-span-1 lg:col-span-5">
                    <label className="text-xs font-medium text-slate-500">{t('computerDetail.locationRoom')}</label>
                    <input
                      className="mt-1 w-full rounded-lg border border-slate-200/90 bg-slate-50/50 px-2.5 py-2 text-sm text-slate-900 transition focus:border-zinc-500 focus:bg-white focus:ring-2 focus:ring-blue-500/20"
                      value={locationDraft}
                      onChange={(e) => setLocationDraft(e.target.value)}
                      placeholder={t('computerDetail.locationPlaceholder')}
                    />
                  </div>
                  <div className="sm:col-span-1 lg:col-span-3">
                    <label className="text-xs font-medium text-slate-500">{t('computerDetail.userId')}</label>
                    <input
                      className="mt-1 w-full rounded-lg border border-slate-200/90 bg-slate-50/50 px-2.5 py-2 font-mono text-sm transition focus:border-zinc-500 focus:bg-white focus:ring-2 focus:ring-blue-500/20"
                      value={assignUserId}
                      onChange={(e) => setAssignUserId(e.target.value)}
                      placeholder="1"
                    />
                  </div>
                  <div className="sm:col-span-2 lg:col-span-4">
                    <label className="text-xs font-medium text-slate-500">{t('computerDetail.note')}</label>
                    <textarea
                      className="mt-1 w-full resize-y rounded-lg border border-slate-200/90 bg-slate-50/50 px-2.5 py-2 text-sm text-slate-900 transition focus:border-zinc-500 focus:bg-white focus:ring-2 focus:ring-blue-500/20"
                      rows={2}
                      value={notesDraft}
                      onChange={(e) => setNotesDraft(e.target.value)}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void saveMeta()}
                  className="app-btn app-btn-primary mt-3"
                >
                  {t('computerDetail.save')}
                </button>
              </div>
            )}

            {user?.is_superuser && (
              <div className="mt-8 shrink-0 border-t border-slate-200 pt-6">
                <button
                  type="button"
                  onClick={() => void deletePc()}
                  className="app-btn app-btn-danger w-full sm:w-auto"
                >
                  {t('computerDetail.deletePc')}
                </button>
                <p className="mt-2 text-xs text-slate-500">{t('computerDetail.deletePcHint')}</p>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
