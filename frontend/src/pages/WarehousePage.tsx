import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api,
  type WarehousePreset,
  type WarehouseRoom,
  type WarehouseStockItem,
} from '../api'
import { useAuth } from '../AuthContext'
import { IconClose, IconTrash, IconWarehouse } from '../components/icons'
import { useLocale, useT, type MessageKey } from '../i18n/LocaleContext'

function fmtWhen(iso: string | null | undefined, locale: 'ru' | 'en') {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

const PRESET_LABEL_KEYS: Record<string, MessageKey> = {
  ram: 'warehouse.presets.ram',
  ssd: 'warehouse.presets.ssd',
  hdd: 'warehouse.presets.hdd',
  cpu: 'warehouse.presets.cpu',
  gpu: 'warehouse.presets.gpu',
  motherboard: 'warehouse.presets.motherboard',
  psu: 'warehouse.presets.psu',
  case: 'warehouse.presets.case',
  switch: 'warehouse.presets.switch',
  ap: 'warehouse.presets.ap',
  router: 'warehouse.presets.router',
  patch_cord: 'warehouse.presets.patch_cord',
  monitor: 'warehouse.presets.monitor',
  peripheral: 'warehouse.presets.peripheral',
  other: 'warehouse.presets.other',
  custom: 'warehouse.presets.custom',
}

function presetLabel(t: (key: MessageKey) => string, key: string, fallback?: string | null) {
  const msgKey = PRESET_LABEL_KEYS[key]
  if (msgKey) return t(msgKey)
  return fallback?.trim() || key
}

export function WarehousePage() {
  const t = useT()
  const { locale } = useLocale()
  const { user } = useAuth()
  const canEdit = Boolean(user?.is_superuser || user?.role === 'editor')

  const [rooms, setRooms] = useState<WarehouseRoom[]>([])
  const [presets, setPresets] = useState<WarehousePreset[]>([])
  const [activeRoomId, setActiveRoomId] = useState<number | null>(null)
  const [items, setItems] = useState<WarehouseStockItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [roomMenuOpen, setRoomMenuOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)

  const [roomDialog, setRoomDialog] = useState<null | { mode: 'create' | 'rename'; title: string }>(null)
  const [roomBusy, setRoomBusy] = useState(false)

  const [transferItemId, setTransferItemId] = useState<number | null>(null)
  const [transferToId, setTransferToId] = useState<number | null>(null)
  const [transferBusy, setTransferBusy] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [addPreset, setAddPreset] = useState<WarehousePreset | null>(null)
  const [addName, setAddName] = useState('')
  const [addQty, setAddQty] = useState(1)
  const [addTracking, setAddTracking] = useState<'unit' | 'lot'>('lot')
  const [addCondition, setAddCondition] = useState<'new' | 'used' | 'defective'>('new')
  const [addBatch, setAddBatch] = useState('')
  const [addNotes, setAddNotes] = useState('')
  const [addAutoCode, setAddAutoCode] = useState(true)
  const [addBusy, setAddBusy] = useState(false)

  const activeRoom = useMemo(
    () => rooms.find((r) => r.id === activeRoomId) ?? null,
    [rooms, activeRoomId],
  )

  const presetsByGroup = useMemo(() => {
    const map = new Map<string, WarehousePreset[]>()
    for (const p of presets) {
      const g = p.group || 'other'
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(p)
    }
    return map
  }, [presets])

  const transferTarget = useMemo(
    () => items.find((i) => i.id === transferItemId) ?? null,
    [items, transferItemId],
  )

  const otherRooms = useMemo(
    () => rooms.filter((r) => r.id !== (transferTarget?.room_id ?? activeRoomId)),
    [rooms, transferTarget, activeRoomId],
  )

  const reload = useCallback(async () => {
    setErr(null)
    const [roomRows, presetRows] = await Promise.all([api.warehouseRooms(), api.warehousePresets()])
    setRooms(roomRows)
    setPresets(presetRows)
    setActiveRoomId((prev) => {
      if (prev && roomRows.some((r) => r.id === prev)) return prev
      return roomRows[0]?.id ?? null
    })
  }, [])

  const reloadItems = useCallback(async (roomId: number | null, q: string) => {
    if (!roomId) {
      setItems([])
      return
    }
    const rows = await api.warehouseItems({
      room_id: roomId,
      q: q.trim() || undefined,
    })
    setItems(rows)
  }, [])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        await reload()
      } catch (e) {
        setErr(e instanceof Error ? e.message : t('common.error'))
      } finally {
        setLoading(false)
      }
    })()
  }, [reload])

  useEffect(() => {
    if (!activeRoomId) return
    void (async () => {
      try {
        await reloadItems(activeRoomId, search)
      } catch (e) {
        setErr(e instanceof Error ? e.message : t('common.error'))
      }
    })()
  }, [activeRoomId, search, reloadItems])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(t)
  }, [toast])

  const submitRoomDialog = async () => {
    if (!canEdit || !roomDialog) return
    const title = roomDialog.title.trim()
    if (!title) return
    setRoomBusy(true)
    setErr(null)
    try {
      if (roomDialog.mode === 'create') {
        const created = await api.createWarehouseRoom({ title })
        await reload()
        setActiveRoomId(created.id)
        setToast(t('warehouse.roomCreated'))
      } else if (activeRoom) {
        await api.patchWarehouseRoom(activeRoom.id, { title })
        await reload()
        setToast(t('warehouse.roomRenamed'))
      }
      setRoomDialog(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('warehouse.roomSaveFailed'))
    } finally {
      setRoomBusy(false)
    }
  }

  const deleteRoom = async () => {
    if (!canEdit || !activeRoom) return
    setRoomMenuOpen(false)
    if (rooms.length <= 1) {
      setErr(t('warehouse.roomDeleteOnlyOne'))
      return
    }
    if (!window.confirm(t('warehouse.roomDeleteConfirm', { title: activeRoom.title }))) return
    try {
      await api.deleteWarehouseRoom(activeRoom.id)
      await reload()
      setToast(t('warehouse.roomDeleted'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('warehouse.roomDeleteFailed'))
    }
  }

  const openAdd = (preset: WarehousePreset) => {
    if (!canEdit || !activeRoomId) return
    setAddMenuOpen(false)
    setAddPreset(preset)
    setAddName(presetLabel(t, preset.key, preset.name))
    setAddTracking(preset.default_tracking === 'unit' ? 'unit' : 'lot')
    setAddQty(1)
    setAddCondition('new')
    setAddBatch('')
    setAddNotes('')
    setAddAutoCode(preset.default_tracking === 'unit')
    setAddOpen(true)
  }

  const submitAdd = async () => {
    if (!canEdit || !activeRoomId || !addPreset) return
    const name = addName.trim()
    if (!name) return
    setAddBusy(true)
    setErr(null)
    try {
      await api.createWarehouseItem({
        room_id: activeRoomId,
        preset_key: addPreset.key,
        name,
        tracking_mode: addTracking,
        quantity: addTracking === 'lot' ? addQty : 1,
        condition: addCondition,
        batch_label: addBatch.trim() || null,
        notes: addNotes.trim() || null,
        auto_code: addTracking === 'unit' && addAutoCode,
      })
      setAddOpen(false)
      await reload()
      await reloadItems(activeRoomId, search)
      setToast(t('warehouse.itemAdded'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('warehouse.itemAddFailed'))
    } finally {
      setAddBusy(false)
    }
  }

  const writeOff = async (item: WarehouseStockItem) => {
    if (!canEdit) return
    if (!window.confirm(t('warehouse.writeOffConfirm', { name: item.name }))) return
    try {
      await api.writeOffWarehouseItem(item.id)
      if (activeRoomId) await reloadItems(activeRoomId, search)
      await reload()
      setToast(t('warehouse.itemWrittenOff'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('warehouse.writeOffFailed'))
    }
  }

  const openTransfer = (item: WarehouseStockItem) => {
    if (!canEdit) return
    const others = rooms.filter((r) => r.id !== item.room_id)
    if (!others.length) {
      setErr(t('warehouse.noOtherRoom'))
      return
    }
    setTransferItemId(item.id)
    setTransferToId(others[0]?.id ?? null)
  }

  const submitTransfer = async () => {
    if (!canEdit || !transferItemId || !transferToId) return
    setTransferBusy(true)
    setErr(null)
    try {
      await api.transferWarehouseItem(transferItemId, { to_room_id: transferToId })
      setTransferItemId(null)
      if (activeRoomId) await reloadItems(activeRoomId, search)
      await reload()
      setToast(t('warehouse.itemMoved'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('warehouse.transferFailed'))
    } finally {
      setTransferBusy(false)
    }
  }

  const deleteItem = async (item: WarehouseStockItem) => {
    if (!canEdit) return
    if (!window.confirm(t('warehouse.deleteConfirm', { name: item.name }))) return
    try {
      await api.deleteWarehouseItem(item.id)
      if (activeRoomId) await reloadItems(activeRoomId, search)
      await reload()
      setToast(t('warehouse.itemDeleted'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('warehouse.deleteFailed'))
    }
  }

  return (
    <div>
      <div className="mb-6 flex min-w-0 flex-wrap items-start justify-between gap-3 sm:mb-8 sm:gap-4">
        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
          <div className="page-hero-icon mt-0.5 shrink-0">
            <IconWarehouse className="h-6 w-6" />
          </div>
          <div>
            <h1 className="page-title">{t('titles.warehouse')}</h1>
            <p className="mt-1 max-w-2xl text-sm text-[var(--color-fg-muted)]">
              {t('pages.warehouseSubtitle')}
            </p>
          </div>
        </div>
        {!canEdit ? (
          <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-1 text-xs font-medium text-[var(--color-fg-muted)]">
            {t('warehouse.viewOnly')}
          </span>
        ) : null}
      </div>

      {err ? <div className="app-alert app-alert-error mb-4">{err}</div> : null}
      {toast ? <div className="app-alert app-alert-success mb-4">{toast}</div> : null}

      <div className="flex flex-col gap-4 lg:flex-row">
        <aside className="lg:w-56 shrink-0">
          <div className="app-panel-sm">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                {t('warehouse.rooms')}
              </span>
              {canEdit ? (
                <div className="relative">
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-xs font-semibold text-[var(--color-primary)] hover:bg-[var(--color-primary-muted)]"
                    onClick={() => setRoomMenuOpen((v) => !v)}
                    aria-expanded={roomMenuOpen}
                  >
                    ⋮
                  </button>
                  {roomMenuOpen ? (
                    <div className="absolute right-0 z-20 mt-1 min-w-[10rem] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg">
                      <button
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
                        onClick={() => {
                          setRoomMenuOpen(false)
                          setRoomDialog({
                            mode: 'create',
                            title: t('warehouse.roomDefaultName', { n: rooms.length + 1 }),
                          })
                        }}
                      >
                        + {t('warehouse.create')}
                      </button>
                      <button
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
                        onClick={() => {
                          if (!activeRoom) return
                          setRoomMenuOpen(false)
                          setRoomDialog({ mode: 'rename', title: activeRoom.title })
                        }}
                        disabled={!activeRoom}
                      >
                        {t('warehouse.rename')}
                      </button>
                      <button
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm text-[var(--color-primary)] hover:bg-[var(--color-primary-muted)] disabled:opacity-50"
                        onClick={() => void deleteRoom()}
                        disabled={!activeRoom}
                      >
                        {t('common.delete')}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <ul className="space-y-1">
              {rooms.map((r) => {
                const active = activeRoomId === r.id
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setActiveRoomId(r.id)}
                      className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                        active
                          ? 'bg-[var(--color-primary-muted)] text-[var(--color-fg)] ring-1 ring-[var(--color-primary)]/40'
                          : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
                      }`}
                    >
                      <span className="truncate">{r.title}</span>
                      <span
                        className={`ml-2 shrink-0 text-xs tabular-nums ${
                          active ? 'text-[var(--color-primary)]' : 'text-[var(--color-fg-subtle)]'
                        }`}
                      >
                        {r.item_count}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
            {canEdit ? (
              <button
                type="button"
                onClick={() =>
                  setRoomDialog({
                    mode: 'create',
                    title: t('warehouse.roomDefaultName', { n: rooms.length + 1 }),
                  })
                }
                className="mt-2 w-full rounded-xl border border-dashed border-[var(--color-border)] px-3 py-2 text-sm font-medium text-[var(--color-fg-muted)] transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
              >
                {t('warehouse.addRoom')}
              </button>
            ) : null}
          </div>
        </aside>

        <section className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('warehouse.searchPlaceholder')}
              className="app-input min-w-[12rem] flex-1"
              aria-label={t('warehouse.searchAria')}
            />
            {canEdit && activeRoomId ? (
              <div className="relative">
                <button
                  type="button"
                  className="app-btn app-btn-primary"
                  onClick={() => setAddMenuOpen((v) => !v)}
                  aria-expanded={addMenuOpen}
                >
                  {t('warehouse.addButton')}
                </button>
                {addMenuOpen ? (
                  <div className="absolute right-0 z-30 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-xl">
                    {[...presetsByGroup.entries()].map(([group, list]) => (
                      <div key={group} className="mb-2 last:mb-0">
                        <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
                          {t(`warehouse.groups.${group as 'components' | 'network' | 'other'}`)}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {list.map((p) => (
                            <button
                              key={p.key}
                              type="button"
                              onClick={() => openAdd(p)}
                              className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-fg)] transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
                            >
                              {presetLabel(t, p.key, p.name)}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {activeRoom?.notes ? (
            <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-sm text-[var(--color-fg-muted)]">
              {activeRoom.notes}
            </p>
          ) : null}

          <div className="app-card overflow-hidden !p-0">
            {loading ? (
              <div className="px-4 py-10 text-center text-sm text-[var(--color-fg-subtle)]">
                {t('warehouse.loadingItems')}
              </div>
            ) : items.length === 0 ? (
              <div className="app-empty-state !rounded-none border-0">
                {activeRoom ? t('warehouse.emptyRoom') : t('warehouse.selectRoom')}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="app-table min-w-[640px]">
                  <thead className="app-table-head">
                    <tr>
                      <th className="px-3 py-2.5">{t('warehouse.columns.typeName')}</th>
                      <th className="px-3 py-2.5">{t('warehouse.columns.code')}</th>
                      <th className="px-3 py-2.5">{t('warehouse.columns.quantity')}</th>
                      <th className="px-3 py-2.5">{t('warehouse.columns.condition')}</th>
                      <th className="px-3 py-2.5">{t('warehouse.columns.updated')}</th>
                      {canEdit ? <th className="px-3 py-2.5 text-right">{t('warehouse.columns.actions')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} className="app-table-row">
                        <td className="app-table-cell align-top">
                          <div className="font-medium">{item.name}</div>
                          <div className="text-xs text-[var(--color-fg-subtle)]">
                            {presetLabel(t, item.preset_key, item.preset_name)}
                          </div>
                          {item.batch_label ? (
                            <div className="mt-0.5 text-xs text-[var(--color-fg-subtle)]">
                              {t('warehouse.batch', { label: item.batch_label })}
                            </div>
                          ) : null}
                          {item.notes ? (
                            <div className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{item.notes}</div>
                          ) : null}
                        </td>
                        <td className="app-table-cell align-top font-mono text-xs">
                          {item.internal_code ?? '—'}
                        </td>
                        <td className="app-table-cell align-top">
                          {item.tracking_mode === 'lot'
                            ? t('warehouse.quantityMany', { n: item.quantity_available })
                            : t('warehouse.quantityOne')}
                        </td>
                        <td className="app-table-cell align-top text-xs">
                          {t(`warehouse.conditions.${item.condition as 'new' | 'used' | 'defective'}`)}
                        </td>
                        <td className="app-table-cell align-top text-xs text-[var(--color-fg-subtle)]">
                          {fmtWhen(item.updated_at, locale)}
                        </td>
                        {canEdit ? (
                          <td className="app-table-cell align-top text-right">
                            <div className="flex justify-end gap-1">
                              {rooms.length > 1 ? (
                                <button
                                  type="button"
                                  title={t('warehouse.moveTitle')}
                                  className="rounded-lg px-2 py-1 text-xs font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
                                  onClick={() => openTransfer(item)}
                                >
                                  ↔
                                </button>
                              ) : null}
                              <button
                                type="button"
                                title={t('warehouse.writeOff')}
                                className="rounded-lg px-2 py-1 text-xs font-medium text-[var(--color-warning-fg)] hover:bg-[var(--color-warning-bg)]"
                                onClick={() => void writeOff(item)}
                              >
                                {t('warehouse.writeOff')}
                              </button>
                              <button
                                type="button"
                                title={t('warehouse.deleteRecord')}
                                className="rounded-lg p-1 text-[var(--color-fg-subtle)] hover:bg-[var(--color-primary-muted)] hover:text-[var(--color-primary)]"
                                onClick={() => void deleteItem(item)}
                              >
                                <IconTrash className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>

      {roomDialog ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
          <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-2xl">
            <div className="mb-3 flex items-start justify-between gap-2">
              <h2 className="text-lg font-semibold text-[var(--color-fg)]">
                {roomDialog.mode === 'create'
                  ? t('warehouse.roomDialogCreate')
                  : t('warehouse.roomDialogRename')}
              </h2>
              <button
                type="button"
                className="rounded-lg p-1 text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-muted)]"
                onClick={() => setRoomDialog(null)}
              >
                <IconClose className="h-5 w-5" />
              </button>
            </div>
            <label className="block">
              <span className="app-label">{t('warehouse.roomName')}</span>
              <input
                value={roomDialog.title}
                onChange={(e) => setRoomDialog((d) => (d ? { ...d, title: e.target.value } : d))}
                className="app-input"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void submitRoomDialog()
                  }
                }}
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="app-btn app-btn-secondary" onClick={() => setRoomDialog(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={roomBusy || !roomDialog.title.trim()}
                className="app-btn app-btn-primary"
                onClick={() => void submitRoomDialog()}
              >
                {roomBusy ? t('warehouse.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {transferTarget ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
          <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-2xl">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t('warehouse.moveTitle')}</h2>
                <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">{transferTarget.name}</p>
              </div>
              <button
                type="button"
                className="rounded-lg p-1 text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-muted)]"
                onClick={() => setTransferItemId(null)}
              >
                <IconClose className="h-5 w-5" />
              </button>
            </div>
            <label className="block">
              <span className="app-label">{t('warehouse.transferTo')}</span>
              <select
                value={transferToId ?? ''}
                onChange={(e) => setTransferToId(Number(e.target.value))}
                className="app-input"
              >
                {otherRooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="app-btn app-btn-secondary" onClick={() => setTransferItemId(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={transferBusy || !transferToId}
                className="app-btn app-btn-primary"
                onClick={() => void submitTransfer()}
              >
                {transferBusy ? t('warehouse.moving') : t('warehouse.moveTitle')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {addOpen && addPreset ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
          <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-2xl">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-[var(--color-fg)]">
                  {t('warehouse.addDialogTitle', { name: presetLabel(t, addPreset.key, addPreset.name) })}
                </h2>
                <p className="text-xs text-[var(--color-fg-subtle)]">{activeRoom?.title}</p>
              </div>
              <button
                type="button"
                className="rounded-lg p-1 text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-muted)]"
                onClick={() => setAddOpen(false)}
              >
                <IconClose className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3">
              <label className="block">
                <span className="app-label">{t('warehouse.addName')}</span>
                <input
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  className="app-input"
                  placeholder={t('warehouse.addNamePlaceholder')}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="app-label">{t('warehouse.tracking')}</span>
                  <select
                    value={addTracking}
                    onChange={(e) => setAddTracking(e.target.value as 'unit' | 'lot')}
                    className="app-input"
                  >
                    <option value="lot">{t('warehouse.trackingLot')}</option>
                    <option value="unit">{t('warehouse.trackingUnit')}</option>
                  </select>
                </label>
                {addTracking === 'lot' ? (
                  <label className="block">
                    <span className="app-label">{t('warehouse.quantityLabel')}</span>
                    <input
                      type="number"
                      min={1}
                      max={9999}
                      value={addQty}
                      onChange={(e) => setAddQty(Math.max(1, Number(e.target.value) || 1))}
                      className="app-input"
                    />
                  </label>
                ) : (
                  <label className="flex items-end gap-2 pb-2">
                    <input
                      type="checkbox"
                      checked={addAutoCode}
                      onChange={(e) => setAddAutoCode(e.target.checked)}
                      className="rounded border-[var(--color-border)]"
                    />
                    <span className="text-xs text-[var(--color-fg-muted)]">{t('warehouse.autoCode')}</span>
                  </label>
                )}
              </div>
              <label className="block">
                <span className="app-label">{t('warehouse.conditionLabel')}</span>
                <select
                  value={addCondition}
                  onChange={(e) => setAddCondition(e.target.value as 'new' | 'used' | 'defective')}
                  className="app-input"
                >
                  <option value="new">{t('warehouse.conditions.new')}</option>
                  <option value="used">{t('warehouse.conditions.used')}</option>
                  <option value="defective">{t('warehouse.conditions.defective')}</option>
                </select>
              </label>
              {addTracking === 'lot' ? (
                <label className="block">
                  <span className="app-label">{t('warehouse.batchOptional')}</span>
                  <input
                    value={addBatch}
                    onChange={(e) => setAddBatch(e.target.value)}
                    className="app-input"
                    placeholder="Kingston 2024-03"
                  />
                </label>
              ) : null}
              <label className="block">
                <span className="app-label">{t('warehouse.note')}</span>
                <textarea
                  value={addNotes}
                  onChange={(e) => setAddNotes(e.target.value)}
                  rows={2}
                  className="app-input resize-y"
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="app-btn app-btn-secondary" onClick={() => setAddOpen(false)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={addBusy || !addName.trim()}
                className="app-btn app-btn-primary"
                onClick={() => void submitAdd()}
              >
                {addBusy ? t('warehouse.saving') : t('warehouse.addToWarehouse')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
