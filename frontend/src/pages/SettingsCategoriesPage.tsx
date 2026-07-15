import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type RequestCategoryTreeNode } from '../api'
import { useAuth } from '../AuthContext'
import { IconTag, IconTicket, IconTrash } from '../components/icons'
import { filterCategoryTree } from '../requestCategories'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

function collectExpandableIds(nodes: RequestCategoryTreeNode[]): number[] {
  const ids: number[] = []
  const walk = (list: RequestCategoryTreeNode[]) => {
    for (const n of list) {
      if (n.children.length > 0) {
        ids.push(n.id)
        walk(n.children)
      }
    }
  }
  walk(nodes)
  return ids
}

function countNodes(nodes: RequestCategoryTreeNode[]): number {
  let n = 0
  const walk = (list: RequestCategoryTreeNode[]) => {
    for (const x of list) {
      n += 1
      walk(x.children)
    }
  }
  walk(nodes)
  return n
}

function findSiblingContext(
  nodes: RequestCategoryTreeNode[],
  id: number,
): { siblings: RequestCategoryTreeNode[]; index: number } | null {
  function scan(list: RequestCategoryTreeNode[]): { siblings: RequestCategoryTreeNode[]; index: number } | null {
    const idx = list.findIndex((x) => x.id === id)
    if (idx >= 0) return { siblings: list, index: idx }
    for (const n of list) {
      const hit = scan(n.children)
      if (hit) return hit
    }
    return null
  }
  return scan(nodes)
}

function IconChevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden
    >
      <path
        d={open ? 'M5 7.5 10 12.5 15 7.5' : 'M7.5 5 12.5 10 7.5 15'}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TreeNodeRow({
  node,
  depth,
  isLast,
  canManage,
  expandedIds,
  onToggleExpand,
  onReload,
  onRemove,
  onMove,
  addingUnderId,
  onStartAddChild,
  onCancelAddChild,
  onSubmitAddChild,
  addChildDraft,
  onAddChildDraftChange,
  addChildBusy,
}: {
  node: RequestCategoryTreeNode
  depth: number
  isLast: boolean
  canManage: boolean
  expandedIds: Set<number>
  onToggleExpand: (id: number) => void
  onReload: () => void
  onRemove: (id: number, label: string, hasChildren: boolean) => void
  onMove: (id: number, direction: 'up' | 'down') => void
  addingUnderId: number | null
  onStartAddChild: (parentId: number) => void
  onCancelAddChild: () => void
  onSubmitAddChild: (parentId: number) => void
  addChildDraft: string
  onAddChildDraftChange: (v: string) => void
  addChildBusy: boolean
}) {
  const t = useT()
  const [draft, setDraft] = useState(node.name)
  const [rowErr, setRowErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const hasChildren = node.children.length > 0
  const expanded = expandedIds.has(node.id)
  const isAddingHere = addingUnderId === node.id

  useEffect(() => {
    setDraft(node.name)
  }, [node.name])

  const saveName = async () => {
    const next = draft.trim()
    setRowErr(null)
    if (!next || next === node.name) {
      setDraft(node.name)
      return
    }
    setSaving(true)
    try {
      await api.updateRequestCategory(node.id, { name: next })
      onReload()
    } catch (e) {
      setRowErr(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  const indentPx = depth * 22

  return (
    <div className="group/tree relative">
      {depth > 0 ? (
        <>
          <span
            className="pointer-events-none absolute top-0 w-px bg-[var(--color-border)]"
            style={{ left: `${indentPx - 11}px`, height: isLast ? '1.35rem' : '100%' }}
            aria-hidden
          />
          <span
            className="pointer-events-none absolute top-[1.1rem] h-px w-3 bg-[var(--color-border)]"
            style={{ left: `${indentPx - 11}px` }}
            aria-hidden
          />
        </>
      ) : null}

      <div
        className="relative mb-1 flex items-stretch gap-2 rounded-xl border border-transparent px-2 py-1.5 transition hover:border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]"
        style={{ marginLeft: `${indentPx}px` }}
      >
        <button
          type="button"
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition ${
            hasChildren
              ? 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] shadow-sm hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-muted)] hover:text-[var(--color-primary)]'
              : 'border-transparent bg-transparent text-[var(--color-fg-subtle)]'
          }`}
          onClick={() => hasChildren && onToggleExpand(node.id)}
          aria-label={expanded ? t('settingsCategories.collapse') : t('settingsCategories.expand')}
          aria-expanded={hasChildren ? expanded : undefined}
          disabled={!hasChildren}
          tabIndex={hasChildren ? 0 : -1}
        >
          {hasChildren ? (
            <IconChevron open={expanded} className="h-4 w-4" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-border-strong)]" />
          )}
        </button>

        <div
          className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border px-3 py-2 ${
            hasChildren
              ? 'border-[var(--color-primary)]/35 bg-[var(--color-primary-muted)]'
              : 'border-[var(--color-border)] bg-[var(--color-surface)]'
          }`}
        >
          <span
            className={`icon-surface h-8 w-8 shrink-0 ${
              hasChildren
                ? 'bg-[var(--color-primary-muted)] text-[var(--color-primary)]'
                : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]'
            }`}
          >
            <IconTag className="h-4 w-4" />
          </span>

          <div className="min-w-0 flex-1">
            {canManage ? (
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void saveName()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void saveName()
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setDraft(node.name)
                    setRowErr(null)
                  }
                }}
                disabled={saving}
                className="w-full min-w-0 border-0 bg-transparent p-0 text-sm font-semibold text-[var(--color-fg)] outline-none ring-0 placeholder:text-[var(--color-fg-subtle)] focus:ring-0 disabled:opacity-60"
                spellCheck={false}
                aria-label={t('settingsCategories.nameAria', { path: node.path })}
              />
            ) : (
              <div className="text-sm font-semibold text-[var(--color-fg)]">{node.name}</div>
            )}
            <div className="mt-0.5 truncate text-[11px] text-[var(--color-fg-subtle)]" title={node.path}>
              {node.path}
              {hasChildren ? (
                <span className="ml-2 rounded-md bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
                  {t('settingsCategories.childCount', { count: node.children.length })}
                </span>
              ) : null}
            </div>
          </div>

          {canManage ? (
            <div className="flex shrink-0 flex-wrap items-center gap-1 opacity-95 sm:opacity-80 sm:group-hover/tree:opacity-100">
              <button
                type="button"
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] font-semibold text-[var(--color-fg-muted)] shadow-sm hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
                title={t('settingsCategories.moveUpTitle')}
                onClick={() => onMove(node.id, 'up')}
              >
                ↑
              </button>
              <button
                type="button"
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] font-semibold text-[var(--color-fg-muted)] shadow-sm hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
                title={t('settingsCategories.moveDownTitle')}
                onClick={() => onMove(node.id, 'down')}
              >
                ↓
              </button>
              <button
                type="button"
                className="rounded-lg border border-[var(--color-primary)]/40 bg-[var(--color-surface)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-primary)] shadow-sm hover:bg-[var(--color-primary-muted)]"
                onClick={() => onStartAddChild(node.id)}
              >
                {t('settingsCategories.addChild')}
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-primary)]/35 bg-[var(--color-primary-muted)] px-2 py-1 text-[11px] font-semibold text-[var(--color-primary)] hover:border-[var(--color-primary)]"
                onClick={() => onRemove(node.id, node.path, hasChildren)}
              >
                <IconTrash className="h-3.5 w-3.5" />
                {t('settingsCategories.deleteAction')}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {rowErr ? (
        <div className="mb-1 text-xs text-[var(--color-error-fg)]" style={{ marginLeft: `${indentPx + 2.75}rem` }}>
          {rowErr}
        </div>
      ) : null}

      {isAddingHere && canManage ? (
        <form
          className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-[var(--color-primary)]/40 bg-[var(--color-primary-muted)] px-3 py-2.5"
          style={{ marginLeft: `${indentPx + 2.5}rem` }}
          onSubmit={(e) => {
            e.preventDefault()
            onSubmitAddChild(node.id)
          }}
        >
          <input
            autoFocus
            value={addChildDraft}
            onChange={(e) => onAddChildDraftChange(e.target.value)}
            placeholder={t('settingsCategories.childPlaceholder')}
            className="app-input min-w-[10rem] flex-1 text-sm"
            disabled={addChildBusy}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancelAddChild()
            }}
          />
          <button type="submit" className="app-btn app-btn-primary !min-h-9 px-3 py-1.5 text-xs" disabled={addChildBusy || !addChildDraft.trim()}>
            {addChildBusy ? t('settingsCategories.addChildBusy') : t('settingsCategories.addChildButton')}
          </button>
          <button type="button" className="app-btn app-btn-secondary !min-h-9 px-3 py-1.5 text-xs" onClick={onCancelAddChild} disabled={addChildBusy}>
            {t('common.cancel')}
          </button>
        </form>
      ) : null}

      {expanded && hasChildren ? (
        <div>
          {node.children.map((ch, i) => (
            <TreeNodeRow
              key={ch.id}
              node={ch}
              depth={depth + 1}
              isLast={i === node.children.length - 1}
              canManage={canManage}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
              onReload={onReload}
              onRemove={onRemove}
              onMove={onMove}
              addingUnderId={addingUnderId}
              onStartAddChild={onStartAddChild}
              onCancelAddChild={onCancelAddChild}
              onSubmitAddChild={onSubmitAddChild}
              addChildDraft={addChildDraft}
              onAddChildDraftChange={onAddChildDraftChange}
              addChildBusy={addChildBusy}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function SettingsCategoriesPage() {
  const t = useT()
  const toast = useToast()
  const { user } = useAuth()
  const [tree, setTree] = useState<RequestCategoryTreeNode[]>([])
  const [newRootName, setNewRootName] = useState('')
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set())
  const [addingUnderId, setAddingUnderId] = useState<number | null>(null)
  const [addChildDraft, setAddChildDraft] = useState('')
  const [addChildBusy, setAddChildBusy] = useState(false)
  const [rootBusy, setRootBusy] = useState(false)
  const initialExpandDone = useRef(false)

  const canManage = Boolean(user?.is_superuser || user?.role === 'editor')

  const load = useCallback(async () => {
    try {
      const data = await api.requestCategories()
      setTree(data)
      if (!initialExpandDone.current && data.length > 0) {
        initialExpandDone.current = true
        setExpandedIds(new Set(collectExpandableIds(data)))
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsCategories.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  const filteredTree = useMemo(() => filterCategoryTree(tree, search), [tree, search])

  useEffect(() => {
    const q = search.trim()
    if (!q) return
    setExpandedIds((prev) => {
      const next = new Set(prev)
      for (const id of collectExpandableIds(filteredTree)) next.add(id)
      return next
    })
  }, [search, filteredTree])

  const nodeCount = useMemo(() => countNodes(tree), [tree])
  const visibleCount = useMemo(() => countNodes(filteredTree), [filteredTree])

  const toggleExpand = useCallback((id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const expandAll = useCallback(() => {
    setExpandedIds(new Set(collectExpandableIds(filteredTree)))
  }, [filteredTree])

  const collapseAll = useCallback(() => {
    setExpandedIds(new Set())
  }, [])

  async function addRoot() {
    const name = newRootName.trim()
    if (!name) return
    setRootBusy(true)
    try {
      await api.createRequestCategory({ name, parent_id: null })
      setNewRootName('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsCategories.addFailed'))
    } finally {
      setRootBusy(false)
    }
  }

  function startAddChild(parentId: number) {
    setAddingUnderId(parentId)
    setAddChildDraft('')
    setExpandedIds((prev) => new Set(prev).add(parentId))
  }

  function cancelAddChild() {
    setAddingUnderId(null)
    setAddChildDraft('')
  }

  async function submitAddChild(parentId: number) {
    const name = addChildDraft.trim()
    if (!name) return
    setAddChildBusy(true)
    try {
      await api.createRequestCategory({ name, parent_id: parentId })
      cancelAddChild()
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsCategories.addFailed'))
    } finally {
      setAddChildBusy(false)
    }
  }

  async function removeCategory(id: number, label: string, hasChildren: boolean) {
    const msg = hasChildren
      ? t('settingsCategories.deleteConfirmWithChildren', { label })
      : t('settingsCategories.deleteConfirmSingle', { label })
    if (!confirm(msg)) return
    try {
      await api.deleteRequestCategory(id)
      if (addingUnderId === id) cancelAddChild()
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsCategories.deleteFailed'))
    }
  }

  async function moveCategory(id: number, direction: 'up' | 'down') {
    const ctx = findSiblingContext(tree, id)
    if (!ctx) return
    const { siblings, index } = ctx
    const swapWith = direction === 'up' ? index - 1 : index + 1
    if (swapWith < 0 || swapWith >= siblings.length) return
    const a = siblings[index]
    const b = siblings[swapWith]
    try {
      await Promise.all([
        api.updateRequestCategory(a.id, { sort_order: b.sort_order }),
        api.updateRequestCategory(b.id, { sort_order: a.sort_order }),
      ])
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsCategories.moveFailed'))
    }
  }

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconTicket className="h-6 w-6" />
        </div>
        <div>
          <h1 className="page-title">{t('titles.categories')}</h1>
          <p className="mt-0.5 max-w-2xl text-sm text-[var(--color-fg-muted)]">
            {t('pages.categoriesSubtitle')}
          </p>
        </div>
      </div>

      {canManage ? (
        <div className="mb-6 flex max-w-2xl flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <label htmlFor="new-root-category" className="app-label">
              {t('settingsCategories.newRootLabel')}
            </label>
            <input
              id="new-root-category"
              value={newRootName}
              onChange={(e) => setNewRootName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addRoot()}
              placeholder={t('settingsCategories.newRootPlaceholder')}
              className="app-input text-sm"
              disabled={rootBusy}
            />
          </div>
          <button
            type="button"
            onClick={() => void addRoot()}
            className="app-btn app-btn-primary"
            disabled={rootBusy || !newRootName.trim()}
          >
            {rootBusy ? t('settingsCategories.addRootBusy') : t('settingsCategories.addRootButton')}
          </button>
        </div>
      ) : null}

      <div className="app-card max-w-4xl overflow-hidden !p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2.5">
          <div className="min-w-0 flex-1 text-xs text-[var(--color-fg-muted)]">
            {loading ? (
              t('common.loading')
            ) : search.trim() ? (
              <>
                {t('settingsCategories.statsShown', { visible: visibleCount, total: nodeCount })}
              </>
            ) : (
              <>
                {t('settingsCategories.statsTotal', { total: nodeCount })}
              </>
            )}
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('settingsCategories.searchPlaceholder')}
            className="app-input !min-h-9 max-w-xs flex-1 py-2 text-xs sm:max-w-sm"
            aria-label={t('settingsCategories.searchAria')}
          />
          <button type="button" className="app-btn app-btn-secondary !min-h-9 px-3 py-1.5 text-xs" onClick={expandAll} disabled={loading || filteredTree.length === 0}>
            {t('settingsCategories.expandAll')}
          </button>
          <button type="button" className="app-btn app-btn-secondary !min-h-9 px-3 py-1.5 text-xs" onClick={collapseAll} disabled={loading || filteredTree.length === 0}>
            {t('settingsCategories.collapseAll')}
          </button>
        </div>

        {loading ? (
          <div className="px-4 py-12 text-center text-[var(--color-fg-subtle)]">{t('settingsCategories.treeLoading')}</div>
        ) : filteredTree.length === 0 ? (
          <div className="app-empty-state !rounded-none border-0">
            {tree.length === 0
              ? t('settingsCategories.emptyNoCategories')
              : t('settingsCategories.emptyNoResults')}
          </div>
        ) : (
          <div className="bg-[var(--color-surface)] px-2 py-3 sm:px-3">
            {filteredTree.map((root, i) => (
              <TreeNodeRow
                key={root.id}
                node={root}
                depth={0}
                isLast={i === filteredTree.length - 1}
                canManage={canManage}
                expandedIds={expandedIds}
                onToggleExpand={toggleExpand}
                onReload={() => void load()}
                onRemove={removeCategory}
                onMove={moveCategory}
                addingUnderId={addingUnderId}
                onStartAddChild={startAddChild}
                onCancelAddChild={cancelAddChild}
                onSubmitAddChild={(id) => void submitAddChild(id)}
                addChildDraft={addChildDraft}
                onAddChildDraftChange={setAddChildDraft}
                addChildBusy={addChildBusy}
              />
            ))}
          </div>
        )}
      </div>

      {!canManage ? (
        <p className="mt-3 max-w-2xl text-xs text-[var(--color-fg-subtle)]">
          {t('settingsCategories.readonlyHint')}
        </p>
      ) : null}
    </div>
  )
}
