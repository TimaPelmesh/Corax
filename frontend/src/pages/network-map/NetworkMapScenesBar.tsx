import { useEffect, useRef, useState } from 'react'
import { IconDownload, IconPencil, IconRedo, IconTrash, IconUndo } from '../../components/icons'
import { useT } from '../../i18n/LocaleContext'
import type { NetworkMapSceneMeta } from '../../api'

type Props = {
  canEdit: boolean
  scenes: NetworkMapSceneMeta[]
  activeId: number
  title: string
  busy?: boolean
  saving?: boolean
  search: string
  onSearch: (value: string) => void
  onSearchSubmit: () => void
  onSelect: (id: number) => void
  onCreateBlank: () => void
  onCreateTopology: () => void
  onLayout: () => void
  onClear?: () => void
  onRename: (title: string, id?: number) => void
  onDelete: (id?: number) => void
  onExportPng?: () => void
  exporting?: boolean
  traceValue?: string
  onTraceValue?: (value: string) => void
  onTrace?: () => void
  tracing?: boolean
  onUndo?: () => void
  onRedo?: () => void
  canUndo?: boolean
  canRedo?: boolean
}

export function NetworkMapScenesBar({
  canEdit,
  scenes,
  activeId,
  title,
  busy,
  saving,
  search,
  onSearch,
  onSearchSubmit,
  onSelect,
  onCreateBlank,
  onCreateTopology,
  onLayout,
  onClear,
  onRename,
  onDelete,
  onExportPng,
  exporting,
  traceValue = '',
  onTraceValue,
  onTrace,
  tracing,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [more, setMore] = useState(false)
  const [editingId, setEditingId] = useState<number | 'active' | null>(null)
  const [draft, setDraft] = useState(title)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (editingId === 'active' || editingId === activeId) setDraft(title)
  }, [title, editingId, activeId])

  useEffect(() => {
    if (!open) {
      setConfirmId(null)
      if (editingId !== 'active') setEditingId(null)
      return
    }
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, editingId])

  useEffect(() => {
    if (!more) return
    const onDoc = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMore(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [more])

  const active = scenes.find((s) => s.id === activeId)
  const label = active?.title || title || t('networkMap.sceneEmpty')

  const commitRename = (id: number | 'active') => {
    const next = draft.trim()
    setEditingId(null)
    if (!next) return
    if (id === 'active') {
      if (next !== title) onRename(next)
      return
    }
    const current = scenes.find((s) => s.id === id)?.title
    if (next !== current) onRename(next, id)
  }

  return (
    <header className="network-map-toolbar flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
      <div ref={rootRef} className="network-map-scenes relative min-w-0">
        {editingId === 'active' ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commitRename('active')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditingId(null)
            }}
            className="w-[min(18rem,calc(100vw-8rem))] rounded-lg border border-[var(--color-primary)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm font-semibold"
          />
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => setOpen((v) => !v)}
            className="inline-flex max-w-[min(20rem,calc(100vw-10rem))] items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-left text-sm font-semibold hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
            >
              <span className="truncate">{label}</span>
              <span className="text-[10px] text-[var(--color-fg-subtle)]" aria-hidden>
                {open ? '▲' : '▼'}
              </span>
            </button>
            {canEdit ? (
              <button
                type="button"
                title={t('networkMap.sceneRename')}
                onClick={() => {
                  setDraft(title)
                  setEditingId('active')
                }}
                className="rounded-md p-1.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
              >
                <IconPencil className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        )}
        {open ? (
          <div className="network-map-scenes-menu absolute left-0 top-full z-30 mt-1 w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1">
            {scenes.length === 0 ? (
              <div className="px-3 py-2 text-xs text-[var(--color-fg-subtle)]">{t('networkMap.sceneEmpty')}</div>
            ) : (
              scenes.map((scene) => (
                <div
                  key={scene.id}
                  className={`flex items-center gap-1 px-1.5 py-0.5 ${
                    scene.id === activeId ? 'bg-[var(--color-primary)]/10' : ''
                  }`}
                >
                  {editingId === scene.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(scene.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false)
                        if (scene.id !== activeId) onSelect(scene.id)
                      }}
                      className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--color-bg-muted)]"
                    >
                      <span className="block truncate font-medium">{scene.title}</span>
                      <span className="text-[10px] text-[var(--color-fg-subtle)]">
                        {t('networkMap.sceneNodes', { n: scene.node_count })}
                      </span>
                    </button>
                  )}
                  {canEdit ? (
                    <div className="flex shrink-0 items-center">
                      <button
                        type="button"
                        title={t('networkMap.sceneRename')}
                        onClick={() => {
                          setDraft(scene.title)
                          setEditingId(scene.id)
                          setConfirmId(null)
                        }}
                        className="rounded-md p-1.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
                      >
                        <IconPencil className="h-3.5 w-3.5" />
                      </button>
                      {scenes.length > 1 ? (
                        confirmId === scene.id ? (
                          <button
                            type="button"
                            className="rounded-md bg-red-600 px-2 py-1 text-[11px] font-medium text-white"
                            onClick={() => {
                              setOpen(false)
                              setConfirmId(null)
                              onDelete(scene.id)
                            }}
                          >
                            {t('networkMap.sceneDelete')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            title={t('networkMap.sceneDelete')}
                            onClick={() => setConfirmId(scene.id)}
                            className="rounded-md p-1.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-red-600"
                          >
                            <IconTrash className="h-3.5 w-3.5" />
                          </button>
                        )
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))
            )}
            {canEdit ? (
              <div className="mt-1 border-t border-[var(--color-border)] pt-1">
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-left text-xs hover:bg-[var(--color-bg-muted)]"
                  onClick={() => {
                    setOpen(false)
                    onCreateBlank()
                  }}
                >
                  {t('networkMap.sceneBlank')}
                </button>
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-left text-xs hover:bg-[var(--color-bg-muted)]"
                  onClick={() => {
                    setOpen(false)
                    onCreateTopology()
                  }}
                >
                  {t('networkMap.sceneTopologyNew')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <form
        className="min-w-0 flex-1"
        onSubmit={(e) => {
          e.preventDefault()
          onSearchSubmit()
        }}
      >
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t('networkMap.searchMap')}
          className="w-full max-w-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm"
        />
      </form>
      <div className="ml-auto flex items-center gap-1.5">
        {saving ? <span className="text-[11px] text-[var(--color-fg-muted)]">{t('common.saving')}</span> : null}
        {!canEdit ? <span className="text-[11px] text-[var(--color-fg-muted)]">{t('networkMap.readonly')}</span> : null}
        {canEdit && onUndo ? (
          <button
            type="button"
            disabled={!canUndo}
            title={t('networkMap.undo')}
            aria-label={t('networkMap.undo')}
            onClick={onUndo}
            className="rounded-md p-1.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)] disabled:opacity-40"
          >
            <IconUndo className="h-4 w-4" />
          </button>
        ) : null}
        {canEdit && onRedo ? (
          <button
            type="button"
            disabled={!canRedo}
            title={t('networkMap.redo')}
            aria-label={t('networkMap.redo')}
            onClick={onRedo}
            className="rounded-md p-1.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)] disabled:opacity-40"
          >
            <IconRedo className="h-4 w-4" />
          </button>
        ) : null}
        {onExportPng ? (
          <button
            type="button"
            disabled={busy || exporting}
            onClick={onExportPng}
            title={t('networkMap.exportPngTitle')}
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-2 py-1.5 text-xs hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
          >
            <IconDownload className="h-3.5 w-3.5" />
            {exporting ? t('networkMap.exportingPng') : t('networkMap.exportPng')}
          </button>
        ) : null}
        <div ref={moreRef} className="relative">
          <button
            type="button"
            onClick={() => setMore((v) => !v)}
            className="rounded-lg border border-[var(--color-border)] px-2 py-1.5 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]"
          >
            {t('networkMap.more')}
          </button>
          {more ? (
            <div className="absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1">
              {canEdit ? (
                <>
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left text-xs hover:bg-[var(--color-bg-muted)]"
                    onClick={() => {
                      setMore(false)
                      onLayout()
                    }}
                  >
                    {t('networkMap.sceneLayout')}
                  </button>
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left text-xs hover:bg-[var(--color-bg-muted)]"
                    onClick={() => {
                      setMore(false)
                      onCreateTopology()
                    }}
                  >
                    {t('networkMap.sceneTopologyNew')}
                  </button>
                  {onClear ? (
                    <button
                      type="button"
                      className="block w-full px-3 py-2 text-left text-xs hover:bg-[var(--color-bg-muted)]"
                      onClick={() => {
                        setMore(false)
                        onClear()
                      }}
                    >
                      {t('networkMap.blank')}
                    </button>
                  ) : null}
                </>
              ) : null}
              {canEdit && onTrace && onTraceValue ? (
                <form
                  className="border-t border-[var(--color-border)] px-3 py-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    onTrace()
                    setMore(false)
                  }}
                >
                  <div className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">
                    {t('networkMap.legendTrace')}
                  </div>
                  <div className="mt-1 flex gap-1">
                    <input
                      value={traceValue}
                      onChange={(e) => onTraceValue(e.target.value)}
                      placeholder={t('networkMap.tracePlaceholder')}
                      className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
                    />
                    <button
                      type="submit"
                      disabled={busy || tracing || !traceValue.trim()}
                      className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-50"
                    >
                      {tracing ? t('networkMap.traceBusy') : t('networkMap.traceRun')}
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  )
}
