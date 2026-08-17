import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import {
  api,
  type WarehouseMovement,
  type WarehousePreset,
  type WarehouseRoom,
  type WarehouseStockItem,
} from '../api'
import { useAuth } from '../AuthContext'
import { IconClose, IconInfo, IconTrash } from '../components/icons'
import { useLocale, useT, type MessageKey } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

type GroupFilter = 'all' | 'components' | 'peripherals' | 'network' | 'other'
type PageView = 'stock' | 'history'

const GROUP_ORDER: GroupFilter[] = ['components', 'peripherals', 'network', 'other']

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
  cooler: 'warehouse.presets.cooler',
  optical: 'warehouse.presets.optical',
  printer: 'warehouse.presets.printer',
  mouse: 'warehouse.presets.mouse',
  keyboard: 'warehouse.presets.keyboard',
  headset: 'warehouse.presets.headset',
  webcam: 'warehouse.presets.webcam',
  cartridge: 'warehouse.presets.cartridge',
  docking: 'warehouse.presets.docking',
  ups: 'warehouse.presets.ups',
  cable_usb: 'warehouse.presets.cable_usb',
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

function groupLabelKey(group: string): MessageKey {
  if (group === 'components' || group === 'peripherals' || group === 'network' || group === 'other') {
    return `warehouse.groups.${group}` as MessageKey
  }
  return 'warehouse.groups.other'
}

function movementLabelKey(kind: string): MessageKey {
  if (kind === 'receipt') return 'warehouse.movementReceipt'
  if (kind === 'write_off') return 'warehouse.movementWriteOff'
  if (kind === 'transfer') return 'warehouse.movementTransfer'
  if (kind === 'adjust') return 'warehouse.movementAdjust'
  return 'warehouse.movementOther'
}

function typeLook() {
  return {
    head: 'border-l-[3px] border-l-[var(--color-primary)] bg-[var(--color-primary-muted)]',
    badge: 'bg-[var(--color-primary)] text-white',
    pill: 'bg-[var(--color-primary-muted)] text-[var(--color-primary)]',
  }
}

function FilterChip({
  active,
  onClick,
  label,
  qty,
}: {
  active: boolean
  onClick: () => void
  label: string
  qty?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
        active
          ? 'bg-[var(--color-primary)] text-white'
          : 'bg-[var(--color-bg-muted)] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]'
      }`}
    >
      <span>{label}</span>
      {qty != null ? (
        <span className={`tabular-nums ${active ? 'text-white/80' : 'opacity-70'}`}>{qty}</span>
      ) : null}
    </button>
  )
}

function conditionTone() {
  return 'bg-[var(--color-primary-muted)] text-[var(--color-primary)]'
}

function itemQty(item: WarehouseStockItem) {
  return Math.max(0, item.quantity_available ?? item.quantity ?? 0)
}

function clampQty(n: number) {
  return Math.max(1, Math.min(9999, Math.trunc(n) || 1))
}

function stockCondition(condition: string): 'new' | 'used' {
  return condition === 'new' ? 'new' : 'used'
}

export function WarehousePage() {
  const t = useT()
  const toast = useToast()
  const { locale } = useLocale()
  const { user } = useAuth()
  const canEdit = Boolean(user?.is_superuser || user?.role === 'editor')
  const isAdmin = Boolean(user?.is_superuser)
  const helpRef = useRef<HTMLDivElement>(null)

  const [rooms, setRooms] = useState<WarehouseRoom[]>([])
  const [presets, setPresets] = useState<WarehousePreset[]>([])
  const [activeRoomId, setActiveRoomId] = useState<number | null>(null)
  const [items, setItems] = useState<WarehouseStockItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState<GroupFilter>('all')
  const [view, setView] = useState<PageView>('stock')
  const [roomMenuOpen, setRoomMenuOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  const [movements, setMovements] = useState<WarehouseMovement[]>([])
  const [historyBusy, setHistoryBusy] = useState(false)

  const [roomDialog, setRoomDialog] = useState<null | {
    mode: 'create' | 'rename'
    title: string
    notes: string
  }>(null)
  const [roomBusy, setRoomBusy] = useState(false)

  const [transferItemId, setTransferItemId] = useState<number | null>(null)
  const [transferToId, setTransferToId] = useState<number | null>(null)
  const [transferBusy, setTransferBusy] = useState(false)

  const [writeOffItem, setWriteOffItem] = useState<WarehouseStockItem | null>(null)
  const [writeOffQty, setWriteOffQty] = useState(1)
  const [writeOffReason, setWriteOffReason] = useState('')
  const [writeOffBusy, setWriteOffBusy] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [itemDialogMode, setItemDialogMode] = useState<'add' | 'edit'>('add')
  const [editItemId, setEditItemId] = useState<number | null>(null)
  const [addPreset, setAddPreset] = useState<WarehousePreset | null>(null)
  const [addName, setAddName] = useState('')
  const [addManufacturer, setAddManufacturer] = useState('')
  const [addQty, setAddQty] = useState(1)
  const [addCondition, setAddCondition] = useState<'new' | 'used'>('new')
  const [addBatch, setAddBatch] = useState('')
  const [addNotes, setAddNotes] = useState('')
  const [addAutoCode, setAddAutoCode] = useState(true)
  const [addBusy, setAddBusy] = useState(false)

  const activeRoom = useMemo(
    () => rooms.find((r) => r.id === activeRoomId) ?? null,
    [rooms, activeRoomId],
  )

  const presetGroupByKey = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of presets) map.set(p.key, p.group || 'other')
    return map
  }, [presets])

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

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (groupFilter === 'all') return true
      const g = presetGroupByKey.get(item.preset_key) || 'other'
      return g === groupFilter
    })
  }, [items, groupFilter, presetGroupByKey])

  const groupQtyTotals = useMemo(() => {
    const totals: Record<string, number> = { all: 0 }
    for (const g of GROUP_ORDER) totals[g] = 0
    for (const item of items) {
      const q = itemQty(item)
      totals.all += q
      const g = presetGroupByKey.get(item.preset_key) || 'other'
      totals[g] = (totals[g] ?? 0) + q
    }
    return totals
  }, [items, presetGroupByKey])

  const sectionsFrom = useCallback(
    (list: WarehouseStockItem[]) => {
      const byPreset = new Map<string, WarehouseStockItem[]>()
      for (const item of list) {
        const key = item.preset_key || 'other'
        if (!byPreset.has(key)) byPreset.set(key, [])
        byPreset.get(key)!.push(item)
      }
      const orderedKeys: string[] = []
      for (const g of GROUP_ORDER) {
        for (const p of presetsByGroup.get(g) ?? []) {
          if (byPreset.has(p.key)) orderedKeys.push(p.key)
        }
      }
      for (const key of byPreset.keys()) {
        if (!orderedKeys.includes(key)) orderedKeys.push(key)
      }
      return orderedKeys.map((key) => {
        const rows = byPreset.get(key) ?? []
        const qty = rows.reduce((sum, row) => sum + itemQty(row), 0)
        const sample = rows[0]
        return {
          key,
          label: presetLabel(t, key, sample?.preset_name),
          group: presetGroupByKey.get(key) || 'other',
          qty,
          rows,
        }
      })
    },
    [presetsByGroup, presetGroupByKey, t],
  )

  const stockSections = useMemo(() => sectionsFrom(filteredItems), [filteredItems, sectionsFrom])
  const hasStock = stockSections.length > 0

  const reload = useCallback(async () => {
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

  const reloadHistory = useCallback(async (roomId: number | null) => {
    setHistoryBusy(true)
    try {
      const rows = await api.warehouseMovements({
        room_id: roomId ?? undefined,
        limit: 200,
      })
      setMovements(rows)
    } finally {
      setHistoryBusy(false)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        await reload()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : t('common.error'))
      } finally {
        setLoading(false)
      }
    })()
  }, [reload, t, toast])

  useEffect(() => {
    if (!activeRoomId) return
    void (async () => {
      try {
        await reloadItems(activeRoomId, search)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : t('common.error'))
      }
    })()
  }, [activeRoomId, search, reloadItems, t, toast])

  useEffect(() => {
    if (view !== 'history') return
    void reloadHistory(activeRoomId).catch((e) => {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    })
  }, [view, activeRoomId, reloadHistory, t, toast])

  useEffect(() => {
    if (!helpOpen) return
    const onDoc = (e: MouseEvent) => {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) setHelpOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [helpOpen])

  const submitRoomDialog = async () => {
    if (!canEdit || !roomDialog) return
    const title = roomDialog.title.trim()
    if (!title) return
    setRoomBusy(true)
    try {
      if (roomDialog.mode === 'create') {
        const created = await api.createWarehouseRoom({
          title,
          notes: roomDialog.notes.trim() || null,
        })
        await reload()
        setActiveRoomId(created.id)
        toast.ok(t('warehouse.roomCreated'))
      } else if (activeRoom) {
        await api.patchWarehouseRoom(activeRoom.id, {
          title,
          notes: roomDialog.notes.trim() || null,
        })
        await reload()
        toast.ok(t('warehouse.roomRenamed'))
      }
      setRoomDialog(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('warehouse.roomSaveFailed'))
    } finally {
      setRoomBusy(false)
    }
  }

  const deleteRoom = async () => {
    if (!canEdit || !activeRoom) return
    setRoomMenuOpen(false)
    const qty = activeRoom.item_count ?? 0
    const ok =
      qty > 0
        ? window.confirm(t('warehouse.roomDeleteWithItemsConfirm', { title: activeRoom.title, n: qty }))
        : window.confirm(t('warehouse.roomDeleteConfirm', { title: activeRoom.title }))
    if (!ok) return
    try {
      await api.deleteWarehouseRoom(activeRoom.id, { purge: qty > 0 })
      await reload()
      toast.ok(t('warehouse.roomDeleted'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('warehouse.roomDeleteFailed'))
    }
  }

  const openAdd = (preset: WarehousePreset) => {
    if (!canEdit || !activeRoomId) return
    setAddMenuOpen(false)
    setItemDialogMode('add')
    setEditItemId(null)
    setAddPreset(preset)
    setAddName('')
    setAddManufacturer('')
    setAddQty(1)
    setAddCondition('new')
    setAddBatch('')
    setAddNotes('')
    setAddAutoCode(true)
    setAddOpen(true)
  }

  const closeItemDialog = () => {
    setAddOpen(false)
    setEditItemId(null)
    setItemDialogMode('add')
  }

  const openEdit = (item: WarehouseStockItem) => {
    if (!canEdit) return
    const preset =
      presets.find((p) => p.key === item.preset_key) ?? {
        key: item.preset_key,
        name: item.preset_name || item.preset_key,
        group: 'other',
        default_tracking: item.tracking_mode,
      }
    setItemDialogMode('edit')
    setEditItemId(item.id)
    setAddPreset(preset)
    setAddName(item.name)
    setAddManufacturer(item.manufacturer ?? '')
    setAddQty(Math.max(1, item.quantity_available || 1))
    setAddCondition(stockCondition(item.condition))
    setAddBatch(item.batch_label ?? '')
    setAddNotes(item.notes ?? '')
    setAddAutoCode(false)
    setAddOpen(true)
  }

  const submitAdd = async () => {
    if (!canEdit || !addPreset) return
    const name = addName.trim()
    if (!name) return
    setAddBusy(true)
    try {
      if (itemDialogMode === 'edit' && editItemId != null) {
        await api.patchWarehouseItem(editItemId, {
          name,
          manufacturer: addManufacturer.trim() || null,
          condition: addCondition,
          batch_label: addBatch.trim() || null,
          notes: addNotes.trim() || null,
          quantity: addQty,
        })
        closeItemDialog()
        if (activeRoomId) await reloadItems(activeRoomId, search)
        await reload()
        toast.ok(t('warehouse.itemSaved'))
        return
      }
      if (!activeRoomId) return
      await api.createWarehouseItem({
        room_id: activeRoomId,
        preset_key: addPreset.key,
        name,
        manufacturer: addManufacturer.trim() || null,
        tracking_mode: 'lot',
        quantity: addQty,
        condition: addCondition,
        batch_label: addBatch.trim() || null,
        notes: addNotes.trim() || null,
        auto_code: addAutoCode,
      })
      closeItemDialog()
      await reload()
      await reloadItems(activeRoomId, search)
      toast.ok(t('warehouse.itemAdded'))
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : itemDialogMode === 'edit'
            ? t('warehouse.itemSaveFailed')
            : t('warehouse.itemAddFailed'),
      )
    } finally {
      setAddBusy(false)
    }
  }

  const openWriteOff = (item: WarehouseStockItem) => {
    if (!canEdit) return
    setWriteOffItem(item)
    setWriteOffQty(1)
    setWriteOffReason('')
  }

  const submitWriteOff = async (all: boolean) => {
    if (!canEdit || !writeOffItem) return
    const available = itemQty(writeOffItem)
    const qty = all ? available : Math.max(1, Math.min(writeOffQty, available))
    setWriteOffBusy(true)
    try {
      await api.writeOffWarehouseItem(writeOffItem.id, {
        quantity: qty,
        comment: writeOffReason.trim() || null,
      })
      setWriteOffItem(null)
      if (activeRoomId) await reloadItems(activeRoomId, search)
      await reload()
      if (view === 'history') await reloadHistory(activeRoomId)
      toast.ok(qty > 1 ? t('warehouse.itemsWrittenOffN', { n: qty }) : t('warehouse.itemWrittenOff'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('warehouse.writeOffFailed'))
    } finally {
      setWriteOffBusy(false)
    }
  }

  const openTransfer = (item: WarehouseStockItem) => {
    if (!canEdit) return
    const others = rooms.filter((r) => r.id !== item.room_id)
    if (!others.length) {
      toast.error(t('warehouse.noOtherRoom'))
      return
    }
    setTransferItemId(item.id)
    setTransferToId(others[0]?.id ?? null)
  }

  const submitTransfer = async () => {
    if (!canEdit || !transferItemId || !transferToId) return
    setTransferBusy(true)
    try {
      await api.transferWarehouseItem(transferItemId, { to_room_id: transferToId })
      setTransferItemId(null)
      if (activeRoomId) await reloadItems(activeRoomId, search)
      await reload()
      if (view === 'history') await reloadHistory(activeRoomId)
      toast.ok(t('warehouse.itemMoved'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('warehouse.transferFailed'))
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
      toast.ok(t('warehouse.itemDeleted'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('warehouse.deleteFailed'))
    }
  }

  const deleteHistoryRow = async (m: WarehouseMovement) => {
    if (!isAdmin) return
    if (!window.confirm(t('warehouse.historyDeleteConfirm'))) return
    try {
      await api.deleteWarehouseMovement(m.id)
      await reloadHistory(activeRoomId)
      toast.ok(t('warehouse.historyDeleted'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('warehouse.historyDeleteFailed'))
    }
  }

  const clearHistory = async () => {
    if (!isAdmin) return
    const msg = activeRoomId ? t('warehouse.historyClearConfirm') : t('warehouse.historyClearAllConfirm')
    if (!window.confirm(msg)) return
    try {
      const r = await api.clearWarehouseMovements(activeRoomId)
      await reloadHistory(activeRoomId)
      toast.ok(t('warehouse.historyCleared', { n: r.deleted }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('warehouse.historyClearFailed'))
    }
  }

  const groupChips: { id: GroupFilter; label: string; qty: number }[] = [
    { id: 'all', label: t('warehouse.filterAll'), qty: groupQtyTotals.all ?? 0 },
    ...GROUP_ORDER.map((id) => ({
      id,
      label: t(groupLabelKey(id)),
      qty: groupQtyTotals[id] ?? 0,
    })),
  ]

  const renderTypeCards = (sectionList: typeof stockSections) => {
    if (!sectionList.length) return null
    const qty = sectionList.reduce((sum, row) => sum + row.qty, 0)
    return (
      <div className="space-y-4">
        <div className="flex items-baseline gap-2 px-0.5 pt-1">
          <span className="text-xs tabular-nums text-[var(--color-fg-muted)]">
            {t('warehouse.sectionQty', { n: qty })}
          </span>
        </div>
        <div className="space-y-4">
          {sectionList.map((section) => {
            const look = typeLook()
            return (
              <article
                key={section.key}
                className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
              >
                <header className={`flex flex-wrap items-center gap-2 px-3 py-2.5 ${look.head}`}>
                  <span className="text-[15px] font-semibold text-[var(--color-fg)]">{section.label}</span>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${look.pill}`}>
                    {t(groupLabelKey(section.group))}
                  </span>
                  <span className="text-xs text-[var(--color-fg-subtle)]">
                    {t('warehouse.itemsCount', { n: section.rows.length })}
                  </span>
                  <span className={`ml-auto inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${look.badge}`}>
                    {t('warehouse.sectionQty', { n: section.qty })}
                  </span>
                </header>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead className="border-b border-[var(--color-border)] bg-[var(--color-bg-muted)]/50 text-xs uppercase tracking-wide text-[var(--color-fg-subtle)]">
                      <tr>
                        <th className="px-3 py-2">{t('warehouse.columns.name')}</th>
                        <th className="app-hide-xs px-3 py-2">{t('warehouse.columns.manufacturer')}</th>
                        <th className="px-3 py-2">{t('warehouse.columns.quantity')}</th>
                        <th className="px-3 py-2">{t('warehouse.columns.condition')}</th>
                        <th className="app-hide-xs px-3 py-2">{t('warehouse.columns.updated')}</th>
                        {canEdit ? <th className="px-3 py-2">{t('warehouse.columns.actions')}</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {section.rows.map((item) => (
                        <tr
                          key={item.id}
                          className={`border-b border-[var(--color-border)]/70 last:border-b-0 ${
                            canEdit ? 'cursor-pointer hover:bg-[var(--color-bg-muted)]/50' : ''
                          }`}
                          onClick={() => {
                            if (canEdit) openEdit(item)
                          }}
                        >
                          <td className="px-3 py-2">
                            <div className="font-medium">{item.name}</div>
                            <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-[var(--color-fg-subtle)]">
                              {item.internal_code ? (
                                <span className="font-mono" title={t('warehouse.skHelp')}>
                                  {item.internal_code}
                                </span>
                              ) : null}
                              {item.batch_label ? <span>{t('warehouse.batch', { label: item.batch_label })}</span> : null}
                              {item.notes ? <span className="truncate">{item.notes}</span> : null}
                            </div>
                          </td>
                          <td className="app-hide-xs px-3 py-2 text-[var(--color-fg-muted)]">
                            {item.manufacturer || '—'}
                          </td>
                          <td className="px-3 py-2 tabular-nums">
                            {t('warehouse.quantityMany', { n: itemQty(item) })}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${conditionTone()}`}>
                              {t(`warehouse.conditions.${stockCondition(item.condition)}`)}
                            </span>
                          </td>
                          <td className="app-hide-xs px-3 py-2 text-[var(--color-fg-subtle)]">
                            {fmtWhen(item.updated_at, locale)}
                          </td>
                          {canEdit ? (
                            <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                              <div className="flex flex-wrap items-center gap-1">
                                {rooms.length > 1 ? (
                                  <button
                                    type="button"
                                    className="rounded-md px-2 py-1 text-xs font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                                    onClick={() => openTransfer(item)}
                                  >
                                    {t('warehouse.moveTitle')}
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="rounded-md px-2 py-1 text-xs font-medium text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
                                  onClick={() => openWriteOff(item)}
                                >
                                  {t('warehouse.writeOff')}
                                </button>
                                <button
                                  type="button"
                                  title={t('warehouse.deleteRecord')}
                                  className="rounded-md p-1 text-[var(--color-fg-subtle)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
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
              </article>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
      <h1 className="sr-only">{t('titles.warehouse')}</h1>
      {!canEdit ? (
        <div className="flex justify-end">
          <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-1 text-xs font-medium text-[var(--color-fg-muted)]">
            {t('warehouse.viewOnly')}
          </span>
        </div>
      ) : null}

      <div className="flex flex-col gap-4 lg:flex-row">
        <aside className="shrink-0 lg:w-56">
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="px-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
                {t('warehouse.rooms')}
              </span>
              {canEdit ? (
                <div className="relative">
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-xs font-semibold text-[var(--color-primary)] hover:bg-[var(--color-primary-muted)]"
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
                            notes: '',
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
                          setRoomDialog({
                            mode: 'rename',
                            title: activeRoom.title,
                            notes: activeRoom.notes ?? '',
                          })
                        }}
                        disabled={!activeRoom}
                      >
                        {t('warehouse.rename')}
                      </button>
                      <button
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
                        onClick={() => void deleteRoom()}
                        disabled={!activeRoom}
                      >
                        {(activeRoom?.item_count ?? 0) > 0
                          ? t('warehouse.roomDeleteAll')
                          : t('warehouse.roomDelete')}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <ul className="flex flex-col gap-px">
              {rooms.map((r) => {
                const active = activeRoomId === r.id
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setActiveRoomId(r.id)}
                      className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left transition ${
                        active
                          ? 'bg-[var(--color-primary-muted)] text-[var(--color-fg)]'
                          : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
                      }`}
                    >
                      <span className={`truncate ${active ? 'text-[14px] font-semibold' : 'text-[13px] font-medium'}`}>
                        {r.title}
                      </span>
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
                    notes: '',
                  })
                }
                className="mt-2 w-full rounded-md border border-dashed border-[var(--color-border)] px-2.5 py-1.5 text-[13px] font-medium text-[var(--color-fg-muted)] transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
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
            <div className="inline-flex h-9 w-[13rem] shrink-0 rounded-lg border border-[var(--color-border)] p-0.5">
              {(['stock', 'history'] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setView(id)
                    setAddMenuOpen(false)
                  }}
                  className={`min-w-0 flex-1 rounded-md text-sm font-medium ${
                    view === id
                      ? 'bg-[var(--color-primary)] text-white'
                      : 'text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  {id === 'stock' ? t('warehouse.tabStock') : t('warehouse.tabHistory')}
                </button>
              ))}
            </div>
            <div className="relative" ref={helpRef}>
              <button
                type="button"
                className="rounded-lg p-2 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
                aria-label={t('warehouse.helpAria')}
                aria-expanded={helpOpen}
                onClick={() => setHelpOpen((v) => !v)}
              >
                <IconInfo className="h-4 w-4" />
              </button>
              {helpOpen ? (
                <div className="absolute right-0 z-30 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-xl">
                  <p className="text-xs font-semibold text-[var(--color-fg)]">{t('warehouse.helpTitle')}</p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">{t('warehouse.skHelp')}</p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">{t('warehouse.csvHint')}</p>
                  <Link
                    to="/settings/glpi"
                    className="mt-2 inline-block text-[12px] font-medium text-[var(--color-primary)] hover:underline"
                    onClick={() => setHelpOpen(false)}
                  >
                    {t('warehouse.glpiSettingsLink')}
                  </Link>
                </div>
              ) : null}
            </div>
            <div className="flex h-9 min-w-[9.75rem] items-center justify-end gap-2">
              {isAdmin && view === 'history' && movements.length > 0 ? (
                <button
                  type="button"
                  className="app-btn app-btn-secondary text-sm"
                  onClick={() => void clearHistory()}
                >
                  {t('warehouse.historyClear')}
                </button>
              ) : null}
              {canEdit && activeRoomId ? (
                <div className={`relative ${view === 'stock' ? '' : 'invisible pointer-events-none'}`}>
                  <button
                    type="button"
                    className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white"
                    onClick={() => setAddMenuOpen((v) => !v)}
                    aria-expanded={addMenuOpen}
                  >
                    {t('warehouse.addButton')}
                  </button>
                  {addMenuOpen ? (
                    <div className="absolute right-0 z-30 mt-1 max-h-[min(28rem,70vh)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-xl">
                      {GROUP_ORDER.map((group) => {
                        const list = presetsByGroup.get(group) ?? []
                        if (!list.length) return null
                        return (
                          <div key={group} className="mb-2 last:mb-0">
                            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--color-fg-subtle)]">
                              {t(groupLabelKey(group))}
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {list.map((p) => (
                                <button
                                  key={p.key}
                                  type="button"
                                  onClick={() => openAdd(p)}
                                  className="rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium text-[var(--color-fg)] transition hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-primary-muted)] hover:text-[var(--color-fg)]"
                                >
                                  {presetLabel(t, p.key, p.name)}
                                </button>
                              ))}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
          {view === 'stock' ? (
            <div className="flex flex-wrap gap-1.5">
              {groupChips.map((chip) => (
                <FilterChip
                  key={chip.id}
                  active={groupFilter === chip.id}
                  onClick={() => setGroupFilter(chip.id)}
                  label={chip.label}
                  qty={chip.qty}
                />
              ))}
            </div>
          ) : null}
          </div>

          {activeRoom?.notes ? (
            <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-sm text-[var(--color-fg-muted)]">
              {activeRoom.notes}
            </p>
          ) : null}

          {view === 'history' ? (
            historyBusy ? (
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-10 text-center text-sm text-[var(--color-fg-subtle)]">
                {t('warehouse.loadingItems')}
              </div>
            ) : movements.length === 0 ? (
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-12 text-center text-sm text-[var(--color-fg-muted)]">
                {t('warehouse.historyEmpty')}
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
                <table className="min-w-full text-left text-sm">
                  <thead className="border-b border-[var(--color-border)] bg-[var(--color-bg-muted)]/60 text-xs uppercase tracking-wide text-[var(--color-fg-subtle)]">
                    <tr>
                      <th className="px-3 py-2.5">{t('warehouse.columns.updated')}</th>
                      <th className="px-3 py-2.5">{t('warehouse.columns.type')}</th>
                      <th className="px-3 py-2.5">{t('warehouse.columns.quantity')}</th>
                      <th className="px-3 py-2.5">{t('warehouse.columns.name')}</th>
                      <th className="app-hide-xs px-3 py-2.5">{t('warehouse.columns.code')}</th>
                      {isAdmin ? <th className="w-10 px-3 py-2.5" /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {movements.map((m) => (
                      <tr key={m.id} className="border-b border-[var(--color-border)]/70">
                        <td className="whitespace-nowrap px-3 py-2 text-[var(--color-fg-subtle)]">
                          {fmtWhen(m.created_at, locale)}
                        </td>
                        <td className="px-3 py-2">
                          <span className="inline-flex rounded-full bg-[var(--color-bg-muted)] px-2 py-0.5 text-xs font-medium">
                            {t(movementLabelKey(m.movement_kind))}
                          </span>
                        </td>
                        <td className="px-3 py-2 tabular-nums">{t('warehouse.movementQty', { n: m.quantity })}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{m.item_name || `#${m.item_id}`}</div>
                          <div className="mt-0.5 text-xs text-[var(--color-fg-subtle)]">
                            {m.manufacturer ? <span>{m.manufacturer}</span> : null}
                            {m.from_room_title || m.to_room_title ? (
                              <span>
                                {m.manufacturer ? ' · ' : ''}
                                {m.from_room_title || '—'} → {m.to_room_title || '—'}
                              </span>
                            ) : null}
                            {m.created_by_name ? <span>{m.manufacturer || m.from_room_title ? ' · ' : ''}{m.created_by_name}</span> : null}
                            {m.comment ? <span>{' · '}{m.comment}</span> : null}
                          </div>
                        </td>
                        <td className="app-hide-xs px-3 py-2 font-mono text-xs text-[var(--color-fg-subtle)]">
                          {m.item_code || '—'}
                        </td>
                        {isAdmin ? (
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              title={t('warehouse.deleteRecord')}
                              className="rounded-md p-1 text-[var(--color-fg-subtle)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
                              onClick={() => void deleteHistoryRow(m)}
                            >
                              <IconTrash className="h-4 w-4" />
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : loading ? (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-10 text-center text-sm text-[var(--color-fg-subtle)]">
              {t('warehouse.loadingItems')}
            </div>
          ) : !hasStock ? (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-12 text-center">
              <p className="text-sm font-medium text-[var(--color-fg)]">
              {!activeRoom
                ? rooms.length === 0
                  ? t('warehouse.emptyRooms')
                  : t('warehouse.selectRoom')
                : items.length > 0
                    ? t('warehouse.emptyFilters')
                    : t('warehouse.emptyRoom')}
              </p>
              {activeRoom && items.length === 0 ? (
                <p className="mx-auto mt-2 max-w-lg text-sm text-[var(--color-fg-muted)]">{t('warehouse.emptyHint')}</p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-12">{renderTypeCards(stockSections)}</div>
          )}
        </section>
      </div>

      {roomDialog
        ? createPortal(
            <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/40 p-3 sm:items-center">
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
                <label className="mt-3 block">
                  <span className="app-label">{t('warehouse.roomNotes')}</span>
                  <textarea
                    value={roomDialog.notes}
                    onChange={(e) => setRoomDialog((d) => (d ? { ...d, notes: e.target.value } : d))}
                    className="app-input min-h-[4.5rem] resize-y"
                    placeholder={t('warehouse.roomNotesPlaceholder')}
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
            </div>,
            document.body,
          )
        : null}

      {transferTarget
        ? createPortal(
            <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/40 p-3 sm:items-center">
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
            </div>,
            document.body,
          )
        : null}

      {writeOffItem
        ? createPortal(
            <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/40 p-3 sm:items-center">
              <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-2xl">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t('warehouse.writeOffTitle')}</h2>
                    <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">
                      {t('warehouse.writeOffWhat', { name: writeOffItem.name })}
                      {writeOffItem.manufacturer ? ` · ${writeOffItem.manufacturer}` : ''}
                      {writeOffItem.internal_code ? ` · ${writeOffItem.internal_code}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="rounded-lg p-1 text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-muted)]"
                    onClick={() => setWriteOffItem(null)}
                  >
                    <IconClose className="h-5 w-5" />
                  </button>
                </div>
                <p className="text-sm text-[var(--color-fg)]">
                  {t('warehouse.writeOffOnHand', { n: itemQty(writeOffItem) })}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-fg-subtle)]">
                  {t('warehouse.writeOffScope')}
                </p>
                {itemQty(writeOffItem) > 1 ? (
                  <label className="mt-3 block">
                    <span className="app-label">{t('warehouse.writeOffQtyLabel')}</span>
                    <input
                      type="number"
                      min={1}
                      max={itemQty(writeOffItem)}
                      value={writeOffQty}
                      onChange={(e) =>
                        setWriteOffQty(Math.max(1, Math.min(itemQty(writeOffItem), Number(e.target.value) || 1)))
                      }
                      className="app-input"
                    />
                  </label>
                ) : null}
                <label className="mt-3 block">
                  <span className="app-label">{t('warehouse.writeOffReason')}</span>
                  <input
                    value={writeOffReason}
                    onChange={(e) => setWriteOffReason(e.target.value)}
                    className="app-input"
                    placeholder={t('warehouse.writeOffReasonPlaceholder')}
                  />
                </label>
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <button type="button" className="app-btn app-btn-secondary" onClick={() => setWriteOffItem(null)}>
                    {t('common.cancel')}
                  </button>
                  {itemQty(writeOffItem) > 1 ? (
                    <button
                      type="button"
                      disabled={writeOffBusy}
                      className="app-btn app-btn-secondary"
                      onClick={() => void submitWriteOff(true)}
                    >
                      {t('warehouse.writeOffAll', { n: itemQty(writeOffItem) })}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={writeOffBusy}
                    className="app-btn app-btn-secondary"
                    onClick={() => void submitWriteOff(false)}
                  >
                    {writeOffBusy ? t('warehouse.writeOffBusy') : t('warehouse.writeOffSubmit')}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      {addOpen && addPreset
        ? createPortal(
            <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/40 p-3 sm:items-center">
              <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-2xl">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-semibold text-[var(--color-fg)]">
                      {itemDialogMode === 'edit' ? t('warehouse.editDialogHeading') : t('warehouse.addDialogHeading')}
                    </h2>
                    <p className="text-xs text-[var(--color-fg-subtle)]">{activeRoom?.title}</p>
                  </div>
                  <button
                    type="button"
                    className="rounded-lg p-1 text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-muted)]"
                    onClick={closeItemDialog}
                  >
                    <IconClose className="h-5 w-5" />
                  </button>
                </div>
                <div className="space-y-3">
                  <label className="block">
                    <span className="app-label">{t('warehouse.addType')}</span>
                    <input
                      value={presetLabel(t, addPreset.key, addPreset.name)}
                      readOnly
                      className="app-input bg-[var(--color-surface-muted)] text-[var(--color-fg)]"
                    />
                  </label>
                  <label className="block">
                    <span className="app-label">{t('warehouse.addName')}</span>
                    <input
                      value={addName}
                      onChange={(e) => setAddName(e.target.value)}
                      className="app-input"
                      placeholder={t('warehouse.addNamePlaceholder')}
                      autoFocus
                    />
                  </label>
                  <label className="block">
                    <span className="app-label">{t('warehouse.manufacturer')}</span>
                    <input
                      value={addManufacturer}
                      onChange={(e) => setAddManufacturer(e.target.value)}
                      className="app-input"
                      placeholder={t('warehouse.manufacturerPlaceholder')}
                    />
                  </label>
                  <div>
                    <span className="app-label">{t('warehouse.quantityLabel')}</span>
                    <div className="mt-1 flex items-center gap-2">
                      <button
                        type="button"
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] text-lg font-semibold text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] disabled:opacity-40"
                        disabled={addQty <= 1}
                        aria-label={t('warehouse.qtyMinus')}
                        onClick={() => setAddQty((q) => clampQty(q - 1))}
                      >
                        −
                      </button>
                      <input
                        type="number"
                        min={1}
                        max={9999}
                        value={addQty}
                        onChange={(e) => setAddQty(clampQty(Number(e.target.value) || 1))}
                        className="app-input text-center tabular-nums"
                      />
                      <button
                        type="button"
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] text-lg font-semibold text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] disabled:opacity-40"
                        disabled={addQty >= 9999}
                        aria-label={t('warehouse.qtyPlus')}
                        onClick={() => setAddQty((q) => clampQty(q + 1))}
                      >
                        +
                      </button>
                    </div>
                  </div>
                  {itemDialogMode === 'add' ? (
                    <>
                      <label className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2">
                        <input
                          type="checkbox"
                          checked={addAutoCode}
                          onChange={(e) => setAddAutoCode(e.target.checked)}
                          className="rounded border-[var(--color-border)]"
                        />
                        <span className="text-sm text-[var(--color-fg)]">{t('warehouse.autoCode')}</span>
                      </label>
                      <p className="text-[11px] leading-relaxed text-[var(--color-fg-subtle)]">{t('warehouse.autoCodeHint')}</p>
                    </>
                  ) : null}
                  <label className="block">
                    <span className="app-label">{t('warehouse.conditionLabel')}</span>
                    <select
                      value={addCondition}
                      onChange={(e) => setAddCondition(e.target.value as 'new' | 'used')}
                      className="app-input"
                    >
                      <option value="new">{t('warehouse.conditions.new')}</option>
                      <option value="used">{t('warehouse.conditions.used')}</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="app-label">{t('warehouse.batchOptional')}</span>
                    <input
                      value={addBatch}
                      onChange={(e) => setAddBatch(e.target.value)}
                      className="app-input"
                      placeholder="Kingston 2024-03"
                    />
                  </label>
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
                <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                  <button type="button" className="app-btn app-btn-secondary" onClick={closeItemDialog}>
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    disabled={addBusy || !addName.trim()}
                    className="app-btn app-btn-primary"
                    onClick={() => void submitAdd()}
                  >
                    {addBusy
                      ? t('warehouse.saving')
                      : itemDialogMode === 'edit'
                        ? t('warehouse.saveItem')
                        : t('warehouse.addToWarehouse')}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
