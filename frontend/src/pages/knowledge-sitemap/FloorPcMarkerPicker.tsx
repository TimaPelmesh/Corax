import { useEffect, useMemo, useRef, useState } from 'react'
import type { Computer, FloorIconMarker } from '../../api'
import { useT } from '../../i18n/LocaleContext'
import { floorPcMarkerCaption, floorPcMarkerSearchText } from './floorTools'

export function FloorPcMarkerPicker({
  pcMarkers,
  valueId,
  onChange,
  pcDirectory,
  disabled,
}: {
  pcMarkers: FloorIconMarker[]
  valueId: string
  onChange: (id: string) => void
  pcDirectory: Computer[]
  disabled?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  const selected = useMemo(
    () => (valueId ? pcMarkers.find((m) => m.id === valueId) : undefined),
    [pcMarkers, valueId],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return pcMarkers.slice(0, 40)
    return pcMarkers.filter((m) => floorPcMarkerSearchText(m, pcDirectory).includes(q)).slice(0, 40)
  }, [pcMarkers, pcDirectory, query])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const displayValue = open
    ? query
    : selected
      ? floorPcMarkerCaption(selected, pcDirectory).primary
      : ''

  return (
    <div ref={boxRef} className="relative mt-0.5">
      <div className="relative">
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          placeholder={t('sitemap.markerSearchPlaceholder')}
          value={displayValue}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value)
            onChange('')
            setOpen(true)
          }}
          onFocus={() => {
            setQuery(selected ? floorPcMarkerCaption(selected, pcDirectory).primary : '')
            setOpen(true)
          }}
          className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-2.5 pr-14 text-sm text-[var(--color-fg)] outline-none transition placeholder:text-[var(--color-fg-subtle)] focus:border-neutral-400 disabled:opacity-60"
        />
        {selected && !disabled ? (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 text-[11px] font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
            onClick={() => {
              onChange('')
              setQuery('')
              setOpen(false)
            }}
          >
            Сброс
          </button>
        ) : null}
      </div>
      {open && !disabled ? (
        <ul
          className="absolute z-30 mt-1 max-h-52 w-full overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[0_12px_32px_-12px_rgba(2,6,23,0.35)]"
          role="listbox"
        >
          <li>
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
              onClick={() => {
                onChange('')
                setQuery('')
                setOpen(false)
              }}
            >
              — не подключено —
            </button>
          </li>
          {filtered.map((pc) => {
            const cap = floorPcMarkerCaption(pc, pcDirectory)
            return (
              <li key={pc.id}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left hover:bg-[var(--color-surface-muted)]"
                  onClick={() => {
                    onChange(pc.id)
                    setQuery(cap.primary)
                    setOpen(false)
                  }}
                >
                  <div className="text-sm font-medium text-[var(--color-fg)]">{cap.primary}</div>
                  {cap.secondary ? <div className="text-xs text-[var(--color-fg-muted)]">{cap.secondary}</div> : null}
                </button>
              </li>
            )
          })}
          {pcMarkers.length === 0 ? (
            <li className="px-3 py-2 text-sm text-[var(--color-fg-subtle)]">На этаже нет объектов «ПК»</li>
          ) : filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-[var(--color-fg-subtle)]">Ничего не найдено</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
