import { useEffect, useRef, useState } from 'react'
import { IconDownload, IconPencil, IconTrash } from '../../components/icons'
import { useT } from '../../i18n/LocaleContext'
import type { NetworkMapSceneMeta } from '../../api'

type Props = {
  canEdit: boolean
  scenes: NetworkMapSceneMeta[]
  activeId: number
  title: string
  busy?: boolean
  saving?: boolean
  onSelect: (id: number) => void
  onCreateBlank: () => void
  onCreateTopology: () => void
  onLayout: () => void
  onRename: (title: string, id?: number) => void
  onDelete: (id?: number) => void
  onExportPng?: () => void
  exporting?: boolean
  traceValue?: string
  onTraceValue?: (value: string) => void
  onTrace?: () => void
  tracing?: boolean
}

export function NetworkMapScenesBar({
  canEdit,
  scenes,
  activeId,
  title,
  busy,
  saving,
  onSelect,
  onCreateBlank,
  onCreateTopology,
  onLayout,
  onRename,
  onDelete,
  onExportPng,
  exporting,
  traceValue = '',
  onTraceValue,
  onTrace,
  tracing,
}: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | 'active' | null>(null)
  const [draft, setDraft] = useState(title)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

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
    <header className="flex flex-wrap items-center gap-2">
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
            className="w-[min(22rem,calc(100vw-8rem))] rounded-xl border border-[var(--color-primary)] bg-[var(--color-surface)] px-3 py-2 text-sm font-semibold"
          />
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex max-w-[min(28rem,calc(100vw-10rem))] items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left text-sm font-semibold shadow-sm hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
            >
              <span className="truncate">{label}</span>
              {active ? (
                <span className="rounded-full bg-[var(--color-bg-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-fg-subtle)]">
                  {t('networkMap.sceneNodes', { n: active.node_count })}
                </span>
              ) : null}
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
                className="rounded-lg p-2 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
              >
                <IconPencil className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        )}
        {open ? (
          <div className="network-map-scenes-menu absolute left-0 top-full z-30 mt-1 w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[0_16px_40px_-24px_rgba(0,0,0,0.7)]">
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
                  {t('networkMap.sceneTopology')}
                </button>
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-left text-xs hover:bg-[var(--color-bg-muted)]"
                  onClick={() => {
                    setOpen(false)
                    onLayout()
                  }}
                >
                  {t('networkMap.sceneLayout')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {saving ? <span className="text-[11px] text-[var(--color-fg-muted)]">{t('common.saving')}</span> : null}
        {!canEdit ? <span className="text-[11px] text-[var(--color-fg-muted)]">{t('networkMap.readonly')}</span> : null}
        {canEdit && onTrace && onTraceValue ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault()
              onTrace()
            }}
          >
            <input
              value={traceValue}
              onChange={(e) => onTraceValue(e.target.value)}
              placeholder={t('networkMap.tracePlaceholder')}
              className="w-[10.5rem] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-xs"
            />
            <button
              type="submit"
              disabled={busy || tracing || !traceValue.trim()}
              className="rounded-lg border border-[var(--color-border)] px-2.5 py-2 text-xs font-medium hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
            >
              {tracing ? t('networkMap.traceBusy') : t('networkMap.traceRun')}
            </button>
          </form>
        ) : null}
        {onExportPng ? (
          <button
            type="button"
            disabled={busy || exporting}
            onClick={onExportPng}
            title={t('networkMap.exportPngTitle')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
          >
            <IconDownload className="h-3.5 w-3.5" />
            {exporting ? t('networkMap.exportingPng') : t('networkMap.exportPng')}
          </button>
        ) : null}
        {canEdit ? (
          <button
            type="button"
            disabled={busy}
            onClick={onCreateTopology}
            className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {t('networkMap.sceneTopology')}
          </button>
        ) : null}
      </div>
    </header>
  )
}
