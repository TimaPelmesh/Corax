import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api,
  type WarehousePreset,
  type WarehouseRoom,
  type WarehouseStockItem,
} from '../api'
import { useAuth } from '../AuthContext'
import { IconClose, IconTrash, IconWarehouse } from '../components/icons'

const GROUP_LABELS: Record<string, string> = {
  components: 'Компоненты',
  network: 'Сетевое оборудование',
  other: 'Прочее',
}

const CONDITION_LABELS: Record<string, string> = {
  new: 'Новое',
  used: 'Б/у',
  defective: 'Брак',
}

function fmtWhen(iso: string | null | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function WarehousePage() {
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
        setErr(e instanceof Error ? e.message : 'Ошибка загрузки')
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
        setErr(e instanceof Error ? e.message : 'Ошибка загрузки позиций')
      }
    })()
  }, [activeRoomId, search, reloadItems])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(t)
  }, [toast])

  const createRoom = async () => {
    if (!canEdit) return
    setRoomMenuOpen(false)
    const title = window.prompt('Название складского помещения', `Склад ${rooms.length + 1}`)?.trim()
    if (title === undefined) return
    try {
      const created = await api.createWarehouseRoom({ title: title || `Склад ${rooms.length + 1}` })
      await reload()
      setActiveRoomId(created.id)
      setToast('Помещение создано')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось создать помещение')
    }
  }

  const renameRoom = async () => {
    if (!canEdit || !activeRoom) return
    setRoomMenuOpen(false)
    const next = window.prompt('Новое название', activeRoom.title)?.trim()
    if (!next || next === activeRoom.title) return
    try {
      await api.patchWarehouseRoom(activeRoom.id, { title: next })
      await reload()
      setToast('Название обновлено')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось переименовать')
    }
  }

  const deleteRoom = async () => {
    if (!canEdit || !activeRoom) return
    setRoomMenuOpen(false)
    if (rooms.length <= 1) {
      setErr('Нельзя удалить единственное помещение')
      return
    }
    if (!window.confirm(`Удалить помещение «${activeRoom.title}»?`)) return
    try {
      await api.deleteWarehouseRoom(activeRoom.id)
      await reload()
      setToast('Помещение удалено')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось удалить помещение')
    }
  }

  const openAdd = (preset: WarehousePreset) => {
    if (!canEdit || !activeRoomId) return
    setAddPreset(preset)
    setAddName(preset.name)
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
      setToast('Позиция добавлена на склад')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось добавить позицию')
    } finally {
      setAddBusy(false)
    }
  }

  const writeOff = async (item: WarehouseStockItem) => {
    if (!canEdit) return
    if (!window.confirm(`Списать «${item.name}»?`)) return
    try {
      await api.writeOffWarehouseItem(item.id)
      if (activeRoomId) await reloadItems(activeRoomId, search)
      await reload()
      setToast('Позиция списана')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка списания')
    }
  }

  const transferItem = async (item: WarehouseStockItem) => {
    if (!canEdit) return
    const others = rooms.filter((r) => r.id !== item.room_id)
    if (!others.length) {
      setErr('Нет другого помещения для перемещения')
      return
    }
    const labels = others.map((r) => `${r.id}: ${r.title}`).join('\n')
    const raw = window.prompt(`Куда переместить?\n${labels}\n\nВведите ID помещения:`)
    if (!raw) return
    const toId = Number(raw.trim())
    if (!others.some((r) => r.id === toId)) {
      setErr('Неверный ID помещения')
      return
    }
    try {
      await api.transferWarehouseItem(item.id, { to_room_id: toId })
      if (activeRoomId) await reloadItems(activeRoomId, search)
      await reload()
      setToast('Позиция перемещена')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка перемещения')
    }
  }

  const deleteItem = async (item: WarehouseStockItem) => {
    if (!canEdit) return
    if (!window.confirm(`Удалить запись «${item.name}» безвозвратно?`)) return
    try {
      await api.deleteWarehouseItem(item.id)
      if (activeRoomId) await reloadItems(activeRoomId, search)
      await reload()
      setToast('Запись удалена')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка удаления')
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-3 py-4 sm:px-4 lg:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-neutral-900">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-neutral-900 text-white">
              <IconWarehouse className="h-[18px] w-[18px]" />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Склад</h1>
              <p className="text-sm text-neutral-500">Учёт свободного оборудования и комплектующих</p>
            </div>
          </div>
        </div>
        {!canEdit ? (
          <span className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs font-medium text-neutral-600">
            Только просмотр
          </span>
        ) : null}
      </header>

      {err ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{err}</div>
      ) : null}
      {toast ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{toast}</div>
      ) : null}

      <div className="flex flex-col gap-4 lg:flex-row">
        <aside className="lg:w-56 shrink-0">
          <div className="rounded-2xl border border-neutral-200/90 bg-white p-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-neutral-500">Помещения</span>
              {canEdit ? (
                <div className="relative">
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-xs font-semibold text-red-700 hover:bg-blue-50"
                    onClick={() => setRoomMenuOpen((v) => !v)}
                  >
                    ⋮
                  </button>
                  {roomMenuOpen ? (
                    <div className="absolute right-0 z-20 mt-1 min-w-[10rem] rounded-xl border border-neutral-200 bg-white py-1 shadow-lg">
                      <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-neutral-50" onClick={() => void createRoom()}>
                        + Создать
                      </button>
                      <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-neutral-50" onClick={() => void renameRoom()} disabled={!activeRoom}>
                        Переименовать
                      </button>
                      <button type="button" className="block w-full px-3 py-2 text-left text-sm text-red-700 hover:bg-blue-50" onClick={() => void deleteRoom()} disabled={!activeRoom}>
                        Удалить
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <ul className="space-y-1">
              {rooms.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setActiveRoomId(r.id)}
                    className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                      activeRoomId === r.id
                        ? 'bg-neutral-900 text-white'
                        : 'text-neutral-700 hover:bg-neutral-100'
                    }`}
                  >
                    <span className="truncate">{r.title}</span>
                    <span className={`ml-2 shrink-0 text-xs ${activeRoomId === r.id ? 'text-white/70' : 'text-neutral-400'}`}>
                      {r.item_count}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {canEdit ? (
              <button
                type="button"
                onClick={() => void createRoom()}
                className="mt-2 w-full rounded-xl border border-dashed border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-600 hover:border-neutral-400 hover:bg-neutral-50"
              >
                + Помещение
              </button>
            ) : null}
          </div>
        </aside>

        <section className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск: название, код СК-, партия…"
              className="min-w-[12rem] flex-1 rounded-xl border border-neutral-200 px-3 py-2 text-sm shadow-sm focus:border-neutral-400 focus:outline-none"
            />
            {canEdit && activeRoomId ? (
              <div className="relative group">
                <button
                  type="button"
                  className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-neutral-800"
                >
                  + Добавить
                </button>
                <div className="invisible absolute right-0 z-30 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-neutral-200 bg-white p-2 opacity-0 shadow-xl transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                  {[...presetsByGroup.entries()].map(([group, list]) => (
                    <div key={group} className="mb-2 last:mb-0">
                      <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-neutral-400">
                        {GROUP_LABELS[group] ?? group}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {list.map((p) => (
                          <button
                            key={p.key}
                            type="button"
                            onClick={() => openAdd(p)}
                            className="rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-800 hover:border-neutral-300 hover:bg-neutral-50"
                          >
                            {p.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {activeRoom?.notes ? (
            <p className="rounded-xl border border-neutral-100 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">{activeRoom.notes}</p>
          ) : null}

          <div className="overflow-hidden rounded-2xl border border-neutral-200/90 bg-white shadow-sm">
            {loading ? (
              <div className="px-4 py-10 text-center text-sm text-neutral-500">Загрузка…</div>
            ) : items.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-neutral-500">
                {activeRoom ? 'На складе пока нет позиций' : 'Выберите помещение'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="border-b border-neutral-100 bg-neutral-50/80 text-[11px] font-bold uppercase tracking-[0.1em] text-neutral-500">
                    <tr>
                      <th className="px-3 py-2.5">Тип / название</th>
                      <th className="px-3 py-2.5">Код</th>
                      <th className="px-3 py-2.5">Кол-во</th>
                      <th className="px-3 py-2.5">Состояние</th>
                      <th className="px-3 py-2.5">Обновлено</th>
                      {canEdit ? <th className="px-3 py-2.5 text-right">Действия</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} className="border-t border-neutral-100 hover:bg-neutral-50/60">
                        <td className="px-3 py-2.5 align-top">
                          <div className="font-medium text-neutral-900">{item.name}</div>
                          <div className="text-xs text-neutral-500">{item.preset_name ?? item.preset_key}</div>
                          {item.batch_label ? (
                            <div className="mt-0.5 text-xs text-neutral-400">Партия: {item.batch_label}</div>
                          ) : null}
                          {item.notes ? <div className="mt-0.5 text-xs text-neutral-500">{item.notes}</div> : null}
                        </td>
                        <td className="px-3 py-2.5 align-top font-mono text-xs text-neutral-700">
                          {item.internal_code ?? '—'}
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          {item.tracking_mode === 'lot' ? `${item.quantity_available} шт` : '1 шт'}
                        </td>
                        <td className="px-3 py-2.5 align-top text-xs">{CONDITION_LABELS[item.condition] ?? item.condition}</td>
                        <td className="px-3 py-2.5 align-top text-xs text-neutral-500">{fmtWhen(item.updated_at)}</td>
                        {canEdit ? (
                          <td className="px-3 py-2.5 align-top text-right">
                            <div className="flex justify-end gap-1">
                              {rooms.length > 1 ? (
                                <button
                                  type="button"
                                  title="Переместить"
                                  className="rounded-lg px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100"
                                  onClick={() => void transferItem(item)}
                                >
                                  ↔
                                </button>
                              ) : null}
                              <button
                                type="button"
                                title="Списать"
                                className="rounded-lg px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50"
                                onClick={() => void writeOff(item)}
                              >
                                Списать
                              </button>
                              <button
                                type="button"
                                title="Удалить запись"
                                className="rounded-lg p-1 text-neutral-400 hover:bg-blue-50 hover:text-blue-700"
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

      {addOpen && addPreset ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
          <div className="w-full max-w-md rounded-2xl bg-white p-4 shadow-2xl">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold text-neutral-900">Добавить: {addPreset.name}</h2>
                <p className="text-xs text-neutral-500">{activeRoom?.title}</p>
              </div>
              <button type="button" className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100" onClick={() => setAddOpen(false)}>
                <IconClose className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-neutral-600">Название / модель</span>
                <input
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm"
                  placeholder="Например: DDR4 16GB Kingston"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-neutral-600">Учёт</span>
                  <select
                    value={addTracking}
                    onChange={(e) => setAddTracking(e.target.value as 'unit' | 'lot')}
                    className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm"
                  >
                    <option value="lot">Партия (кол-во)</option>
                    <option value="unit">Поштучно (СК-код)</option>
                  </select>
                </label>
                {addTracking === 'lot' ? (
                  <label className="block">
                    <span className="mb-1 block text-xs font-semibold text-neutral-600">Количество</span>
                    <input
                      type="number"
                      min={1}
                      max={9999}
                      value={addQty}
                      onChange={(e) => setAddQty(Math.max(1, Number(e.target.value) || 1))}
                      className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm"
                    />
                  </label>
                ) : (
                  <label className="flex items-end gap-2 pb-2">
                    <input
                      type="checkbox"
                      checked={addAutoCode}
                      onChange={(e) => setAddAutoCode(e.target.checked)}
                      className="rounded border-neutral-300"
                    />
                    <span className="text-xs text-neutral-600">Авто-код СК-0001</span>
                  </label>
                )}
              </div>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-neutral-600">Состояние</span>
                <select
                  value={addCondition}
                  onChange={(e) => setAddCondition(e.target.value as 'new' | 'used' | 'defective')}
                  className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm"
                >
                  <option value="new">Новое</option>
                  <option value="used">Б/у</option>
                  <option value="defective">Брак</option>
                </select>
              </label>
              {addTracking === 'lot' ? (
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-neutral-600">Партия (необяз.)</span>
                  <input
                    value={addBatch}
                    onChange={(e) => setAddBatch(e.target.value)}
                    className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm"
                    placeholder="Kingston 2024-03"
                  />
                </label>
              ) : null}
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-neutral-600">Примечание</span>
                <textarea
                  value={addNotes}
                  onChange={(e) => setAddNotes(e.target.value)}
                  rows={2}
                  className="w-full resize-y rounded-xl border border-neutral-200 px-3 py-2 text-sm"
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded-xl px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100" onClick={() => setAddOpen(false)}>
                Отмена
              </button>
              <button
                type="button"
                disabled={addBusy || !addName.trim()}
                className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                onClick={() => void submitAdd()}
              >
                {addBusy ? 'Сохранение…' : 'Добавить на склад'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
