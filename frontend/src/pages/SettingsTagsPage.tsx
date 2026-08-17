import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type TagBrief } from '../api'
import { useAuth } from '../AuthContext'
import { IconTrash } from '../components/icons'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

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

function TagCell({
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
      <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
        <ColorCirclePicker value={pickerValue(tag.color)} sizeClass="h-7 w-7" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-fg)]">{tag.name}</span>
      </div>
    )
  }

  return (
    <div className="group/tag flex min-w-0 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2">
      <ColorCirclePicker
        value={colorDraft}
        onChange={(hex) => void onColorPick(hex)}
        ariaLabel={t('settingsTags.colorAria', { name: tag.name })}
        sizeClass="h-7 w-7"
      />
      <div className="min-w-0 flex-1">
        <input
          className="app-input !min-h-8 w-full py-1 text-sm"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => void saveName()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
        {rowErr ? <p className="mt-1 text-xs text-[var(--color-error-fg)]">{rowErr}</p> : null}
      </div>
      <button
        type="button"
        aria-label={t('settingsTags.deleteTagAria', { name: tag.name })}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--color-fg-subtle)] opacity-70 transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] group-hover/tag:opacity-100"
        onClick={() => onRemove(tag.id, tag.name)}
      >
        <IconTrash className="h-4 w-4" />
      </button>
    </div>
  )
}

export function SettingsTagsPage() {
  const t = useT()
  const toast = useToast()
  const { user } = useAuth()
  const [rows, setRows] = useState<TagBrief[]>([])
  const [name, setName] = useState('')
  const [newColor, setNewColor] = useState(NEW_TAG_DEFAULT_COLOR)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setRows(await api.tags())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsTags.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  const canManage = Boolean(user?.is_superuser || user?.role === 'editor')

  async function addTag() {
    const n = name.trim()
    if (!n) return
    try {
      await api.createTag({ name: n, color: newColor })
      setName('')
      setNewColor(NEW_TAG_DEFAULT_COLOR)
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsTags.createFailed'))
    }
  }

  async function removeTag(id: number, label: string) {
    if (!confirm(t('settingsTags.deleteConfirm', { label }))) {
      return
    }
    try {
      await api.deleteTag(id)
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsTags.deleteFailed'))
    }
  }

  return (
    <div>
      {canManage ? (
        <div className="mb-4 flex max-w-xl flex-wrap items-center gap-2">
          <input
            id="new-tag"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addTag()}
            placeholder={t('settingsTags.newTagPlaceholder')}
            className="app-input min-w-0 flex-1 !min-h-9 py-1.5 text-sm"
            aria-label={t('settingsTags.newTagLabel')}
          />
          <ColorCirclePicker
            id="new-tag-color"
            value={newColor}
            onChange={setNewColor}
            ariaLabel={t('settingsTags.colorLabel')}
            sizeClass="h-8 w-8"
          />
          <button type="button" onClick={() => void addTag()} className="app-btn app-btn-primary !min-h-9 px-3 text-sm">
            {t('settingsTags.addButton')}
          </button>
        </div>
      ) : null}

      {loading ? (
        <p className="py-10 text-center text-sm text-[var(--color-fg-muted)]">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-10 text-center text-sm text-[var(--color-fg-muted)]">
          {t('settingsTags.emptyState')}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {rows.map((r) => (
            <TagCell
              key={`${r.id}-${r.name}-${r.color ?? ''}`}
              tag={r}
              canManage={canManage}
              onReload={() => void load()}
              onRemove={removeTag}
            />
          ))}
        </div>
      )}
    </div>
  )
}
