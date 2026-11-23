import type { FloorIconKind } from '../../api'

export function EquipmentGlyph({ kind }: { kind: FloorIconKind }) {
  if (kind === 'text') return null
  if (kind === 'pc') {
    return (
      <>
        <rect x="-14" y="-11" width="28" height="17" rx="2.2" fill="white" />
        <rect x="-11.5" y="-8.5" width="23" height="12" rx="1.2" fill="rgba(15,23,42,0.18)" />
        <rect x="-3.5" y="7.5" width="7" height="2.8" rx="0.8" fill="white" />
        <rect x="-9.5" y="11" width="19" height="2.6" rx="1.2" fill="rgba(255,255,255,0.88)" />
      </>
    )
  }
  if (kind === 'server') {
    return (
      <>
        <rect x="-12" y="-16" width="24" height="32" rx="2.5" fill="white" />
        <rect x="-8.5" y="-11.5" width="17" height="5.5" rx="1.2" fill="rgba(15,23,42,0.22)" />
        <rect x="-8.5" y="-3.5" width="17" height="5.5" rx="1.2" fill="rgba(15,23,42,0.22)" />
        <rect x="-8.5" y="4.5" width="17" height="5.5" rx="1.2" fill="rgba(15,23,42,0.22)" />
        <circle cx="6.2" cy="-8.8" r="1.35" fill="rgb(34,197,94)" />
        <circle cx="6.2" cy="-0.8" r="1.35" fill="rgb(34,197,94)" />
        <circle cx="6.2" cy="7.2" r="1.35" fill="rgba(15,23,42,0.35)" />
      </>
    )
  }
  if (kind === 'ap') {
    return (
      <>
        <g transform="translate(0 -0.5)">
          <path
            d="M -11 -3.2 Q 0 -11.2 11 -3.2"
            fill="none"
            stroke="white"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
          <path
            d="M -7.2 -0.6 Q 0 -5.8 7.2 -0.6"
            fill="none"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            opacity="0.95"
          />
          <path
            d="M -3.4 1.8 Q 0 -0.8 3.4 1.8"
            fill="none"
            stroke="white"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
          <circle cx="0" cy="5" r="2" fill="white" />
        </g>
      </>
    )
  }
  if (kind === 'printer') {
    return (
      <>
        <rect x="-11" y="-15" width="22" height="8" rx="1.8" fill="rgba(255,255,255,0.78)" />
        <rect x="-15.5" y="-8" width="31" height="18" rx="3.2" fill="white" />
        <rect x="-10" y="-3.5" width="20" height="7.5" rx="1.4" fill="rgba(15,23,42,0.16)" />
        <rect x="-12.5" y="11" width="25" height="4" rx="1.2" fill="rgba(255,255,255,0.9)" />
        <circle cx="10.5" cy="-2.5" r="1.4" fill="rgba(15,23,42,0.32)" />
      </>
    )
  }
  if (kind === 'ethernet_outlet') {
    return (
      <>
        <rect x="-6.8" y="-5.4" width="13.6" height="11" rx="1.6" fill="white" />
        <rect x="-4.2" y="-2.2" width="8.4" height="4.2" rx="0.6" fill="rgba(15,23,42,0.38)" />
        <rect x="-2.6" y="-4" width="5.2" height="1.6" rx="0.35" fill="rgba(15,23,42,0.22)" />
        <rect x="-3.4" y="2.4" width="1.4" height="1.6" rx="0.25" fill="rgba(15,23,42,0.28)" />
        <rect x="-0.7" y="2.4" width="1.4" height="1.6" rx="0.25" fill="rgba(15,23,42,0.28)" />
        <rect x="2" y="2.4" width="1.4" height="1.6" rx="0.25" fill="rgba(15,23,42,0.28)" />
      </>
    )
  }
  if (kind === 'phone_outlet') {
    return (
      <>
        <rect x="-5.8" y="-7" width="11.6" height="14" rx="2.2" fill="white" />
        <circle cx="0" cy="0.4" r="2.5" fill="rgba(15,23,42,0.32)" />
        <rect x="-1" y="-4.2" width="2" height="2.8" rx="0.5" fill="rgba(255,255,255,0.95)" />
        <path
          d="M -2.8 4.2 Q 0 6.2 2.8 4.2"
          fill="none"
          stroke="rgba(15,23,42,0.28)"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      </>
    )
  }
  if (kind === 'switch') {
    return (
      <>
        <rect x="-16.5" y="-9.5" width="33" height="19" rx="3.2" fill="white" />
        <rect x="-12.5" y="-4" width="3.6" height="7.2" rx="0.8" fill="rgba(15,23,42,0.36)" />
        <rect x="-6.5" y="-4" width="3.6" height="7.2" rx="0.8" fill="rgba(15,23,42,0.36)" />
        <rect x="-0.5" y="-4" width="3.6" height="7.2" rx="0.8" fill="rgba(15,23,42,0.36)" />
        <rect x="5.5" y="-4" width="3.6" height="7.2" rx="0.8" fill="rgba(15,23,42,0.36)" />
        <circle cx="-10.7" cy="-6.6" r="1" fill="rgb(34,197,94)" />
        <circle cx="-4.7" cy="-6.6" r="1" fill="rgb(34,197,94)" />
        <circle cx="1.3" cy="-6.6" r="1" fill="rgba(15,23,42,0.28)" />
        <circle cx="7.3" cy="-6.6" r="1" fill="rgb(34,197,94)" />
      </>
    )
  }
  return (
    <>
      <rect x="-17" y="-10.5" width="34" height="21" rx="4" fill="white" />
      <rect x="-10" y="-3" width="20" height="6" rx="2.5" fill="rgba(15,23,42,0.32)" />
    </>
  )
}

export function EquipmentMenuIcon({ kind }: { kind: FloorIconKind }) {
  return (
    <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]">
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
        {kind === 'pc' ? (
          <>
            <rect x="3.5" y="4" width="17" height="11.5" rx="1.8" />
            <path d="M10 15.5v2.8M14 15.5v2.8" />
            <path d="M7.5 19.5h9" />
          </>
        ) : kind === 'server' ? (
          <>
            <rect x="5.5" y="3" width="13" height="18" rx="2" />
            <path d="M8.5 7.5h7M8.5 12h7M8.5 16.5h7" />
            <circle cx="16" cy="7.5" r="0.9" fill="currentColor" stroke="none" />
            <circle cx="16" cy="12" r="0.9" fill="currentColor" stroke="none" />
          </>
        ) : kind === 'ap' ? (
          <>
            <path d="M3.5 10Q12 2.2 20.5 10" />
            <path d="M6.5 13.2Q12 7.5 17.5 13.2" />
            <path d="M9.5 16Q12 13.5 14.5 16" />
            <circle cx="12" cy="19" r="1.35" fill="currentColor" stroke="none" />
          </>
        ) : kind === 'switch' ? (
          <>
            <rect x="3" y="6.5" width="18" height="11" rx="2.2" />
            <path d="M6.5 10.5h1.6M10.2 10.5h1.6M13.9 10.5h1.6M17.6 10.5h1.2" />
            <path d="M6.5 14h1.6M10.2 14h1.6M13.9 14h1.6M17.6 14h1.2" />
          </>
        ) : kind === 'printer' ? (
          <>
            <path d="M7.5 8.5V4.5h9v4" />
            <rect x="4" y="8.5" width="16" height="9" rx="2" />
            <path d="M8 13.5h8" />
            <path d="M7.5 17.5h9" />
          </>
        ) : kind === 'ethernet_outlet' ? (
          <>
            <rect x="5.5" y="6" width="13" height="12" rx="2" />
            <rect x="8.2" y="9.2" width="7.6" height="4.2" rx="0.9" />
            <path d="M9.5 15.2v1.3M12 15.2v1.3M14.5 15.2v1.3" />
          </>
        ) : kind === 'phone_outlet' ? (
          <>
            <rect x="7" y="4.5" width="10" height="15" rx="2.4" />
            <circle cx="12" cy="12" r="2.4" />
            <path d="M11.2 8.2h1.6" />
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
