import { useEffect, useRef, useState } from 'react'
import { api, type Computer, type NetworkDevice, type NetworkPrinter, type ZabbixHostRow } from '../../api'
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

type Props = {
  canEdit: boolean
  node: MergedCanvasNode | null
  group: NetworkMapGroup | null
  neighbors?: NeighborRow[]
  neighborsBusy?: boolean
  onLabel: (label: string) => void
  onStencil: (stencil: NetworkMapStencil) => void
  onBind: (bind: NetworkMapBind | null, extra?: { label?: string; ip?: string | null; stencil?: NetworkMapStencil }) => void
  onDelete: () => void
  onOpenCard: () => void
  onGroupTitle: (title: string) => void
  onDeleteGroup: () => void
  onReplaceImage?: (file: File) => void
  onPlaceNeighbor?: (topoId: string) => void
  onFocusNeighbor?: (canvasId: string) => void
  onPlaceAllNeighbors?: () => void
  onGatherNeighbors?: () => void
}

export function NetworkMapInspector({
  canEdit,
  node,
  group,
  onLabel,
  onStencil,
  onBind,
  onDelete,
  onOpenCard,
  onGroupTitle,
  onDeleteGroup,
  onReplaceImage,
  neighbors = [],
  neighborsBusy = false,
  onPlaceNeighbor,
  onFocusNeighbor,
  onPlaceAllNeighbors,
  onGatherNeighbors,
}: Props) {
  const t = useT()
  const [tab, setTab] = useState<Tab>('network')
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<BindHit[]>([])
  const [busy, setBusy] = useState(false)
  const [zabbixNote, setZabbixNote] = useState('')
  const zabbixCache = useRef<{ ok: boolean; message: string; items: ZabbixHostRow[] } | null>(null)

  useEffect(() => {
    setQ('')
    setHits([])
    setZabbixNote('')
  }, [node?.id, group?.id])

  useEffect(() => {
    if (!node || !canEdit) return
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
            const hosts = (devices as NetworkDevice[]).filter((d) => d.device_type === 'host')
            const rows: BindHit[] = [
              ...gear.map((d) => ({
                bind: { type: 'network_device' as const, id: d.id },
                label: d.hostname || d.sys_name || d.ip_address,
                ip: d.ip_address,
                kind: 'network' as const,
                deviceType: d.device_type,
              })),
              ...hosts.slice(0, s ? 6 : 0).map((d) => ({
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
  }, [q, node, canEdit, tab, t])

  if (group && !node) {
    return (
      <aside className="flex w-[19rem] shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
          {t('networkMap.groups')}
        </div>
        <label className="block text-xs">
          {t('networkMap.groupTitle')}
          <input
            disabled={!canEdit}
            value={group.title}
            onChange={(e) => onGroupTitle(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm disabled:opacity-60"
          />
        </label>
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

  if (!node) return null

  const decor = isDecorStencil(node.stencil)

  const bindLabel = (type: NetworkMapBindType) => {
    if (type === 'computer') return t('networkMap.bindComputer')
    if (type === 'printer') return t('networkMap.bindPrinter')
    if (type === 'network_device') return t('networkMap.bindDevice')
    if (type === 'zabbix') return t('networkMap.bindZabbix')
    return 'Corax'
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
  }

  const searchPlaceholder =
    tab === 'printers' ? t('networkMap.searchPrinters') : tab === 'zabbix' ? t('networkMap.searchZabbix') : t('networkMap.searchNetwork')

  return (
    <aside className="flex w-[19rem] shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
          {t('networkMap.inspector')}
        </div>
        <div className="mt-1 text-sm font-semibold">{node.label}</div>
        <div className="text-[11px] text-[var(--color-fg-subtle)]">
          {t(`networkMap.stencil.${node.stencil}` as MessageKey)}
          {node.missing ? ` · ${t('networkMap.missing')}` : ''}
        </div>
      </div>
      <label className="block text-xs">
        {node.stencil === 'note' ? t('networkMap.caption') : t('networkMap.label')}
        {node.stencil === 'note' ? (
          <textarea
            disabled={!canEdit}
            value={node.label}
            rows={4}
            onChange={(e) => onLabel(e.target.value)}
            className="mt-1 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm disabled:opacity-60"
          />
        ) : (
          <input
            disabled={!canEdit}
            value={node.label}
            onChange={(e) => onLabel(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm disabled:opacity-60"
          />
        )}
      </label>
      {!decor ? (
      <>
      <label className="block text-xs">
        {t('networkMap.kind')}
        <select
          disabled={!canEdit}
          value={node.stencil}
          onChange={(e) => onStencil(e.target.value as NetworkMapStencil)}
          className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm disabled:opacity-60"
        >
          {STENCILS.map((stencil) => (
            <option key={stencil} value={stencil}>
              {t(`networkMap.stencil.${stencil}` as MessageKey)}
            </option>
          ))}
        </select>
      </label>
      <div className="text-xs">
        <div className="text-[var(--color-fg-subtle)]">{t('networkMap.status')}</div>
        <div className="mt-0.5 font-medium">{node.status || '—'}</div>
        {node.ip ? <div className="mt-0.5 font-mono text-[11px]">{node.ip}</div> : null}
        {node.vendor ? <div className="text-[11px] text-[var(--color-fg-muted)]">{node.vendor}</div> : null}
      </div>
      <div>
        <div className="text-xs text-[var(--color-fg-subtle)]">{t('networkMap.bind')}</div>
        <div className="mt-1 text-sm">
          {node.bind ? `${bindLabel(node.bind.type)} #${node.bind.id}` : t('networkMap.bindNone')}
        </div>
        {canEdit ? (
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
            {node.bind ? (
              <button
                type="button"
                onClick={() => onBind(null)}
                className="mt-2 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              >
                {t('networkMap.unbind')}
              </button>
            ) : null}
          </>
        ) : null}
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
                      className="rounded-md bg-[var(--color-fg)] px-2 py-1 text-[11px] font-medium text-[var(--color-surface)]"
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
                        {[n.linkType.toUpperCase(), n.localPort, n.remotePort].filter(Boolean).join(' · ')}
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
