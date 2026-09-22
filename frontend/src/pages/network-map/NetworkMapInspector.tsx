import { useEffect, useRef, useState } from 'react'
import { api, type Computer, type NetworkDevice, type NetworkPrinter, type ZabbixHostRow } from '../../api'
import { NetworkMapGlyph } from './NetworkMapGlyph'
import { useT, type MessageKey } from '../../i18n/LocaleContext'
import { STENCILS, isDecorStencil, type MergedCanvasNode, type NetworkMapBind, type NetworkMapBindType, type NetworkMapGroup, type NetworkMapStencil } from './types'
import { stencilForBind } from './mergeScene'

type BindHit = {
  bind: NetworkMapBind
  label: string
  ip?: string | null
  kind: 'network' | 'computer' | 'printer' | 'zabbix'
  deviceType?: string | null
}

type Tab = 'network' | 'printers' | 'zabbix'

type NeighborRow = {
  topoId: string
  label: string
  ip: string | null
  localPort: string | null
  remotePort: string | null
  linkType: string
  canvasId: string | null
}

export type MapCableSelection = {
  id: string
  sourceLabel: string
  targetLabel: string
  localPort: string | null
  remotePort: string | null
  linkType: string
}

type Props = {
  canEdit: boolean
  node: MergedCanvasNode | null
  group: NetworkMapGroup | null
  edge?: MapCableSelection | null
  embedded?: boolean
  overlay?: boolean
  neighbors?: NeighborRow[]
  neighborsBusy?: boolean
  onLabel: (label: string) => void
  onStencil: (stencil: NetworkMapStencil) => void
  onBind: (bind: NetworkMapBind | null, extra?: { label?: string; ip?: string | null; stencil?: NetworkMapStencil }) => void
  onDelete: () => void
  onOpenCard: () => void
  onGroupTitle: (title: string) => void
  onDeleteGroup: () => void
  onDeleteCable?: () => void
  onEditCablePorts?: () => void
  onReplaceImage?: (file: File) => void
  onPlaceNeighbor?: (topoId: string) => void
  onFocusNeighbor?: (canvasId: string) => void
  onPlaceAllNeighbors?: () => void
  onGatherNeighbors?: () => void
  selectionCount?: number
  onPortCount?: (count: number | null) => void
  onGroupSize?: (width: number, height: number) => void
  onResetCableBend?: () => void
  onToggleLock?: () => void
  selectionAllLocked?: boolean
}

function statusLabel(status: string | null | undefined, t: (key: MessageKey) => string): string {
  if (status === 'ok' || status === 'online') return t('networkMap.statusOk')
  if (status === 'error' || status === 'offline') return t('networkMap.statusDown')
  if (!status) return t('networkMap.statusUnknown')
  return status
}

export function NetworkMapInspector({
  canEdit,
  node,
  group,
  edge = null,
  embedded = false,
  overlay = false,
  onLabel,
  onStencil,
  onBind,
  onDelete,
  onOpenCard,
  onGroupTitle,
  onDeleteGroup,
  onDeleteCable,
  onEditCablePorts,
  onReplaceImage,
  neighbors = [],
  neighborsBusy = false,
  onPlaceNeighbor,
  onFocusNeighbor,
  onPlaceAllNeighbors,
  onGatherNeighbors,
  selectionCount = 0,
  onPortCount,
  onGroupSize,
  onResetCableBend,
  onToggleLock,
  selectionAllLocked = false,
}: Props) {
  const t = useT()
  const [tab, setTab] = useState<Tab>('network')
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<BindHit[]>([])
  const [busy, setBusy] = useState(false)
  const [zabbixNote, setZabbixNote] = useState('')
  const [bindOpen, setBindOpen] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')
  const [groupDraft, setGroupDraft] = useState('')
  const [portDraft, setPortDraft] = useState('')
  const [groupW, setGroupW] = useState('')
  const [groupH, setGroupH] = useState('')
  const zabbixCache = useRef<{ ok: boolean; message: string; items: ZabbixHostRow[] } | null>(null)

  useEffect(() => {
    setQ('')
    setHits([])
    setZabbixNote('')
    setBindOpen(false)
    setLabelDraft(node?.label || '')
    setGroupDraft(group?.title || '')
    setPortDraft(node?.portCount ? String(node.portCount) : '')
    setGroupW(group ? String(Math.round(group.width)) : '')
    setGroupH(group ? String(Math.round(group.height)) : '')
  }, [node?.id, group?.id, node?.label, group?.title, node?.portCount, group?.width, group?.height])

  useEffect(() => {
    if (!node || !canEdit || !bindOpen) return
    if (isDecorStencil(node.stencil)) return
    const s = q.trim()
    let cancelled = false
    const handle = window.setTimeout(() => {
      void (async () => {
        setBusy(true)
        try {
          if (tab === 'network') {
            const devices = await api.networkDevices({ q: s || undefined, limit: 20 })
            const computers = s
              ? await api.computers({ q: s, limit: 6, view: 'list' })
              : { items: [] as Computer[] }
            if (cancelled) return
            const gear = (devices as NetworkDevice[]).filter((d) => d.device_type !== 'host')
            const rows: BindHit[] = [
              ...gear.map((d) => ({
                bind: { type: 'network_device' as const, id: d.id },
                label: d.hostname || d.sys_name || d.ip_address,
                ip: d.ip_address,
                kind: 'network' as const,
                deviceType: d.device_type,
              })),
              ...((computers.items || []) as Computer[]).map((c) => ({
                bind: { type: 'computer' as const, id: c.id },
                label: c.hostname,
                ip: c.ip_address,
                kind: 'computer' as const,
              })),
            ]
            setHits(rows)
            return
          }
          if (tab === 'printers') {
            const printers = await api.printers({ q: s || undefined, limit: 12, view: 'map' })
            if (cancelled) return
            setHits(
              (printers as NetworkPrinter[]).map((p) => ({
                bind: { type: 'printer' as const, id: p.id },
                label: p.name || p.ip_address || `Printer ${p.id}`,
                ip: p.ip_address,
                kind: 'printer',
              })),
            )
            return
          }
          if (tab === 'zabbix') {
            if (!zabbixCache.current) {
              const zb = await api.zabbixHosts(200)
              if (cancelled) return
              zabbixCache.current = {
                ok: Boolean(zb.enabled && zb.available),
                message: zb.message || t('networkMap.zabbixOff'),
                items: zb.items || [],
              }
            }
            const zb = zabbixCache.current
            if (!zb.ok) {
              setZabbixNote(zb.message)
              setHits([])
              return
            }
            setZabbixNote('')
            const needle = s.toLowerCase()
            const items = zb.items.filter((h) => {
              if (!needle) return true
              return `${h.name} ${h.host} ${h.ip}`.toLowerCase().includes(needle)
            })
            setHits(
              items.slice(0, 16).flatMap((h) => {
                const id = Number(h.hostid)
                if (!Number.isFinite(id)) return []
                return [
                  {
                    bind: { type: 'zabbix' as const, id },
                    label: h.name || h.host || h.hostid,
                    ip: h.ip || null,
                    kind: 'zabbix' as const,
                  },
                ]
              }),
            )
            return
          }
        } catch {
          if (!cancelled) setHits([])
        } finally {
          if (!cancelled) setBusy(false)
        }
      })()
    }, tab === 'zabbix' ? 0 : 180)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [q, node, canEdit, tab, t, bindOpen])

  const shell = overlay
    ? 'network-map-inspector flex max-h-full w-[16.5rem] flex-col gap-2.5 overflow-y-auto px-3 py-2.5'
    : embedded
      ? 'flex flex-col gap-2.5 px-3 py-3'
      : 'network-map-inspector flex w-[19rem] shrink-0 flex-col gap-2.5 overflow-y-auto border-l px-3 py-2.5'

  if (selectionCount > 1) {
    return (
      <aside className={shell}>
        <div className="text-sm font-semibold leading-5">{t('networkMap.selectedCount', { n: selectionCount })}</div>
        <p className="text-[11px] leading-5 text-[var(--color-fg-subtle)]">{t('networkMap.shiftSelectHint')}</p>
        {canEdit && onToggleLock ? (
          <button
            type="button"
            onClick={onToggleLock}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg-muted)]"
          >
            {selectionAllLocked ? t('networkMap.unlockSelection') : t('networkMap.lockSelection')}
          </button>
        ) : null}
        {canEdit ? (
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg-muted)]"
          >
            {t('networkMap.removeSelection')}
          </button>
        ) : null}
      </aside>
    )
  }

  if (edge && !node) {
    const ports = [edge.localPort, edge.remotePort].filter(Boolean).join(' → ')
    return (
      <aside className={shell}>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
            {t('networkMap.cable')}
          </div>
          <div className="mt-1 text-sm font-semibold leading-5">
            {edge.sourceLabel} → {edge.targetLabel}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-[var(--color-fg-muted)]">{ports || t('networkMap.portPickNone')}</div>
        </div>
        {canEdit ? (
          <>
            {onEditCablePorts ? (
              <button
                type="button"
                onClick={onEditCablePorts}
                className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg-muted)]"
              >
                {t('networkMap.editCablePorts')}
              </button>
            ) : null}
            {onResetCableBend ? (
              <button
                type="button"
                onClick={onResetCableBend}
                className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg-muted)]"
              >
                {t('networkMap.resetCableBend')}
              </button>
            ) : null}
            {onDeleteCable ? (
              <button
                type="button"
                onClick={onDeleteCable}
                className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg-muted)]"
              >
                {t('networkMap.deleteCable')}
              </button>
            ) : null}
            <p className="text-[11px] leading-5 text-[var(--color-fg-subtle)]">{t('networkMap.cableHint')}</p>
          </>
        ) : null}
      </aside>
    )
  }

  if (group && !node) {
    return (
      <aside className={shell}>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
          {t(`networkMap.groupKind.${group.kind}` as MessageKey)}
        </div>
        <label className="block text-xs">
          {t('networkMap.groupTitle')}
          <input
            disabled={!canEdit}
            value={groupDraft}
            onChange={(e) => setGroupDraft(e.target.value)}
            onBlur={() => {
              if (groupDraft.trim() && groupDraft !== group.title) onGroupTitle(groupDraft.trim())
            }}
            className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm disabled:opacity-60"
          />
        </label>
        {canEdit && onGroupSize ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs">
              {t('networkMap.groupWidth')}
              <input
                type="number"
                min={160}
                max={2400}
                value={groupW}
                onChange={(e) => setGroupW(e.target.value)}
                onBlur={() => {
                  const w = Math.max(160, Math.min(2400, Number(groupW) || group.width))
                  const h = Math.max(88, Math.min(1800, Number(groupH) || group.height))
                  setGroupW(String(Math.round(w)))
                  if (w !== group.width || h !== group.height) onGroupSize(w, h)
                }}
                className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm"
              />
            </label>
            <label className="block text-xs">
              {t('networkMap.groupHeight')}
              <input
                type="number"
                min={88}
                max={1800}
                value={groupH}
                onChange={(e) => setGroupH(e.target.value)}
                onBlur={() => {
                  const w = Math.max(160, Math.min(2400, Number(groupW) || group.width))
                  const h = Math.max(88, Math.min(1800, Number(groupH) || group.height))
                  setGroupH(String(Math.round(h)))
                  if (w !== group.width || h !== group.height) onGroupSize(w, h)
                }}
                className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm"
              />
            </label>
          </div>
        ) : null}
        <p className="text-[11px] leading-5 text-[var(--color-fg-subtle)]">{t('networkMap.roomHint')}</p>
        {canEdit && onToggleLock ? (
          <>
            <button
              type="button"
              onClick={onToggleLock}
              className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg-muted)]"
            >
              {group.locked ? t('networkMap.unlock') : t('networkMap.lock')}
            </button>
            <p className="text-[11px] leading-5 text-[var(--color-fg-subtle)]">{t('networkMap.lockHint')}</p>
          </>
        ) : null}
        {canEdit ? (
          <button
            type="button"
            onClick={onDeleteGroup}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg-muted)]"
          >
            {t('networkMap.remove')}
          </button>
        ) : null}
      </aside>
    )
  }

  if (!node) {
    if (overlay) return null
    return (
      <aside className={shell}>
        <p className="text-[12px] leading-5 text-[var(--color-fg-subtle)]">{t('networkMap.inspectorEmpty')}</p>
      </aside>
    )
  }

  const decor = isDecorStencil(node.stencil)

  const bindLabel = (type: NetworkMapBindType) => {
    if (type === 'computer') return t('networkMap.bindComputer')
    if (type === 'printer') return t('networkMap.bindPrinter')
    if (type === 'network_device') return t('networkMap.bindDevice')
    if (type === 'zabbix') return t('networkMap.bindZabbix')
    return t('networkMap.bindCorax')
  }

  const pick = (hit: BindHit) => {
    onBind(hit.bind, {
      label: hit.label,
      ip: hit.ip,
      stencil: stencilForBind(
        hit.bind.type,
        hit.deviceType || (hit.kind === 'computer' ? 'pc' : hit.kind === 'printer' ? 'printer' : undefined),
      ),
    })
    setBindOpen(false)
  }

  const searchPlaceholder =
    tab === 'printers' ? t('networkMap.searchPrinters') : tab === 'zabbix' ? t('networkMap.searchZabbix') : t('networkMap.searchNetwork')
  const ports = node.ports || []

  return (
    <aside className={shell}>
      <div className="flex items-start gap-2.5">
        {!decor ? (
          <NetworkMapGlyph kind={node.stencil} size="md" className="mt-0.5" />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-5">{node.label}</div>
          {node.ip ? <div className="mt-0.5 font-mono text-[11px] text-[var(--color-fg-muted)]">{node.ip}</div> : null}
          <div className="mt-0.5 text-[11px] text-[var(--color-fg-subtle)]">
            {t(`networkMap.stencil.${node.stencil}` as MessageKey)}
            {node.missing ? ` · ${t('networkMap.missing')}` : ''}
            {!decor ? ` · ${statusLabel(node.status, t)}` : ''}
            {node.locked ? ` · ${t('networkMap.lockedMark')}` : ''}
          </div>
        </div>
      </div>
      <label className="block text-xs">
        {node.stencil === 'note' ? t('networkMap.caption') : t('networkMap.label')}
        {node.stencil === 'note' ? (
          <textarea
            disabled={!canEdit}
            value={labelDraft}
            rows={4}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={() => {
              if (labelDraft !== node.label) onLabel(labelDraft)
            }}
            className="mt-1 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm disabled:opacity-60"
          />
        ) : (
          <input
            disabled={!canEdit}
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={() => {
              if (labelDraft !== node.label) onLabel(labelDraft)
            }}
            className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm disabled:opacity-60"
          />
        )}
      </label>
      {!decor ? (
        <>
          {canEdit && onPortCount ? (
            <label className="block text-xs">
              {t('networkMap.portCount')}
              <input
                type="number"
                min={0}
                max={96}
                value={portDraft}
                placeholder="24"
                onChange={(e) => setPortDraft(e.target.value)}
                onBlur={() => {
                  const raw = portDraft.trim()
                  const next = raw === '' ? null : Math.max(0, Math.min(96, Number(raw) || 0))
                  const current = node.portCount ?? null
                  const normalized = next && next > 0 ? next : null
                  setPortDraft(normalized ? String(normalized) : '')
                  if (normalized !== current) onPortCount(normalized)
                }}
                className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm"
              />
              <span className="mt-1 block text-[11px] leading-4 text-[var(--color-fg-subtle)]">
                {t('networkMap.portCountHint')}
              </span>
            </label>
          ) : null}
          <div>
            <div className="text-xs text-[var(--color-fg-subtle)]">{t('networkMap.ports')}</div>
            {ports.length > 0 ? (
              <ul className="mt-1 max-h-36 overflow-y-auto rounded-lg border border-[var(--color-border)]">
                {ports.slice(0, 32).map((port) => (
                  <li key={port.id} className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-2 py-1 last:border-b-0">
                    <span className="truncate font-mono text-[11px]">{port.name}</span>
                    <span className={`text-[10px] ${port.up === true ? 'text-emerald-600' : port.up === false ? 'text-[var(--color-fg-subtle)]' : 'text-[var(--color-fg-muted)]'}`}>
                      {port.up === true ? t('networkMap.statusOk') : port.up === false ? t('networkMap.statusDown') : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">{t('networkMap.portsEmpty')}</p>
            )}
          </div>
          {node.bind && node.bind.type !== 'zabbix' && node.bind.type !== 'corax' ? (
            <div>
              <div className="text-xs text-[var(--color-fg-subtle)]">{t('networkMap.neighbors')}</div>
              {neighborsBusy && neighbors.length === 0 ? (
                <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">{t('common.loading')}</p>
              ) : null}
              {neighbors.length > 0 ? (
                <>
                  {canEdit ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {neighbors.some((n) => !n.canvasId) && onPlaceAllNeighbors ? (
                        <button
                          type="button"
                          onClick={onPlaceAllNeighbors}
                          className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] font-medium hover:bg-[var(--color-bg-muted)]"
                        >
                          {t('networkMap.placeNeighbors')}
                        </button>
                      ) : null}
                      {neighbors.some((n) => n.canvasId) && onGatherNeighbors ? (
                        <button
                          type="button"
                          onClick={onGatherNeighbors}
                          className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] font-medium hover:bg-[var(--color-bg-muted)]"
                        >
                          {t('networkMap.gatherNeighbors')}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  <ul className="mt-1.5 max-h-40 overflow-y-auto rounded-lg border border-[var(--color-border)]">
                    {neighbors.map((n) => (
                      <li key={n.topoId} className="flex items-center gap-1 border-b border-[var(--color-border)] px-2 py-1.5 last:border-b-0">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium">{n.label}</div>
                          <div className="truncate text-[10px] text-[var(--color-fg-subtle)]">
                            {[n.localPort, n.remotePort].filter(Boolean).join(' → ') || n.linkType.toUpperCase()}
                            {n.ip ? ` · ${n.ip}` : ''}
                          </div>
                        </div>
                        {n.canvasId && onFocusNeighbor ? (
                          <button
                            type="button"
                            onClick={() => onFocusNeighbor(n.canvasId as string)}
                            className="shrink-0 text-[11px] text-[var(--color-primary)] hover:underline"
                          >
                            {t('networkMap.focusNeighbor')}
                          </button>
                        ) : canEdit && onPlaceNeighbor ? (
                          <button
                            type="button"
                            onClick={() => onPlaceNeighbor(n.topoId)}
                            className="shrink-0 text-[11px] font-medium text-[var(--color-primary)] hover:underline"
                          >
                            {t('networkMap.place')}
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : !neighborsBusy ? (
                <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">{t('networkMap.noNeighbors')}</p>
              ) : null}
            </div>
          ) : null}
          <div>
            <div className="text-xs text-[var(--color-fg-subtle)]">{t('networkMap.bind')}</div>
            <div className={`mt-1 text-sm ${node.bind ? 'network-map-bind-pill' : ''}`}>
              {node.bind ? `${node.label}${node.ip ? ` · ${node.ip}` : ''}` : t('networkMap.bindNone')}
            </div>
            {node.bind ? (
              <div className="mt-0.5 text-[11px] text-[var(--color-fg-subtle)]">{bindLabel(node.bind.type)}</div>
            ) : null}
            {canEdit ? (
              <>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <button
                    type="button"
                    onClick={() => setBindOpen((open) => !open)}
                    className="text-xs text-[var(--color-primary)] hover:underline"
                  >
                    {node.bind ? t('networkMap.changeBind') : t('networkMap.bindToInventory')}
                  </button>
                </div>
                {node.bind ? (
                  <button
                    type="button"
                    onClick={() => onBind(null)}
                    className="mt-2 w-full rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg-muted)]"
                  >
                    {t('networkMap.unbind')}
                  </button>
                ) : null}
                {bindOpen ? (
                  <>
                    <div className="mt-2 flex gap-1">
                      {(['network', 'printers', 'zabbix'] as const).map((id) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setTab(id)}
                          className={`rounded-md px-2 py-1 text-[11px] font-medium ${
                            tab === id
                              ? 'bg-[var(--color-fg)] text-[var(--color-surface)]'
                              : 'bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]'
                          }`}
                        >
                          {id === 'network' ? t('networkMap.tabNetwork') : id === 'printers' ? t('networkMap.tabPrinters') : t('networkMap.tabZabbix')}
                        </button>
                      ))}
                    </div>
                    <input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder={searchPlaceholder}
                      className="mt-2 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-xs"
                    />
                    {zabbixNote ? <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">{zabbixNote}</p> : null}
                    {busy && hits.length === 0 ? (
                      <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">{t('common.loading')}</p>
                    ) : null}
                    {hits.length > 0 ? (
                      <ul className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-[var(--color-border)]">
                        {hits.map((h) => (
                          <li key={`${h.kind}:${h.bind.type}:${h.bind.id}`}>
                            <button
                              type="button"
                              onClick={() => pick(h)}
                              className="block w-full px-2 py-1.5 text-left text-xs hover:bg-[var(--color-bg-muted)]"
                            >
                              <span className="font-medium">{h.label}</span>
                              <span className="ml-1 text-[var(--color-fg-subtle)]">{h.ip}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : !busy && !zabbixNote ? (
                      <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">{t('common.nothingFound')}</p>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}
          </div>
          {canEdit ? (
            <label className="block text-xs">
              {t('networkMap.kind')}
              <select
                value={node.stencil}
                onChange={(e) => onStencil(e.target.value as NetworkMapStencil)}
                className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm"
              >
                {STENCILS.map((stencil) => (
                  <option key={stencil} value={stencil}>
                    {t(`networkMap.stencil.${stencil}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {node.bind && node.bind.type !== 'corax' && node.bind.type !== 'zabbix' ? (
            <button
              type="button"
              onClick={onOpenCard}
              className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)]"
            >
              {t('networkMap.openCard')}
            </button>
          ) : null}
        </>
      ) : node.stencil === 'image' && canEdit && onReplaceImage ? (
        <label className="cursor-pointer rounded-lg border border-[var(--color-border)] px-3 py-2 text-center text-sm hover:bg-[var(--color-bg-muted)]">
          {t('networkMap.replaceImage')}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) onReplaceImage(file)
            }}
          />
        </label>
      ) : null}
      {canEdit && onToggleLock ? (
        <>
          <button
            type="button"
            onClick={onToggleLock}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg-muted)]"
          >
            {node.locked ? t('networkMap.unlock') : t('networkMap.lock')}
          </button>
          <p className="text-[11px] leading-5 text-[var(--color-fg-subtle)]">{t('networkMap.lockHint')}</p>
        </>
      ) : null}
      {canEdit ? (
        <button
          type="button"
          onClick={onDelete}
          className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg-muted)]"
        >
          {t('networkMap.remove')}
        </button>
      ) : null}
    </aside>
  )
}
