import type { FloorIconKind } from '../../api'

export function EquipmentGlyph({ kind }: { kind: FloorIconKind }) {
  if (kind === 'text') return null
  if (kind === 'pc') {
    return (
      <>
        <rect x="-13" y="-10" width="26" height="16" rx="2.5" fill="white" />
        <rect x="-6" y="8" width="12" height="3" rx="1.5" fill="rgba(255,255,255,0.86)" />
        <rect x="-10" y="11.5" width="20" height="3" rx="1.5" fill="rgba(255,255,255,0.72)" />
      </>
    )
  }
  if (kind === 'server') {
    return (
      <>
        <rect x="-12" y="-16" width="24" height="32" rx="3" fill="white" />
        <rect x="-7" y="-10" width="14" height="3" rx="1.5" fill="rgba(15,23,42,0.45)" />
        <rect x="-7" y="-2" width="14" height="3" rx="1.5" fill="rgba(15,23,42,0.45)" />
        <circle cx="7" cy="9" r="2" fill="rgb(34,197,94)" />
      </>
    )
  }
  if (kind === 'ap') {
    return (
      <>
        <g transform="translate(0 -0.8)">
          <path
            d="M -10.2 -2.7 Q 0 -10.2 10.2 -2.7"
            fill="none"
            stroke="white"
            strokeWidth="2.05"
            strokeLinecap="round"
          />
          <path
            d="M -6.6 -0.4 Q 0 -5.1 6.6 -0.4"
            fill="none"
            stroke="white"
            strokeWidth="1.95"
            strokeLinecap="round"
            opacity="0.97"
          />
          <path
            d="M -3.2 1.8 Q 0 -0.5 3.2 1.8"
            fill="none"
            stroke="white"
            strokeWidth="1.85"
            strokeLinecap="round"
            opacity="0.98"
          />
          <circle cx="0" cy="4.8" r="1.7" fill="white" />
        </g>
      </>
    )
  }
  if (kind === 'printer') {
    return (
      <>
        <rect x="-13.5" y="-15.5" width="27" height="10" rx="2.6" fill="rgba(255,255,255,0.74)" />
        <rect x="-16.5" y="-7" width="33" height="22" rx="4.8" fill="white" />
        <rect x="-11" y="2.8" width="22" height="8.4" rx="1.8" fill="rgba(15,23,42,0.12)" />
        <circle cx="10.2" cy="-1.2" r="1.5" fill="rgba(15,23,42,0.35)" />
      </>
    )
  }
  if (kind === 'ethernet_outlet') {
    return (
      <>
        <rect x="-6.5" y="-4.9" width="13" height="10" rx="1.8" fill="white" />
        <rect x="-3.9" y="-1.8" width="7.8" height="3.5" rx="0.7" fill="rgba(15,23,42,0.35)" />
        <rect x="-2.1" y="-3.5" width="4.2" height="1.5" rx="0.4" fill="rgba(15,23,42,0.22)" />
      </>
    )
  }
  if (kind === 'phone_outlet') {
    return (
      <>
        <rect x="-5.6" y="-6.3" width="11.2" height="12.6" rx="2.1" fill="white" />
        <circle cx="0" cy="0" r="2.2" fill="rgba(15,23,42,0.35)" />
        <rect x="-0.85" y="-3.9" width="1.7" height="2.5" rx="0.4" fill="rgba(255,255,255,0.92)" />
      </>
    )
  }
  if (kind === 'switch') {
    return (
      <>
        <rect x="-16" y="-9" width="32" height="18" rx="3.5" fill="white" />
        <rect x="-11" y="-3.2" width="4" height="6.4" rx="1" fill="rgba(15,23,42,0.38)" />
        <rect x="-4.5" y="-3.2" width="4" height="6.4" rx="1" fill="rgba(15,23,42,0.38)" />
        <rect x="2" y="-3.2" width="4" height="6.4" rx="1" fill="rgba(15,23,42,0.38)" />
        <rect x="8.5" y="-3.2" width="4" height="6.4" rx="1" fill="rgba(15,23,42,0.38)" />
      </>
    )
  }
  return (
    <>
      <rect x="-18" y="-11" width="36" height="22" rx="5" fill="white" />
      <rect x="-11" y="-3" width="22" height="6" rx="3" fill="rgba(15,23,42,0.35)" />
    </>
  )
}

export function EquipmentMenuIcon({ kind }: { kind: FloorIconKind }) {
  return (
    <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]">
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        {kind === 'pc' ? (
          <>
            <rect x="3.5" y="4.5" width="17" height="11" rx="1.8" />
            <path d="M8 19h8" />
            <path d="M10 15.5v3.5M14 15.5v3.5" />
          </>
        ) : kind === 'server' ? (
          <>
            <rect x="5" y="3.5" width="14" height="17" rx="2" />
            <path d="M8 8h8M8 12h8" />
            <circle cx="16.5" cy="16.5" r="1.1" fill="currentColor" stroke="none" />
          </>
        ) : kind === 'ap' ? (
          <>
            <path d="M3.5 10.5Q12 2.5 20.5 10.5" />
            <path d="M6.5 13.5Q12 8 17.5 13.5" />
            <path d="M9.5 16.2Q12 13.8 14.5 16.2" />
            <circle cx="12" cy="19" r="1.3" fill="currentColor" stroke="none" />
          </>
        ) : kind === 'switch' ? (
          <>
            <rect x="3.5" y="7" width="17" height="10" rx="2" />
            <path d="M7 11h1M10 11h1M13 11h1M16 11h1" />
          </>
        ) : kind === 'printer' ? (
          <>
            <rect x="6.5" y="3.5" width="11" height="5" rx="1.5" />
            <rect x="4.5" y="9" width="15" height="9" rx="2" />
            <path d="M8 14.5h8" />
          </>
        ) : kind === 'ethernet_outlet' ? (
          <>
            <rect x="6" y="7" width="12" height="10" rx="2" />
            <rect x="8.5" y="10" width="7" height="4" rx="1" />
          </>
        ) : kind === 'phone_outlet' ? (
          <>
            <rect x="7" y="5" width="10" height="14" rx="2.5" />
            <circle cx="12" cy="12" r="2.2" />
          </>
        ) : (
          <>
            <path d="M6 8h12M6 12h12M6 16h8" />
          </>
        )}
      </svg>
    </span>
  )
}
