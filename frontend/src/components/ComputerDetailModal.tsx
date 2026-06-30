import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { api, type AssetChangeLog, type ComputerDetail, type TagBrief } from '../api'
import { useAuth } from '../AuthContext'
import { parseAgentExtras } from '../computerAgentExtras'
import { groupPeripheralsForDisplay } from '../peripheralDisplay'
import { IconClose } from './icons'

const KIND_RU: Record<string, string> = {
  keyboard: 'Клавиатура',
  mouse: 'Мышь',
  monitor: 'Монитор',
  camera: 'Камера',
  audio: 'Аудио',
  printer: 'Принтер',
  biometric: 'Биометрия',
  bluetooth: 'Bluetooth',
  touchpad: 'Тачпад',
  net: 'Сеть',
}

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

export function fmtDate(iso: string | null) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('ru-RU')
  } catch {
    return iso
  }
}

function describeChange(h: AssetChangeLog): string {
  const src = h.source === 'agent' ? 'агент' : 'панель'
  if (h.kind === 'field' && h.field_key) {
    return `${h.field_key}: ${h.old_value ?? '—'} → ${h.new_value ?? '—'} (${src})`
  }
  if (h.kind === 'software_list' && h.payload_json) {
    try {
      const p = JSON.parse(h.payload_json) as {
        added_total?: number
        removed_total?: number
        previous_count?: number
        new_count?: number
      }
      return `ПО: +${p.added_total ?? 0} / −${p.removed_total ?? 0} (всего ${p.previous_count ?? '?'} → ${p.new_count ?? '?'}) (${src})`
    } catch {
      return `ПО: изменения (${src})`
    }
  }
  if (h.kind === 'peripheral_list' && h.payload_json) {
    try {
      const p = JSON.parse(h.payload_json) as {
        added_total?: number
        removed_total?: number
      }
      return `Периферия: +${p.added_total ?? 0} / −${p.removed_total ?? 0} (${src})`
    } catch {
      return `Периферия: изменения (${src})`
    }
  }
  if (h.kind === 'meta' && h.field_key === 'tags' && h.payload_json) {
    return `Теги обновлены (${src})`
  }
  return `${h.kind} (${src})`
}

type Props = {
  computerId: number | null
  onClose: () => void
  onChanged?: () => void
  overlayZClass?: string
}

export function ComputerDetailModal({
  computerId,
  onClose,
  onChanged,
  overlayZClass = 'z-50',
}: Props) {
  const { user } = useAuth()
  const [detail, setDetail] = useState<ComputerDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notesDraft, setNotesDraft] = useState('')
  const [locationDraft, setLocationDraft] = useState('')
  const [historyRows, setHistoryRows] = useState<AssetChangeLog[] | null>(null)
  const [assignUserId, setAssignUserId] = useState('')
  const [swFilter, setSwFilter] = useState('')
  const [allTags, setAllTags] = useState<TagBrief[]>([])
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([])

  useEffect(() => {
    if (!computerId) {
      setDetail(null)
      setHistoryRows(null)
      setErr(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setErr(null)
    void Promise.all([api.computer(computerId), api.computerHistory(computerId, 120)])
      .then(([d, hist]) => {
        if (cancelled) return
        setDetail(d)
        setNotesDraft(d.notes ?? '')
        setLocationDraft(d.location ?? '')
        setSelectedTagIds(d.tags.map((t) => t.id))
        setAssignUserId(d.assigned_user_id != null ? String(d.assigned_user_id) : '')
        setSwFilter('')
        setHistoryRows(hist)
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Ошибка')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [computerId])

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

  const filteredSoftware = useMemo(() => {
    if (!detail) return []
    const q = swFilter.trim().toLowerCase()
    if (!q) return detail.software
    return detail.software.filter((s) => s.name.toLowerCase().includes(q))
  }, [detail, swFilter])

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
    setErr(null)
    const t = assignUserId.trim()
    let assigned: number | undefined
    if (t === '') assigned = 0
    else {
      const n = Number.parseInt(t, 10)
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
      setErr(e instanceof Error ? e.message : 'Не удалось сохранить')
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
  ])

  const deletePc = useCallback(async () => {
    if (!detail || !user?.is_superuser) return
    if (
      !confirm(
        `Удалить «${detail.hostname}» из базы вместе с ПО и периферией? Действие необратимо.`,
      )
    ) {
      return
    }
    setErr(null)
    try {
      await api.deleteComputer(detail.id)
      onChanged?.()
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось удалить')
    }
  }, [detail, user?.is_superuser, onChanged, onClose])

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
          <div className="py-12 text-center text-slate-500">Загрузка…</div>
        ) : err && !detail ? (
          <div className="py-8">
            <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{err}</p>
            <button type="button" className="app-btn app-btn-secondary mt-4" onClick={onClose}>
              Закрыть
            </button>
          </div>
        ) : detail ? (
          <>
            <div className="flex shrink-0 items-start justify-between gap-4">
              <div className="min-w-0 pr-2">
                <h2 className="text-xl font-semibold text-slate-900">{detail.hostname}</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {detail.manufacturer} {detail.model} · {detail.serial_number ?? 'нет серийника'}
                  {detail.location ? ` · ${detail.location}` : ''}
                </p>
              </div>
              <button
                type="button"
                className="group shrink-0 rounded-xl border-2 border-slate-300 bg-white p-2.5 text-slate-600 shadow-md shadow-slate-900/10 ring-2 ring-slate-200/80 transition hover:border-red-400 hover:bg-red-50 hover:text-red-700 hover:ring-red-200/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
                onClick={onClose}
                aria-label="Закрыть"
              >
                <IconClose className="h-6 w-6" />
              </button>
            </div>

            {err ? (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
                {err}
              </div>
            ) : null}

            <div className="mt-4 grid shrink-0 grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-8">
              <section className="flex min-w-0 flex-col">
                <h3 className="shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                  Система и железо
                </h3>
                <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 sm:gap-x-4 sm:gap-y-3">
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-slate-500">ОС</dt>
                    <dd className="break-words text-slate-900">
                      {detail.os_name ?? '—'}{' '}
                      {detail.os_version ? (
                        <span className="text-slate-600">({detail.os_version})</span>
                      ) : null}
                    </dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-slate-500">Процессор (CPU)</dt>
                    <dd className="break-words text-slate-900">{detail.cpu ?? '—'}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-slate-500">ОЗУ</dt>
                    <dd className="text-slate-900">
                      {detail.ram_gb != null ? (
                        <span className="font-medium">{Math.round(detail.ram_gb)} ГБ</span>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-slate-500">Видеокарта (GPU)</dt>
                    <dd className="break-words text-slate-900">{detail.gpu_name ?? '—'}</dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-slate-500">Материнская плата</dt>
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
                    <dt className="text-slate-500">MAC</dt>
                    <dd className="font-mono text-slate-700">{detail.mac_primary ?? '—'}</dd>
                  </div>
                  {agentExtras?.primaryUser ? (
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="text-slate-500">Пользователь</dt>
                      <dd className="break-words text-slate-900">{agentExtras.primaryUser}</dd>
                    </div>
                  ) : null}
                  {agentExtras?.gateways.length ? (
                    <div className="min-w-0">
                      <dt className="text-slate-500">Шлюз</dt>
                      <dd className="font-mono text-sm text-slate-800">{agentExtras.gateways.join(', ')}</dd>
                    </div>
                  ) : null}
                  {agentExtras?.dnsV4.length ? (
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="text-slate-500">DNS</dt>
                      <dd className="font-mono text-sm text-slate-800">{agentExtras.dnsV4.join(' · ')}</dd>
                    </div>
                  ) : null}
                  {agentExtras?.wifiSsid ? (
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="text-slate-500">Wi‑Fi</dt>
                      <dd className="text-slate-900">{agentExtras.wifiSsid}</dd>
                    </div>
                  ) : null}
                  {agentExtras?.securityHint ? (
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="text-slate-500">Безопасность</dt>
                      <dd className="text-slate-900">{agentExtras.securityHint}</dd>
                    </div>
                  ) : null}
                </dl>
                {agentExtras && agentExtras.patchIds.length > 0 ? (
                  <div className="mt-4 border-t border-slate-100 pt-3">
                    <dt className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                      Патчи Windows
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
                <h3 className="shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Диски</h3>
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
                          {d.total_gb != null ? `${d.total_gb.toFixed(1)} ГБ` : '—'}
                        </span>
                        <span className="text-slate-500">своб.</span>
                        <span className="font-mono text-slate-800">
                          {d.free_gb != null ? `${d.free_gb.toFixed(1)} ГБ` : '—'}
                        </span>
                        {d.used_percent != null ? (
                          <span
                            className={`ml-auto shrink-0 rounded-md px-2 py-0.5 font-mono text-xs font-medium sm:ml-0 ${
                              d.used_percent >= 90
                                ? 'bg-red-100 text-red-900'
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
                    Нет данных по дискам — запустите <code className="text-xs">corax_send.bat</code>.
                  </p>
                )}
                {agentExtras && agentExtras.physicalDisks.length > 0 ? (
                  <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
                    <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                      Носители
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
                          {pd.sizeGb != null ? <span>{pd.sizeGb} ГБ</span> : null}
                        </div>
                      </div>
                    ))}
                    {agentExtras.batteryPercent != null ? (
                      <div className="text-xs text-slate-600">Батарея: {agentExtras.batteryPercent}%</div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            </div>

            <div className="mt-6 shrink-0">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Теги</h3>
              {user?.is_superuser ? (
                <div className="mt-2">
                  {allTags.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      Справочник пуст. Добавьте теги в разделе{' '}
                      <Link to="/settings/tags" className="font-medium text-red-700 underline underline-offset-2 hover:text-neutral-800">
                        Теги ПК
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
                            className="rounded border-slate-300 text-red-600 focus:ring-red-500"
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
                  Версии Office
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
                  <p className="mt-2 text-sm text-slate-500">Нет данных</p>
                )}
                <h3 className="mt-5 shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                  Установленное ПО
                </h3>
                <input
                  type="search"
                  placeholder="Поиск в списке ПО…"
                  value={swFilter}
                  onChange={(e) => setSwFilter(e.target.value)}
                  className="mt-2 w-full shrink-0 rounded-xl border border-slate-200/90 bg-slate-50/50 px-3 py-2.5 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-zinc-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500/20"
                />
                <p className="mt-1 shrink-0 text-xs text-slate-500">
                  Показано: {filteredSoftware.length} из {detail.software.length}
                </p>
                <ul className="mt-2 max-h-[min(70vh,36rem)] min-h-[min(28vh,12rem)] overflow-y-auto overflow-x-hidden overscroll-contain rounded-xl border border-slate-200/90 bg-slate-50/80 text-sm ring-1 ring-slate-100/80 sm:min-h-[min(45vh,20rem)]">
                  {detail.software.length === 0 ? (
                    <li className="px-3 py-4 text-slate-500">Нет записей</li>
                  ) : filteredSoftware.length === 0 ? (
                    <li className="px-3 py-4 text-slate-500">Нет совпадений по поиску</li>
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
                  Периферия (PnP)
                </h3>
                <ul className="mt-2 grid max-h-[min(70vh,36rem)] min-h-[min(28vh,12rem)] grid-cols-2 gap-1.5 overflow-y-auto overscroll-contain rounded-xl border border-zinc-200/70 bg-zinc-50/40 p-2 text-sm sm:min-h-[min(45vh,20rem)]">
                  {!peripheralGroups.length ? (
                    <li className="col-span-2 px-2 py-4 text-slate-500">
                      Нет данных — запустите <code className="text-xs">corax_send.bat</code>.
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
                            {KIND_RU[g.kind] ?? g.kind}
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
                История изменений
              </h3>
              {historyRows && historyRows.length > 0 ? (
                <ul className="mt-2 max-h-48 overflow-y-auto overflow-x-hidden rounded-xl border border-slate-200/90 bg-slate-50/80 text-xs text-slate-700">
                  {historyRows.map((h) => (
                    <li key={h.id} className="border-b border-slate-100 px-3 py-2 last:border-0">
                      <span className="whitespace-nowrap text-slate-500">{fmtDate(h.created_at)}</span>
                      <span className="mt-1 block break-words text-slate-800 [overflow-wrap:anywhere] sm:ml-2 sm:mt-0 sm:inline">
                        {describeChange(h)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-slate-500">
                  Пока нет записей (появятся после повторной отправки агента или правок в панели).
                </p>
              )}
            </div>

            {user?.is_superuser && (
              <div className="mt-6 border-t border-slate-200 pt-4">
                <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                  Локация и закрепление
                </h3>
                <div className="mt-2 grid grid-cols-1 items-end gap-2 sm:grid-cols-2 lg:grid-cols-12 lg:gap-x-3 lg:gap-y-2">
                  <div className="sm:col-span-1 lg:col-span-5">
                    <label className="text-xs font-medium text-slate-500">Локация / помещение</label>
                    <input
                      className="mt-1 w-full rounded-lg border border-slate-200/90 bg-slate-50/50 px-2.5 py-2 text-sm text-slate-900 transition focus:border-zinc-500 focus:bg-white focus:ring-2 focus:ring-red-500/20"
                      value={locationDraft}
                      onChange={(e) => setLocationDraft(e.target.value)}
                      placeholder="офис 3, этаж 2"
                    />
                  </div>
                  <div className="sm:col-span-1 lg:col-span-3">
                    <label className="text-xs font-medium text-slate-500">ID пользователя (0 — снять)</label>
                    <input
                      className="mt-1 w-full rounded-lg border border-slate-200/90 bg-slate-50/50 px-2.5 py-2 font-mono text-sm transition focus:border-zinc-500 focus:bg-white focus:ring-2 focus:ring-red-500/20"
                      value={assignUserId}
                      onChange={(e) => setAssignUserId(e.target.value)}
                      placeholder="1"
                    />
                  </div>
                  <div className="sm:col-span-2 lg:col-span-4">
                    <label className="text-xs font-medium text-slate-500">Заметка</label>
                    <textarea
                      className="mt-1 w-full resize-y rounded-lg border border-slate-200/90 bg-slate-50/50 px-2.5 py-2 text-sm text-slate-900 transition focus:border-zinc-500 focus:bg-white focus:ring-2 focus:ring-red-500/20"
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
                  Сохранить
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
                  Удалить ПК из базы
                </button>
                <p className="mt-2 text-xs text-slate-500">Удаляет машину вместе с ПО, периферией и историей. Необратимо.</p>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
