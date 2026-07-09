/**
 * Иконки: мягкий duotone (лёгкая заливка + обводка), единая толщина и скругления.
 * Цвет задаётся классом на родителе (text-blue-600, text-neutral-500 и т.д.).
 */

type Props = { className?: string; title?: string }

// Slightly thinner strokes for a more minimalist UI.
const sw = 1.35

const s = {
  stroke: 'currentColor' as const,
  strokeWidth: sw,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fill: 'none' as const,
}

// Softer duotone fill (less "heavy" in nav/sidebar).
const soft = { fill: 'currentColor' as const, fillOpacity: 0.08, stroke: 'none' as const }

export function IconLogo({ className, title }: Props) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden={!title}
      role={title ? 'img' : 'presentation'}
    >
      {title ? <title>{title}</title> : null}
      <path
        d="M12 3.25 18.75 7v6.5L12 20.75 5.25 13.5V7L12 3.25z"
        {...soft}
      />
      <path d="M12 3.25 18.75 7v6.5L12 20.75 5.25 13.5V7L12 3.25z" {...s} />
      <path d="M12 7.25v9.5M8.1 9.35l7.8 4.5M15.9 9.35l-7.8 4.5" {...s} strokeWidth={sw * 0.9} opacity={0.55} />
      <circle cx="12" cy="12" r="2.35" fill="currentColor" fillOpacity={0.22} stroke="none" />
      <circle cx="12" cy="12" r="1.15" fill="currentColor" fillOpacity={0.9} stroke="none" />
      <circle cx="5.25" cy="7" r="1.05" fill="currentColor" fillOpacity={0.45} stroke="none" />
      <circle cx="18.75" cy="7" r="1.05" fill="currentColor" fillOpacity={0.45} stroke="none" />
      <circle cx="12" cy="20.75" r="1.05" fill="currentColor" fillOpacity={0.45} stroke="none" />
    </svg>
  )
}

export function IconDashboard({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path
        d="M4.5 18.5v-1.5a1 1 0 0 1 1-1h1.5a1 1 0 0 1 1 1v2.5h-3.5a1 1 0 0 1-1-1zM9.5 18.5v-5a1 1 0 0 1 1-1H12a1 1 0 0 1 1 1v7h-2.5a1 1 0 0 1-1-1zM14.5 18.5V8a1 1 0 0 1 1-1h1.5a1 1 0 0 1 1 1v11.5h-3.5a1 1 0 0 1-1-1z"
        {...soft}
      />
      <path
        d="M4.5 18.5v-1.5a1 1 0 0 1 1-1h1.5a1 1 0 0 1 1 1v2.5M9.5 18.5v-5a1 1 0 0 1 1-1H12a1 1 0 0 1 1 1v7M14.5 18.5V8a1 1 0 0 1 1-1h1.5a1 1 0 0 1 1 1v11.5"
        {...s}
      />
    </svg>
  )
}

export function IconTag({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M4.25 5.75h5.82l9.68 8.75-6.46 6.46L4.25 12.21V5.75z" {...soft} />
      <path d="M4.25 5.75h5.82l9.68 8.75-6.46 6.46L4.25 12.21V5.75z" {...s} />
      <circle cx="7.85" cy="9.1" r="1.35" fill="currentColor" fillOpacity={0.35} stroke="none" />
    </svg>
  )
}

export function IconSoftware({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path
        d="M6 6.75h12A2.25 2.25 0 0 1 20.25 9v6A2.25 2.25 0 0 1 18 17.25H6A2.25 2.25 0 0 1 3.75 15V9A2.25 2.25 0 0 1 6 6.75z"
        {...soft}
      />
      <path d="M6 6.75h12A2.25 2.25 0 0 1 20.25 9v6A2.25 2.25 0 0 1 18 17.25H6A2.25 2.25 0 0 1 3.75 15V9A2.25 2.25 0 0 1 6 6.75z" {...s} />
      <path d="M9 19h6" {...s} strokeWidth={sw * 0.9} />
      <path d="M12 17v2" {...s} strokeWidth={sw * 0.9} />
      <path d="M8.5 11h7M8.5 13h4.5" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" opacity={0.88} />
    </svg>
  )
}

export function IconPcs({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M5 5.5h14a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2z" {...soft} />
      <rect x="4" y="5.5" width="16" height="11.5" rx="2" {...s} />
      <path d="M9 19.5h6" {...s} />
      <path d="M12 16.5v3" {...s} strokeWidth={sw * 0.85} />
      <path d="M9 9.5h6" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" opacity={0.75} />
    </svg>
  )
}

export function IconUsers({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M16 20v-2a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18v2" {...soft} />
      <circle cx="9" cy="8.25" r="3.25" {...soft} />
      <path d="M16 20v-2a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18v2" {...s} />
      <circle cx="9" cy="8.25" r="3.25" {...s} />
      <path d="M21 20v-1.5a4 4 0 0 0-2.9-3.85" {...s} />
      <path d="M17.35 7.75a3 3 0 0 1 0 5.66" {...s} />
    </svg>
  )
}

export function IconMenu({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M4.5 7.5h15M4.5 12h15M4.5 16.5h15" {...s} />
    </svg>
  )
}

export function IconLogout({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M10.5 6.75H6a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h4.5" {...soft} />
      <path d="M10.5 6.75H6a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h4.5" {...s} />
      <path d="M15.75 12H9.75M19.75 12l-3.25-3.25M19.75 12l-3.25 3.25" {...s} />
    </svg>
  )
}

export function IconClose({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="12" r="9" {...soft} />
      <path d="M9 9l6 6M15 9l-6 6" {...s} />
    </svg>
  )
}

/** Узнаваемая корзина (контур: ручка, объём, полоски) — без лишней заливки. */
export function IconTrash({ className, title }: Props) {
  const w = 1.7
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden={!title}
      role={title ? 'img' : 'presentation'}
    >
      {title ? <title>{title}</title> : null}
      <path d="M3 6h18" stroke="currentColor" strokeWidth={w} strokeLinecap="round" />
      <path
        d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"
        stroke="currentColor"
        strokeWidth={w}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"
        stroke="currentColor"
        strokeWidth={w}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth={w} strokeLinecap="round" />
    </svg>
  )
}

export function IconKey({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <circle cx="8.25" cy="8.25" r="3.75" {...soft} />
      <circle cx="8.25" cy="8.25" r="3.75" {...s} />
      <path d="M11.5 11.5 20 19" {...s} />
      <path d="M17 17h2.5M18.25 15.5v3" {...s} strokeWidth={sw * 0.9} />
    </svg>
  )
}

export function IconTicket({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path
        d="M5 8.5h14a1.5 1.5 0 0 1 1.5 1.5v2a2 2 0 0 0 0 4v2a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18v-2a2 2 0 0 0 0-4v-2A1.5 1.5 0 0 1 5 8.5Z"
        {...soft}
      />
      <path
        d="M5 8.5h14a1.5 1.5 0 0 1 1.5 1.5v2a2 2 0 0 0 0 4v2a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18v-2a2 2 0 0 0 0-4v-2A1.5 1.5 0 0 1 5 8.5Z"
        {...s}
      />
      <path d="M8 12.5h8" {...s} strokeWidth={sw * 0.85} opacity={0.85} />
    </svg>
  )
}

export function IconBook({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path
        d="M6.5 5.75h4.25a2.25 2.25 0 0 1 2.25 2.25V18.5H6.5a1.75 1.75 0 0 0-1.75 1.75V7.5A1.75 1.75 0 0 1 6.5 5.75zM13 8h4.5a1.75 1.75 0 0 1 1.75 1.75v10.5H13V8z"
        {...soft}
      />
      <path
        d="M6.5 5.75h4.25a2.25 2.25 0 0 1 2.25 2.25V18.5M13 8h4.5a1.75 1.75 0 0 1 1.75 1.75v10.5H13V8M6.5 18.5H4.75A1.75 1.75 0 0 1 3 16.75V7.5A1.75 1.75 0 0 1 4.75 5.75H6.5"
        {...s}
      />
      <path d="M13 8V5.75A1.75 1.75 0 0 1 14.75 4h4.5A1.75 1.75 0 0 1 21 5.75v11A1.75 1.75 0 0 1 19.25 18.5H13" {...s} strokeWidth={sw * 0.9} opacity={0.85} />
    </svg>
  )
}

export function IconGraph({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path
        d="M6.25 7.75a2.25 2.25 0 1 1 4.5 0 2.25 2.25 0 0 1-4.5 0ZM13.25 6.75a2.25 2.25 0 1 1 4.5 0 2.25 2.25 0 0 1-4.5 0ZM13.25 16.75a2.25 2.25 0 1 1 4.5 0 2.25 2.25 0 0 1-4.5 0Z"
        {...soft}
      />
      <circle cx="8.5" cy="7.75" r="2.25" {...s} />
      <circle cx="15.5" cy="6.75" r="2.25" {...s} />
      <circle cx="15.5" cy="16.75" r="2.25" {...s} />
      <path d="M10.65 7.3l2.75-0.8M10.35 8.55l2.95 6.85" {...s} strokeWidth={sw * 0.9} opacity={0.9} />
    </svg>
  )
}

export function IconWarehouse({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path
        d="M3.5 10.5 12 5.5l8.5 5v8.25A1.25 1.25 0 0 1 19.25 20.5H4.75A1.25 1.25 0 0 1 3.5 19.25V10.5Z"
        {...soft}
      />
      <path d="M3.5 10.5 12 5.5l8.5 5M12 5.5v15" {...s} />
      <path d="M8.25 13.5h2.5v4.25H8.25V13.5Zm5 0H16v4.25h-2.75V13.5Z" {...s} opacity={0.85} />
    </svg>
  )
}

export function IconPrinter({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path
        d="M6.5 8.25h11A2.25 2.25 0 0 1 19.75 10.5v5.5A2.25 2.25 0 0 1 17.5 18.25H6.5A2.25 2.25 0 0 1 4.25 16V10.5A2.25 2.25 0 0 1 6.5 8.25Z"
        {...soft}
      />
      <path
        d="M6.5 8.25h11A2.25 2.25 0 0 1 19.75 10.5v5.5A2.25 2.25 0 0 1 17.5 18.25H6.5A2.25 2.25 0 0 1 4.25 16V10.5A2.25 2.25 0 0 1 6.5 8.25Z"
        {...s}
      />
      <path d="M7.5 5.75h9v2.5H7.5V5.75Z" {...s} />
      <path d="M7.5 18.25V20h9v-1.75" {...s} />
      <path d="M17.75 12.5h1.5" {...s} strokeWidth={sw * 0.9} />
    </svg>
  )
}

export function IconDisk({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <ellipse cx="12" cy="12" rx="8.5" ry="3.25" {...soft} />
      <ellipse cx="12" cy="12" rx="8.5" ry="3.25" {...s} />
      <path d="M3.5 12v5.25c0 1.79 3.81 3.25 8.5 3.25s8.5-1.46 8.5-3.25V12" {...s} />
      <ellipse cx="12" cy="17.25" rx="8.5" ry="3.25" {...s} />
      <circle cx="12" cy="12" r="2.1" {...s} strokeWidth={sw * 0.9} />
    </svg>
  )
}

export function IconPencil({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M4.5 19.5h3.6l10-10a2 2 0 0 0 0-2.8l-0.8-0.8a2 2 0 0 0-2.8 0l-10 10V19.5z" {...soft} />
      <path d="M4.5 19.5h3.6l10-10a2 2 0 0 0 0-2.8l-0.8-0.8a2 2 0 0 0-2.8 0l-10 10V19.5z" {...s} />
      <path d="M13.25 6.75l4 4" {...s} opacity={0.85} />
      <path d="M4.5 19.5H20" {...s} strokeWidth={sw * 0.9} opacity={0.7} />
    </svg>
  )
}

export function IconLock({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <rect x="5.5" y="10.5" width="13" height="10" rx="2" {...soft} />
      <rect x="5.5" y="10.5" width="13" height="10" rx="2" {...s} />
      <path d="M8.75 10.5V8a3.25 3.25 0 0 1 6.5 0v2.5" {...s} />
    </svg>
  )
}
