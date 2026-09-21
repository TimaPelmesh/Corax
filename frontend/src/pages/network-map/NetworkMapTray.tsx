import { IconMenu } from '../../components/icons'
import { useT } from '../../i18n/LocaleContext'
import type { TrayGear } from './inventory'
import { NetworkMapGlyph } from './NetworkMapGlyph'
import { NETWORK_MAP_DND, type PaletteDrag } from './types'

type Props = {
  canEdit: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  trayQuery: string
  onTrayQuery: (value: string) => void
  gear: TrayGear[]
  layers: Array<{ cidr: string; count: number }>
  activeCidr: string | null
  onFilterCidr: (cidr: string | null) => void
  onPlaceGear: (item: TrayGear) => void
}

export function NetworkMapTray({
  canEdit,
  open,
  onOpenChange,
  trayQuery,
  onTrayQuery,
  gear,
  layers,
  activeCidr,
  onFilterCidr,
  onPlaceGear,
}: Props) {
  const t = useT()
  const q = trayQuery.trim().toLowerCase()
  const shown = q
    ? gear.filter((item) => `${item.label} ${item.ip || ''}`.toLowerCase().includes(q))
    : gear

  return (
    <aside
      className={`network-map-tray flex shrink-0 flex-col overflow-hidden border-r border-[var(--color-border)] ${
        open ? 'w-[15rem]' : 'w-10'
      }`}
    >
      <div className={`flex items-center gap-1 border-b border-[var(--color-border)] ${open ? 'px-2 py-1.5' : 'justify-center px-1 py-2'}`}>
        <button
          type="button"
          aria-expanded={open}
          title={open ? t('networkMap.trayHide') : t('networkMap.trayShow')}
          onClick={() => onOpenChange(!open)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
        >
          <IconMenu className="h-4 w-4" />
        </button>
        {open ? (
          <div className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
            {t('networkMap.tray')}
          </div>
        ) : null}
      </div>
      {open ? (
        <>
          <div className="border-b border-[var(--color-border)] px-3 py-2">
            <input
              value={trayQuery}
              onChange={(e) => onTrayQuery(e.target.value)}
              placeholder={t('networkMap.searchInventory')}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {shown.length === 0 ? (
              <p className="px-1 text-[11px] leading-5 text-[var(--color-fg-subtle)]">{t('networkMap.trayEmpty')}</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {shown.map((item) => {
                  return (
                    <li key={`${item.bind.type}:${item.bind.id}`}>
                      <button
                        type="button"
                        disabled={!canEdit}
                        draggable={canEdit}
                        title={item.ip || item.label}
                        onClick={() => canEdit && onPlaceGear(item)}
                        onDragStart={(e) => {
                          const payload: PaletteDrag = {
                            kind: 'inventory',
                            bind: item.bind,
                            label: item.label,
                            ip: item.ip,
                            stencil: item.stencil,
                          }
                          e.dataTransfer.setData(NETWORK_MAP_DND, JSON.stringify(payload))
                          e.dataTransfer.setData('text/plain', JSON.stringify(payload))
                          e.dataTransfer.effectAllowed = 'copy'
                        }}
                        className="flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
                      >
                        <NetworkMapGlyph kind={item.stencil} size="sm" className="mt-0.5" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">{item.label}</span>
                          {item.ip ? (
                            <span className="block truncate font-mono text-[10px] text-[var(--color-fg-subtle)]">{item.ip}</span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            {layers.length > 0 ? (
              <div className="mt-3 border-t border-[var(--color-border)] pt-2">
                <div className="px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
                  {t('networkMap.subnets')}
                </div>
                <button
                  type="button"
                  onClick={() => onFilterCidr(null)}
                  className={`mt-1 w-full rounded-md px-1.5 py-1 text-left text-[11px] ${
                    !activeCidr ? 'bg-[var(--color-bg-muted)] font-medium' : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]'
                  }`}
                >
                  {t('networkMap.filterAll')}
                </button>
                {layers.map((layer) => (
                  <button
                    key={layer.cidr}
                    type="button"
                    onClick={() => onFilterCidr(activeCidr === layer.cidr ? null : layer.cidr)}
                    className={`mt-0.5 flex w-full items-center justify-between rounded-md px-1.5 py-1 text-left ${
                      activeCidr === layer.cidr ? 'bg-[var(--color-bg-muted)]' : 'hover:bg-[var(--color-bg-muted)]'
                    }`}
                  >
                    <span className="font-mono text-[11px]">{layer.cidr}</span>
                    <span className="text-[10px] text-[var(--color-fg-subtle)]">{layer.count}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <button
          type="button"
          title={t('networkMap.trayShow')}
          onClick={() => onOpenChange(true)}
          className="flex min-h-0 flex-1 items-start justify-center px-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)] hover:bg-[var(--color-bg-muted)]"
        >
          <span className="select-none" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
            {t('networkMap.tray')}
          </span>
        </button>
      )}
    </aside>
  )
}
