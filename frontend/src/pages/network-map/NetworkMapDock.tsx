import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useT, type MessageKey } from '../../i18n/LocaleContext'
import { NetworkMapGlyph } from './NetworkMapGlyph'
import { NETWORK_MAP_DND, type NetworkMapStencil, type PaletteDrag } from './types'

type Props = {
  onPick: (payload: PaletteDrag) => void
  onImportImage?: (file: File) => void
  onCableTool?: () => void
  cableActive?: boolean
}

type DockCat = 'link' | 'network' | 'end' | 'mark'

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
      className={`flex h-[4.1rem] w-[4.1rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-md ${
        active
          ? 'bg-[var(--color-primary-muted)] ring-1 ring-[var(--color-primary)]'
          : 'hover:bg-[var(--color-bg-muted)]'
      }`}
    >
      {children}
      <span className="max-w-full truncate px-0.5 text-[10px] leading-none text-[var(--color-fg-muted)]">
        {label}
      </span>
    </button>
  )
}

const NETWORK: NetworkMapStencil[] = ['switch', 'router', 'firewall', 'ap']
const ENDPOINTS: NetworkMapStencil[] = ['pc', 'server', 'nas', 'printer', 'vm', 'corax']

export function NetworkMapDock({ onPick, onImportImage, onCableTool, cableActive }: Props) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement>(null)
  const [cat, setCat] = useState<DockCat>('network')

  return (
    <div className="network-map-dock flex shrink-0 items-stretch gap-2 overflow-x-auto border-t px-2 py-1">
      <div className="flex items-center gap-0.5">
        {(
          [
            ['link', t('networkMap.dockLink'), 'cable'],
            ['network', t('networkMap.dockNetwork'), 'switch'],
            ['end', t('networkMap.dockEnd'), 'pc'],
            ['mark', t('networkMap.dockMark'), 'note'],
          ] as const
        ).map(([id, label, glyph]) => (
          <button
            key={id}
            type="button"
            title={label}
            onClick={() => setCat(id)}
            className={`network-map-dock-cat flex h-[4.1rem] flex-col items-center justify-center gap-0.5 rounded-md px-1 ${
              cat === id ? 'is-active' : 'hover:bg-[var(--color-bg-muted)]'
            }`}
          >
            <NetworkMapGlyph kind={glyph} size="md" active={cat === id} />
            <span className="text-[10px] leading-none text-[var(--color-fg-muted)]">{label}</span>
          </button>
        ))}
      </div>
      <div className="my-1 w-px shrink-0 bg-[var(--color-border)]" />
      <div className="flex items-center gap-0.5">
        {cat === 'link' ? (
          <DockButton label={t('networkMap.cableTool')} onClick={() => onCableTool?.()} active={cableActive}>
            <NetworkMapGlyph kind="cable" size="md" active={cableActive} />
          </DockButton>
        ) : null}
        {cat === 'network' || cat === 'end'
          ? (cat === 'network' ? NETWORK : ENDPOINTS).map((stencil) => (
              <DockButton
                key={stencil}
                label={t(`networkMap.stencil.${stencil}` as MessageKey)}
                onClick={() => onPick({ kind: 'stencil', stencil })}
                onDragStart={(e) => dragPayload(e, { kind: 'stencil', stencil })}
              >
                <NetworkMapGlyph kind={stencil} size="md" />
              </DockButton>
            ))
          : null}
        {cat === 'mark' ? (
          <>
            <DockButton
              label={t('networkMap.stencil.cloud')}
              onClick={() => onPick({ kind: 'stencil', stencil: 'cloud' })}
              onDragStart={(e) => dragPayload(e, { kind: 'stencil', stencil: 'cloud' })}
            >
              <NetworkMapGlyph kind="cloud" size="md" />
            </DockButton>
            <DockButton
              label={t('networkMap.stencil.note')}
              onClick={() => onPick({ kind: 'stencil', stencil: 'note' as NetworkMapStencil })}
              onDragStart={(e) => dragPayload(e, { kind: 'stencil', stencil: 'note' })}
            >
              <NetworkMapGlyph kind="note" size="md" />
            </DockButton>
            <DockButton label={t('networkMap.stencil.image')} onClick={() => fileRef.current?.click()}>
              <NetworkMapGlyph kind="image" size="md" />
            </DockButton>
            {(['room', 'rack'] as const).map((kind) => (
              <DockButton
                key={kind}
                label={kind === 'room' ? t('networkMap.addRoom') : t('networkMap.addRack')}
                onClick={() => onPick({ kind: 'group', groupKind: kind })}
                onDragStart={(e) => dragPayload(e, { kind: 'group', groupKind: kind })}
              >
                <NetworkMapGlyph kind={kind} size="md" />
              </DockButton>
            ))}
          </>
        ) : null}
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
    </div>
  )
}
