import { useEffect, useRef, useState } from 'react'
import { IconPencil, IconTrash } from '../../components/icons'
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
  onRename: (title: string) => void
  onDelete: () => void
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
}: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDraft(title)
  }, [title])

  useEffect(() => {
    if (!open) {
      setConfirmDelete(false)
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
  }, [open])

  const active = scenes.find((s) => s.id === activeId)
  const label = active?.title || title || t('networkMap.sceneEmpty')

  return (
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div ref={rootRef} className="relative min-w-0">
        <button
          type="button"
          disabled={busy}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex max-w-[min(28rem,calc(100vw-8rem))] items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-medium shadow-sm hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
        >
          <span className="truncate">{label}</span>
          {active ? (
            <span className="rounded-full bg-[var(--color-bg-muted)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-fg-subtle)]">
              {active.node_count}
            </span>
          ) : null}
          <span className="text-[10px] text-[var(--color-fg-subtle)]" aria-hidden>
            {open ? '▲' : '▼'}
          </span>
        </button>
        {open ? (
          <div className="absolute left-0 top-full z-30 mt-1 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[0_16px_40px_-24px_rgba(0,0,0,0.7)]">
            {scenes.length === 0 ? (
              <div className="px-3 py-2 text-xs text-[var(--color-fg-subtle)]">{t('networkMap.sceneEmpty')}</div>
            ) : (
              scenes.map((scene) => (
                <button
                  key={scene.id}
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    if (scene.id !== activeId) onSelect(scene.id)
                  }}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-bg-muted)] ${
                    scene.id === activeId ? 'bg-[var(--color-primary)]/10 font-semibold' : ''
                  }`}
                >
                  <span className="min-w-0 truncate">{scene.title}</span>
                  <span className="shrink-0 rounded-full bg-[var(--color-bg-muted)] px-2 py-0.5 text-[10px] text-[var(--color-fg-subtle)]">
                    {t('networkMap.sceneNodes', { n: scene.node_count })}
                  </span>
                </button>
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
                {scenes.length > 1 ? (
                  confirmDelete ? (
                    <div className="flex items-center gap-2 px-3 py-2">
                      <span className="text-xs text-red-700 dark:text-red-300">{t('networkMap.sceneDeleteConfirm')}</span>
                      <button
                        type="button"
                        className="rounded-lg bg-red-600 px-2 py-1 text-[11px] font-medium text-white"
                        onClick={() => {
                          setOpen(false)
                          setConfirmDelete(false)
                          onDelete()
                        }}
                      >
                        {t('networkMap.sceneDelete')}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs text-red-600 hover:bg-[var(--color-bg-muted)]"
                      onClick={() => setConfirmDelete(true)}
                    >
                      <IconTrash className="h-3.5 w-3.5" />
                      {t('networkMap.sceneDelete')}
                    </button>
                  )
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {saving ? <span className="text-[11px] text-[var(--color-fg-muted)]">{t('common.saving')}</span> : null}
        {!canEdit ? <span className="text-[11px] text-[var(--color-fg-muted)]">{t('networkMap.readonly')}</span> : null}
        {canEdit && editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setEditing(false)
              const next = draft.trim()
              if (next && next !== title) onRename(next)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditing(false)
            }}
            className="w-44 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          />
        ) : (
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => {
              setDraft(title)
              setEditing(true)
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)] disabled:opacity-60"
          >
            <IconPencil className="h-3.5 w-3.5" />
            {t('networkMap.sceneRename')}
          </button>
        )}
        {canEdit ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={onCreateBlank}
              className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
            >
              {t('networkMap.sceneNew')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onCreateTopology}
              className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {t('networkMap.sceneTopology')}
            </button>
          </>
        ) : null}
      </div>
    </header>
  )
}
