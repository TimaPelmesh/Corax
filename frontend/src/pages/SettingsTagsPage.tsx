import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type TagBrief } from '../api'
import { useAuth } from '../AuthContext'
import { IconTag, IconTrash } from '../components/icons'

const NEW_TAG_DEFAULT_COLOR = '#059669'

function pickerValue(raw: string | null | undefined) {
  if (raw && /^#[0-9A-Fa-f]{6}$/.test(raw)) return raw.toLowerCase()
  return '#64748b'
}

function TagRow({
  tag,
  onReload,
  onRemove,
  canManage,
}: {
  tag: TagBrief
  onReload: () => void
  onRemove: (id: number, label: string) => void
  canManage: boolean
}) {
  const [nameDraft, setNameDraft] = useState(tag.name)
  const [colorDraft, setColorDraft] = useState(pickerValue(tag.color))
  const [rowErr, setRowErr] = useState<string | null>(null)
  const colorSaveTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (colorSaveTimer.current) window.clearTimeout(colorSaveTimer.current)
    },
    [],
  )

  const saveName = useCallback(async () => {
    const t = nameDraft.trim()
    setRowErr(null)
    if (!t || t === tag.name) return
    try {
      await api.updateTag(tag.id, { name: t })
      onReload()
    } catch (e) {
      setRowErr(e instanceof Error ? e.message : 'Ошибка')
    }
  }, [nameDraft, tag.id, tag.name, onReload])

  const onColorPick = useCallback(
    (hex: string) => {
      const h = hex.toLowerCase()
      setColorDraft(h)
      if (colorSaveTimer.current) window.clearTimeout(colorSaveTimer.current)
      colorSaveTimer.current = window.setTimeout(async () => {
        colorSaveTimer.current = null
        setRowErr(null)
        try {
          const prev = tag.color?.toLowerCase() ?? null
          if (prev === h) return
          await api.updateTag(tag.id, { color: h })
          onReload()
        } catch (e) {
          setRowErr(e instanceof Error ? e.message : 'Ошибка')
        }
      }, 400)
    },
    [tag.color, tag.id, onReload],
  )

  const clearColor = useCallback(async () => {
    setRowErr(null)
    try {
      await api.updateTag(tag.id, { color: null })
      setColorDraft('#64748b')
      onReload()
    } catch (e) {
      setRowErr(e instanceof Error ? e.message : 'Ошибка')
    }
  }, [tag.id, onReload])

  if (!canManage) {
    const swatch = pickerValue(tag.color)
    return (
      <tr className="app-table-row">
        <td className="px-3 py-2 align-middle">
          <span
            className="inline-block h-7 w-7 rounded-lg border border-slate-200 shadow-sm"
            style={{ backgroundColor: swatch }}
            title={swatch}
            aria-hidden
          />
        </td>
        <td className="min-w-[12rem] px-3 py-2 align-middle text-sm font-medium text-slate-900">{tag.name}</td>
        <td className="px-3 py-2 text-right align-middle text-xs text-slate-400">—</td>
      </tr>
    )
  }

  return (
    <tr className="app-table-row">
      <td className="px-3 py-2 align-middle">
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`Цвет: ${tag.name}`}
            className="h-9 w-11 cursor-pointer rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm"
            value={colorDraft}
            onChange={(e) => void onColorPick(e.target.value)}
          />
          <button
            type="button"
            title="Сбросить цвет (стиль по умолчанию в списке ПК)"
            className="rounded-lg px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            onClick={() => void clearColor()}
          >
            сброс
          </button>
        </div>
      </td>
      <td className="min-w-[12rem] px-3 py-2 align-middle">
        <input
          className="w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => void saveName()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
        {rowErr ? <p className="mt-1 text-xs text-blue-600">{rowErr}</p> : null}
      </td>
      <td className="px-3 py-2 text-right align-middle">
        <button
          type="button"
          aria-label={`Удалить тег «${tag.name}»`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-neutral-800 shadow-sm transition hover:border-zinc-300 hover:bg-zinc-50"
          onClick={() => onRemove(tag.id, tag.name)}
        >
          <IconTrash className="h-4 w-4 shrink-0" />
          <span>Удалить</span>
        </button>
      </td>
    </tr>
  )
}

export function SettingsTagsPage() {
  const { user } = useAuth()
  const [rows, setRows] = useState<TagBrief[]>([])
  const [name, setName] = useState('')
  const [newColor, setNewColor] = useState(NEW_TAG_DEFAULT_COLOR)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      setRows(await api.tags())
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const canManage = Boolean(user?.is_superuser || user?.role === 'editor')

  async function addTag() {
    const n = name.trim()
    if (!n) return
    setErr(null)
    try {
      await api.createTag({ name: n, color: newColor })
      setName('')
      setNewColor(NEW_TAG_DEFAULT_COLOR)
      void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось создать')
    }
  }

  async function removeTag(id: number, label: string) {
    if (!confirm(`Удалить тег «${label}»? С ПК он только снимется (связь), данные инвентаризации не пропадут.`)) {
      return
    }
    setErr(null)
    try {
      await api.deleteTag(id)
      void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось удалить')
    }
  }

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconTag className="h-6 w-6" />
        </div>
        <div>
          <h1 className="page-title">Теги ПК</h1>
        </div>
      </div>

      {err && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{err}</div>
      )}

      {canManage ? (
        <div className="mb-6 flex max-w-2xl flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <label htmlFor="new-tag" className="mb-1 block text-xs font-medium text-slate-500">
              Новый тег
            </label>
            <input
              id="new-tag"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addTag()}
              placeholder="Например: Менеджер"
              className="app-input"
            />
          </div>
          <div>
            <label htmlFor="new-tag-color" className="mb-1 block text-xs font-medium text-slate-500">
              Цвет
            </label>
            <input
              id="new-tag-color"
              type="color"
              className="h-[42px] w-14 cursor-pointer rounded-xl border border-slate-200 bg-white p-1 shadow-sm"
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={() => void addTag()}
            className="app-btn app-btn-primary"
          >
            Добавить
          </button>
        </div>
      ) : null}

      <div className="app-card max-w-2xl overflow-hidden p-0">
        <div className="overflow-x-auto overscroll-x-contain">
        <table className="min-w-[min(100%,18rem)] w-full text-left text-sm">
          <thead className="app-table-head">
            <tr>
              <th className="px-3 py-3">Цвет</th>
              <th className="px-3 py-3">Название</th>
              <th className="min-w-[7.5rem] px-3 py-3 text-right">{canManage ? 'Действие' : ''}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {loading ? (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-slate-500">
                  Загрузка…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-10 text-center text-slate-500">
                  Пока нет тегов. Добавьте первый выше.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <TagRow
                  key={`${r.id}-${r.name}-${r.color ?? ''}`}
                  tag={r}
                  canManage={canManage}
                  onReload={() => void load()}
                  onRemove={removeTag}
                />
              ))
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}
