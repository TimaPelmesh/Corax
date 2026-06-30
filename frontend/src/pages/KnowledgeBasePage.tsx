import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactFlow, { Background, Controls, MiniMap, type Edge, type Node } from 'reactflow'
import 'reactflow/dist/style.css'
import { api, type Computer, type ServiceRequestRow, type TagBrief, type UserDirectoryItem } from '../api'
import { IconGraph } from '../components/icons'

type KBMode = 'tagCloud'

type KBNodeData = {
  label: string
  sub?: string
  tone?: 'neutral' | 'brand' | 'muted'
}

function makeGroupNode(
  id: string,
  label: string,
  pos: { x: number; y: number },
  size: { w: number; h: number },
): Node<KBNodeData> {
  return {
    id,
    type: 'group',
    position: pos,
    data: { label, tone: 'muted' },
    draggable: false,
    selectable: false,
    style: {
      width: size.w,
      height: size.h,
      borderRadius: 16,
      border: '1px solid rgb(229 229 229)',
      background: 'rgba(250,250,250,0.75)',
      boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
    },
  }
}

function renderNode(data: KBNodeData) {
  return (
    <div className="min-w-0">
      <div className="truncate text-sm font-semibold text-neutral-950">{data.label}</div>
      {data.sub ? <div className="mt-1 truncate text-xs text-neutral-500">{data.sub}</div> : null}
    </div>
  )
}

export function KnowledgeBasePage() {
  const [_mode] = useState<KBMode>('tagCloud')
  const [pcList, setPcList] = useState<Computer[]>([])
  const [userDir, setUserDir] = useState<UserDirectoryItem[]>([])
  const [tags, setTags] = useState<TagBrief[]>([])
  const [requests, setRequests] = useState<ServiceRequestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [selectedTagId, setSelectedTagId] = useState<string>('')

  const loadBase = useCallback(async () => {
    setErr(null)
    setLoading(true)
    try {
      const [pcs, users, tags, reqs] = await Promise.all([
        api.computers({ limit: 500 }).then((r) => r.items),
        api.usersDirectory(),
        api.tags(),
        api.serviceRequests({ limit: 400 }).then((r) => r.items),
      ])
      setPcList(pcs)
      setUserDir(users)
      setTags(tags)
      setRequests(reqs)
      if (!selectedTagId && tags.length) setSelectedTagId(String(tags[0].id))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [selectedTagId])

  useEffect(() => {
    void loadBase()
  }, [loadBase])

  const { nodes, edges } = useMemo(() => {
    const nodes: Node<KBNodeData>[] = []
    const edges: Edge[] = []

    // Tag bubble cloud (no controls). One canvas + right detail panel.
    const cloudW = 1080
    const cloudH = 760
    nodes.push(makeGroupNode('g-cloud', 'Теги', { x: 0, y: 0 }, { w: cloudW, h: cloudH }))

    // Compute tag -> pc_count from already loaded pcList.
    const tagToPcCount = new Map<number, number>()
    for (const pc of pcList) for (const t of pc.tags ?? []) tagToPcCount.set(t.id, (tagToPcCount.get(t.id) ?? 0) + 1)
    const rows = tags
      .map((t) => ({ t, pcCount: tagToPcCount.get(t.id) ?? 0 }))
      .sort((a, b) => b.pcCount - a.pcCount)
      .slice(0, 40)

    // Bubble cloud layout: place bubbles on a simple spiral.
    const centerX = cloudW / 2
    const centerY = cloudH / 2
    rows.forEach((row, idx) => {
      const { t, pcCount } = row
      const angle = idx * 0.85
      const radius = 18 + idx * 10.5
      const x = centerX + Math.cos(angle) * radius
      const y = centerY + Math.sin(angle) * radius
      const size = Math.max(110, Math.min(220, 110 + pcCount * 6))
      const nid = `tag-${t.id}`
      nodes.push({
        id: nid,
        parentNode: 'g-cloud',
        extent: 'parent',
        position: { x: x - size / 2, y: y - size / 2 },
        draggable: false,
        data: { label: t.name, sub: `${pcCount} ПК`, tone: t.id === Number(selectedTagId) ? 'brand' : 'neutral' },
        style: {
          width: size,
          height: size,
          borderRadius: 9999,
          border: t.id === Number(selectedTagId) ? '1px solid rgb(220 38 38)' : '1px solid rgb(229 229 229)',
          background: t.id === Number(selectedTagId) ? 'rgba(254,242,242,0.95)' : 'rgba(255,255,255,0.92)',
          boxShadow: '0 10px 35px -22px rgba(0,0,0,0.22)',
          padding: 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          cursor: 'pointer',
        },
      })
    })

    return { nodes, edges }
  }, [pcList, selectedTagId, tags])

  const nodeTypes = useMemo(
    () => ({
      default: ({ data }: { data: KBNodeData }) => <div className="min-w-0">{renderNode(data)}</div>,
    }),
    [],
  )

  const activeTag = useMemo(() => {
    const id = selectedTagId ? Number(selectedTagId) : NaN
    if (!Number.isFinite(id)) return null
    return tags.find((t) => t.id === id) ?? null
  }, [selectedTagId, tags])

  const tagPcIds = useMemo(() => {
    const id = selectedTagId ? Number(selectedTagId) : NaN
    if (!Number.isFinite(id)) return new Set<number>()
    const set = new Set<number>()
    for (const pc of pcList) if (pc.tags?.some((t) => t.id === id)) set.add(pc.id)
    return set
  }, [pcList, selectedTagId])

  const tagPcs = useMemo(() => {
    const pcIdSet = tagPcIds
    if (!pcIdSet.size) return []
    return pcList.filter((pc) => pcIdSet.has(pc.id)).slice(0, 30)
  }, [pcList, tagPcIds])

  const tagUsers = useMemo(() => {
    const ids = new Set<number>()
    for (const pc of tagPcs) if (pc.assigned_user_id) ids.add(pc.assigned_user_id)
    return [...ids]
      .map((id) => userDir.find((u) => u.id === id))
      .filter(Boolean)
      .slice(0, 30) as UserDirectoryItem[]
  }, [tagPcs, userDir])

  const tagRequests = useMemo(() => {
    const pcIdSet = tagPcIds
    if (!pcIdSet.size) return []
    return requests.filter((r) => (r.computer_id != null ? pcIdSet.has(r.computer_id) : false)).slice(0, 25)
  }, [requests, tagPcIds])

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
          <div className="page-hero-icon mt-0.5">
            <IconGraph className="h-6 w-6" />
          </div>
          <div>
            <h1 className="page-title">База знаний</h1>
            <p className="mt-1 max-w-2xl text-slate-600">
              Теги как облако. Клик по тегу — подробности: пользователи, ПК, периферия и заявки.
            </p>
          </div>
        </div>
      </div>

      {err ? <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{err}</div> : null}

      <div className="app-card overflow-hidden p-0">
        <div className="flex h-[min(72vh,820px)] w-full flex-row">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-500">Загрузка…</div>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  fitView
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable
                  proOptions={{ hideAttribution: true }}
                  defaultViewport={{ x: 0, y: 0, zoom: 0.9 }}
                  onNodeClick={(_, n) => {
                    const m = /^tag-(\d+)$/.exec(n.id)
                    if (!m) return
                    const id = Number(m[1])
                    if (!Number.isFinite(id)) return
                    setSelectedTagId(String(id))
                  }}
                >
                  <Background color="rgba(163,163,163,0.25)" gap={18} />
                  <MiniMap pannable zoomable nodeStrokeWidth={2} />
                  <Controls />
                </ReactFlow>
              </div>
              <aside className="hidden w-[min(28rem,44vw)] shrink-0 border-l border-neutral-200/80 bg-white p-4 sm:block">
                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Карточка тега</div>
                {!activeTag ? (
                  <div className="mt-3 rounded-xl border border-dashed border-slate-200/90 bg-slate-50/50 px-4 py-6 text-sm text-slate-600">
                    Выберите тег в облаке.
                  </div>
                ) : (
                  <div className="mt-3 space-y-4">
                    <div>
                      <div className="text-base font-semibold text-neutral-950">{activeTag.name}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {activeTag.color ? `цвет ${activeTag.color}` : 'цвет не задан'}
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-200/80 bg-white p-3">
                      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">ПК</div>
                      {tagPcs.length ? (
                        <ul className="mt-2 space-y-1 text-sm text-slate-700">
                          {tagPcs.slice(0, 12).map((pc) => (
                            <li key={pc.id} className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate font-medium text-neutral-900">{pc.hostname}</span>
                              <span className="shrink-0 text-xs text-slate-500">
                                {pc.location ?? pc.os_name ?? '—'}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="mt-2 text-sm text-slate-500">Нет ПК с этим тегом</div>
                      )}
                    </div>

                    <div className="rounded-xl border border-slate-200/80 bg-white p-3">
                      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Пользователи</div>
                      {tagUsers.length ? (
                        <ul className="mt-2 space-y-1 text-sm text-slate-700">
                          {tagUsers.slice(0, 12).map((u) => (
                            <li key={u.id} className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate font-medium text-neutral-900">
                                {(u.full_name ?? '').trim() ? u.full_name : u.username}
                              </span>
                              <span className="shrink-0 text-xs text-slate-500">@{u.username}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="mt-2 text-sm text-slate-500">Нет закреплённых пользователей</div>
                      )}
                    </div>

                    <div className="rounded-xl border border-slate-200/80 bg-white p-3">
                      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Заявки</div>
                      {tagRequests.length ? (
                        <ul className="mt-2 space-y-1 text-sm text-slate-700">
                          {tagRequests.slice(0, 12).map((r) => (
                            <li key={r.id} className="min-w-0">
                              <div className="truncate font-medium text-neutral-900">{r.title}</div>
                              <div className="truncate text-xs text-slate-500">
                                {r.status} · {r.priority}
                                {r.computer_hostname ? ` · ${r.computer_hostname}` : ''}
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="mt-2 text-sm text-slate-500">Заявок не найдено</div>
                      )}
                    </div>
                  </div>
                )}
              </aside>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

