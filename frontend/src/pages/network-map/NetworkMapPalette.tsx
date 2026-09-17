import { useRef, useState } from 'react'
import {
  IconAccessPoint,
  IconCloud,
  IconFirewall,
  IconImage,
  IconPcs,
  IconPencil,
  IconPrinter,
  IconRouter,
  IconServer,
  IconSwitch,
  IconWarehouse,
} from '../../components/icons'
import { useT, type MessageKey } from '../../i18n/LocaleContext'
import { STENCILS, type NetworkMapStencil } from './types'

export const NETWORK_MAP_DND = 'application/corax-network-map'

export type PaletteDrag =
  | { kind: 'stencil'; stencil: NetworkMapStencil }
  | { kind: 'group'; groupKind: 'room' | 'rack' }

const STENCIL_ICON: Record<(typeof STENCILS)[number], typeof IconSwitch> = {
  switch: IconSwitch,
  router: IconRouter,
  firewall: IconFirewall,
  ap: IconAccessPoint,
  server: IconServer,
  nas: IconWarehouse,
  pc: IconPcs,
  printer: IconPrinter,
  cloud: IconCloud,
}

type Props = {
  canEdit: boolean
  onPick: (payload: PaletteDrag) => void
  onRequestBlank?: () => void
  onImportImage?: (file: File) => void
}

export function NetworkMapPalette({ canEdit, onPick, onRequestBlank, onImportImage }: Props) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="relative flex shrink-0 items-center gap-3 border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface)_92%,transparent)] px-3 py-2 backdrop-blur-md">
      <div className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
        {t('networkMap.stencils')}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {STENCILS.map((stencil) => {
          const Icon = STENCIL_ICON[stencil]
          return (
            <button
              key={stencil}
              type="button"
              draggable={canEdit}
              disabled={!canEdit}
              title={t(`networkMap.stencil.${stencil}` as MessageKey)}
              onClick={() => canEdit && onPick({ kind: 'stencil', stencil })}
              onDragStart={(e) => {
                const payload = JSON.stringify({ kind: 'stencil', stencil } satisfies PaletteDrag)
                e.dataTransfer.setData(NETWORK_MAP_DND, payload)
                e.dataTransfer.setData('text/plain', payload)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-fg)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
            >
              <Icon className="h-3.5 w-3.5" />
              {t(`networkMap.stencil.${stencil}` as MessageKey)}
            </button>
          )
        })}
        <button
          type="button"
          draggable={canEdit}
          disabled={!canEdit}
          title={t('networkMap.stencil.note')}
          onClick={() => canEdit && onPick({ kind: 'stencil', stencil: 'note' })}
          onDragStart={(e) => {
            const payload = JSON.stringify({ kind: 'stencil', stencil: 'note' } satisfies PaletteDrag)
            e.dataTransfer.setData(NETWORK_MAP_DND, payload)
            e.dataTransfer.setData('text/plain', payload)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-dashed border-[var(--color-border-strong)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
        >
          <IconPencil className="h-3.5 w-3.5" />
          {t('networkMap.stencil.note')}
        </button>
        <button
          type="button"
          disabled={!canEdit}
          title={t('networkMap.stencil.image')}
          onClick={() => canEdit && fileRef.current?.click()}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-dashed border-[var(--color-border-strong)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
        >
          <IconImage className="h-3.5 w-3.5" />
          {t('networkMap.stencil.image')}
        </button>
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
        {(['room', 'rack'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            draggable={canEdit}
            disabled={!canEdit}
            onClick={() => canEdit && onPick({ kind: 'group', groupKind: kind })}
            onDragStart={(e) => {
              const payload = JSON.stringify({ kind: 'group', groupKind: kind } satisfies PaletteDrag)
              e.dataTransfer.setData(NETWORK_MAP_DND, payload)
              e.dataTransfer.setData('text/plain', payload)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            className="flex shrink-0 items-center rounded-lg border border-dashed border-[var(--color-border-strong)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
          >
            {kind === 'room' ? t('networkMap.addRoom') : t('networkMap.addRack')}
          </button>
        ))}
      </div>
      {canEdit && onRequestBlank ? (
        <div className="relative shrink-0">
          <button
            type="button"
            aria-label={t('networkMap.blank')}
            onClick={() => setMenuOpen((open) => !open)}
            className="rounded-lg border border-[var(--color-border)] px-2 py-1.5 text-[11px] font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
          >
            ⋯
          </button>
          {menuOpen ? (
            <div className="absolute bottom-full right-0 z-20 mb-2 w-52 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[0_16px_40px_-24px_rgba(0,0,0,0.7)]">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  onRequestBlank()
                }}
                className="block w-full px-3 py-2 text-left text-xs text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)]"
              >
                {t('networkMap.blank')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
