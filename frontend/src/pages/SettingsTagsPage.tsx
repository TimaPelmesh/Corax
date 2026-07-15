import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type TagBrief } from '../api'
import { useAuth } from '../AuthContext'
import { IconTag, IconTrash } from '../components/icons'
import { useT } from '../i18n/LocaleContext'

const NEW_TAG_DEFAULT_COLOR = '#059669'

function pickerValue(raw: string | null | undefined) {
  if (raw && /^#[0-9A-Fa-f]{6}$/.test(raw)) return raw.toLowerCase()
  return '#64748b'
}

/** Filled circle color control — avoids native color input's "rect in rounded box" look. */
function ColorCirclePicker({
  id,
  value,
  onChange,
  ariaLabel,
  sizeClass = 'h-9 w-9',
}: {
  id?: string
  value: string
  onChange?: (hex: string) => void
  ariaLabel?: string
  sizeClass?: string
}) {
  if (!onChange) {
    return (
      <span
        className={`inline-block ${sizeClass} shrink-0 rounded-full border border-black/10 shadow-sm`}
        style={{ backgroundColor: value }}
        title={value}
        aria-hidden
      />
    )
  }
  return (
    <label
      className={`relative inline-flex ${sizeClass} shrink-0 cursor-pointer overflow-hidden rounded-full border border-black/10 shadow-sm transition hover:brightness-95`}
      style={{ backgroundColor: value }}
      title={value}
    >
      <input
        id={id}
        type="color"
        aria-label={ariaLabel}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

function TagRow({
  tag,
  onReload,
  onRemove,
  canManage,
  rowClassName,
}: {
  tag: TagBrief
  onReload: () => void
  onRemove: (id: number, label: string) => void
  canManage: boolean
  rowClassName?: string
}) {
  const t = useT()
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
    const nextName = nameDraft.trim()
    setRowErr(null)
    if (!nextName || nextName === tag.name) return
    try {
      await api.updateTag(tag.id, { name: nextName })
      onReload()
    } catch (e) {
      setRowErr(e instanceof Error ? e.message : t('common.error'))
    }
  }, [nameDraft, tag.id, tag.name, onReload, t])

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
          setRowErr(e instanceof Error ? e.message : t('common.error'))
        }
      }, 400)
    },
    [tag.color, tag.id, onReload, t],
  )

  if (!canManage) {
    return (
      <tr className={`app-table-row ${rowClassName ?? ''}`}>
        <td className="px-3 py-2 align-middle">
          <ColorCirclePicker value={pickerValue(tag.color)} />
        </td>
        <td className="min-w-[12rem] px-3 py-2 align-middle text-sm font-medium text-[var(--color-fg)]">{tag.name}</td>
        <td className="px-3 py-2 text-right align-middle text-xs text-[var(--color-fg-subtle)]">—</td>
      </tr>
    )
  }

  return (
    <tr className={`app-table-row ${rowClassName ?? ''}`}>
      <td className="px-3 py-2 align-middle">
        <ColorCirclePicker
          value={colorDraft}
          onChange={(hex) => void onColorPick(hex)}
          ariaLabel={t('settingsTags.colorAria', { name: tag.name })}
        />
      </td>
      <td className="min-w-[12rem] px-3 py-2 align-middle">
        <input
          className="app-input"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => void saveName()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
        {rowErr ? <p className="mt-1 text-xs text-[var(--color-error-fg)]">{rowErr}</p> : null}
      </td>
      <td className="px-3 py-2 text-right align-middle">
        <button
          type="button"
          aria-label={t('settingsTags.deleteTagAria', { name: tag.name })}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-fg)] shadow-sm transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
          onClick={() => onRemove(tag.id, tag.name)}
        >
          <IconTrash className="h-4 w-4 shrink-0" />
          <span>{t('settingsTags.deleteAction')}</span>
        </button>
      </td>
    </tr>
  )
}

export function SettingsTagsPage() {
  const t = useT()
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
      setErr(e instanceof Error ? e.message : t('settingsTags.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

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
      setErr(e instanceof Error ? e.message : t('settingsTags.createFailed'))
    }
  }

  async function removeTag(id: number, label: string) {
    if (!confirm(t('settingsTags.deleteConfirm', { label }))) {
      return
    }
    setErr(null)
    try {
      await api.deleteTag(id)
      void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('settingsTags.deleteFailed'))
    }
  }

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconTag className="h-6 w-6" />
        </div>
        <div>
          <h1 className="page-title">{t('titles.tags')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-fg-muted)]">{t('pages.tagsSubtitle')}</p>
        </div>
      </div>

      {err ? <div className="app-alert app-alert-error mb-4">{err}</div> : null}

      {canManage ? (
        <div className="mb-6 flex max-w-2xl flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <label htmlFor="new-tag" className="app-label">
              {t('settingsTags.newTagLabel')}
            </label>
            <input
              id="new-tag"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addTag()}
              placeholder={t('settingsTags.newTagPlaceholder')}
              className="app-input"
            />
          </div>
          <div>
            <label htmlFor="new-tag-color" className="app-label">
              {t('settingsTags.colorLabel')}
            </label>
            <div className="flex h-[42px] items-center">
              <ColorCirclePicker
                id="new-tag-color"
                value={newColor}
                onChange={setNewColor}
                ariaLabel={t('settingsTags.colorLabel')}
                sizeClass="h-9 w-9"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => void addTag()}
            className="app-btn app-btn-primary"
          >
            {t('settingsTags.addButton')}
          </button>
        </div>
      ) : null}

      <div className="app-card max-w-2xl overflow-hidden p-0">
        <div className="overflow-x-auto overscroll-x-contain">
        <table className="min-w-[min(100%,18rem)] w-full text-left text-sm">
          <thead className="app-table-head">
            <tr>
              <th className="px-3 py-3">{t('settingsTags.tableColor')}</th>
              <th className="px-3 py-3">{t('settingsTags.tableName')}</th>
              <th className="min-w-[7.5rem] px-3 py-3 text-right">
                {canManage ? t('settingsTags.tableAction') : ''}
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                  {t('common.loading')}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-10 text-center text-[var(--color-fg-muted)]">
                  {t('settingsTags.emptyState')}
                </td>
              </tr>
            ) : (
              rows.map((r, idx) => (
                <TagRow
                  key={`${r.id}-${r.name}-${r.color ?? ''}`}
                  tag={r}
                  canManage={canManage}
                  onReload={() => void load()}
                  onRemove={removeTag}
                  rowClassName={idx > 0 ? 'border-t border-[var(--color-border)]' : undefined}
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
