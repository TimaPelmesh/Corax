import { useRef, type DragEvent, type ReactNode } from 'react'
import {
  IconAccessPoint,
  IconCable,
  IconCloud,
  IconFirewall,
  IconImage,
  IconNetworkMap,
  IconPcs,
  IconPencil,
  IconPrinter,
  IconRouter,
  IconServer,
  IconSwitch,
  IconVm,
  IconWarehouse,
} from '../../components/icons'
import { useT, type MessageKey } from '../../i18n/LocaleContext'
import { NETWORK_MAP_DND, STENCILS, type NetworkMapStencil, type PaletteDrag } from './types'

const STENCIL_ICON: Record<(typeof STENCILS)[number], typeof IconSwitch> = {
  switch: IconSwitch,
  router: IconRouter,
  firewall: IconFirewall,
  ap: IconAccessPoint,
  server: IconServer,
  corax: IconNetworkMap,
  nas: IconWarehouse,
  pc: IconPcs,
  vm: IconVm,
  printer: IconPrinter,
  cloud: IconCloud,
}

type Props = {
  onPick: (payload: PaletteDrag) => void
  onImportImage?: (file: File) => void
  onCableTool?: () => void
  cableActive?: boolean
}

function dragPayload(e: DragEvent, payload: PaletteDrag) {
  e.dataTransfer.setData(NETWORK_MAP_DND, JSON.stringify(payload))
  e.dataTransfer.setData('text/plain', JSON.stringify(payload))
  e.dataTransfer.effectAllowed = 'copy'
}

function DockButton({
  label,
  onClick,
  onDragStart,
  active,
  children,
}: {
  label: string
  onClick: () => void
  onDragStart?: (e: DragEvent) => void
  active?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      draggable={Boolean(onDragStart)}
      onClick={onClick}
      onDragStart={onDragStart}
      className={`flex h-[3.35rem] w-[3.35rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-md ${
        active
          ? 'bg-[var(--color-fg)] text-[var(--color-surface)]'
          : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]'
      }`}
    >
      {children}
      <span className="max-w-full truncate px-0.5 text-[9px] leading-none tracking-wide">{label}</span>
    </button>
  )
}

export function NetworkMapDock({ onPick, onImportImage, onCableTool, cableActive }: Props) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <div className="network-map-dock flex shrink-0 items-stretch gap-2 overflow-x-auto border-t border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5">
      <div className="flex items-center gap-0.5">
        <DockButton label={t('networkMap.cableTool')} onClick={() => onCableTool?.()} active={cableActive}>
          <IconCable className="h-5 w-5" />
        </DockButton>
      </div>
      <div className="my-1 w-px shrink-0 bg-[var(--color-border)]" />
      <div className="flex items-center gap-0.5">
        {STENCILS.map((stencil) => {
          const Icon = STENCIL_ICON[stencil]
          return (
            <DockButton
              key={stencil}
              label={t(`networkMap.stencil.${stencil}` as MessageKey)}
              onClick={() => onPick({ kind: 'stencil', stencil })}
              onDragStart={(e) => dragPayload(e, { kind: 'stencil', stencil })}
            >
              <Icon className="h-5 w-5" />
            </DockButton>
          )
        })}
      </div>
      <div className="my-1 w-px shrink-0 bg-[var(--color-border)]" />
      <div className="flex items-center gap-0.5">
        <DockButton
          label={t('networkMap.stencil.note')}
          onClick={() => onPick({ kind: 'stencil', stencil: 'note' as NetworkMapStencil })}
          onDragStart={(e) => dragPayload(e, { kind: 'stencil', stencil: 'note' })}
        >
          <IconPencil className="h-5 w-5" />
        </DockButton>
        <DockButton label={t('networkMap.stencil.image')} onClick={() => fileRef.current?.click()}>
          <IconImage className="h-5 w-5" />
        </DockButton>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) onImportImage?.(file)
          }}
        />
      </div>
      <div className="my-1 w-px shrink-0 bg-[var(--color-border)]" />
      <div className="flex items-center gap-0.5">
        {(['room', 'rack'] as const).map((kind) => (
          <DockButton
            key={kind}
            label={kind === 'room' ? t('networkMap.addRoom') : t('networkMap.addRack')}
            onClick={() => onPick({ kind: 'group', groupKind: kind })}
            onDragStart={(e) => dragPayload(e, { kind: 'group', groupKind: kind })}
          >
            <span className="flex h-5 w-5 items-center justify-center rounded border border-dashed border-current text-[10px] leading-none">
              {kind === 'room' ? '□' : '▣'}
            </span>
          </DockButton>
        ))}
      </div>
    </div>
  )
}
