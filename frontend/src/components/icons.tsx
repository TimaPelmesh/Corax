/**
 * Иконки в духе Windows Fluent: чуть плотнее заливка, толще обводка, узнаваемые силуэты.
 * Цвет — через className (text-*).
 */

type Props = { className?: string; title?: string }

const sw = 1.65

const s = {
  stroke: 'currentColor' as const,
  strokeWidth: sw,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fill: 'none' as const,
}

const soft = { fill: 'currentColor' as const, fillOpacity: 0.16, stroke: 'none' as const }

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
      <path d="M12 3.25 18.75 7v6.5L12 20.75 5.25 13.5V7L12 3.25z" {...soft} />
      <path d="M12 3.25 18.75 7v6.5L12 20.75 5.25 13.5V7L12 3.25z" {...s} />
      <path d="M12 7.25v9.5M8.1 9.35l7.8 4.5M15.9 9.35l-7.8 4.5" {...s} strokeWidth={sw * 0.85} opacity={0.55} />
      <circle cx="12" cy="12" r="2.35" fill="currentColor" fillOpacity={0.28} stroke="none" />
      <circle cx="12" cy="12" r="1.15" fill="currentColor" fillOpacity={0.95} stroke="none" />
    </svg>
  )
}

export function IconDashboard({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.75" {...soft} />
      <rect x="13" y="3.5" width="7.5" height="4.5" rx="1.5" {...soft} />
      <rect x="13" y="10.5" width="7.5" height="10" rx="1.75" {...soft} />
      <rect x="3.5" y="13.5" width="7.5" height="7" rx="1.75" {...soft} />
      <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.75" {...s} />
      <rect x="13" y="3.5" width="7.5" height="4.5" rx="1.5" {...s} />
      <rect x="13" y="10.5" width="7.5" height="10" rx="1.75" {...s} />
      <rect x="3.5" y="13.5" width="7.5" height="7" rx="1.75" {...s} />
    </svg>
  )
}

export function IconTag({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M3.75 5.5h6.2l10.3 9.05-5.55 5.55L3.75 12.15V5.5z" {...soft} />
      <path d="M3.75 5.5h6.2l10.3 9.05-5.55 5.55L3.75 12.15V5.5z" {...s} />
      <circle cx="7.6" cy="9.2" r="1.45" fill="currentColor" fillOpacity={0.45} stroke="none" />
    </svg>
  )
}

export function IconSoftware({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <rect x="3.5" y="5.5" width="17" height="11.5" rx="2.25" {...soft} />
      <rect x="3.5" y="5.5" width="17" height="11.5" rx="2.25" {...s} />
      <path d="M3.5 9h17" {...s} />
      <circle cx="6.25" cy="7.25" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="8.35" cy="7.25" r="0.7" fill="currentColor" fillOpacity={0.55} stroke="none" />
      <circle cx="10.45" cy="7.25" r="0.7" fill="currentColor" fillOpacity={0.35} stroke="none" />
      <path d="M8.5 12.25h7M8.5 14.75h4.5" {...s} strokeWidth={sw * 0.9} opacity={0.9} />
      <path d="M9 19.5h6M12 17v2.5" {...s} strokeWidth={sw * 0.9} />
    </svg>
  )
}

export function IconPcs({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <rect x="3.5" y="4" width="17" height="12" rx="2" {...soft} />
      <rect x="3.5" y="4" width="17" height="12" rx="2" {...s} />
      <path d="M3.5 13.5h17" {...s} />
      <path d="M9.5 19.5h5M12 16v3.5" {...s} />
      <path d="M7.5 8h4.5M7.5 10.25h7" {...s} strokeWidth={sw * 0.85} opacity={0.75} />
    </svg>
  )
}

export function IconUsers({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <circle cx="9" cy="8" r="3.4" {...soft} />
      <path d="M3.5 19.5v-1.4A4.6 4.6 0 0 1 8.1 13.5h1.8a4.6 4.6 0 0 1 4.6 4.6v1.4" {...soft} />
      <circle cx="9" cy="8" r="3.4" {...s} />
      <path d="M3.5 19.5v-1.4A4.6 4.6 0 0 1 8.1 13.5h1.8a4.6 4.6 0 0 1 4.6 4.6v1.4" {...s} />
      <circle cx="17.2" cy="9.2" r="2.55" {...s} />
      <path d="M20.5 19.5v-1.1a3.5 3.5 0 0 0-2.55-3.35" {...s} />
    </svg>
  )
}

export function IconMenu({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M4.25 7h15.5M4.25 12h15.5M4.25 17h15.5" {...s} />
    </svg>
  )
}

export function IconLogout({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M10.25 6.5H6.25A2.25 2.25 0 0 0 4 8.75v6.5A2.25 2.25 0 0 0 6.25 17.5h4" {...soft} />
      <path d="M10.25 6.5H6.25A2.25 2.25 0 0 0 4 8.75v6.5A2.25 2.25 0 0 0 6.25 17.5h4" {...s} />
      <path d="M15.5 12H9.75M19.5 12l-3.4-3.4M19.5 12l-3.4 3.4" {...s} />
    </svg>
  )
}

export function IconSun({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="12" r="4.4" {...soft} />
      <circle cx="12" cy="12" r="4.4" {...s} />
      <path d="M12 2.75v2.1M12 19.15v2.1M2.75 12h2.1M19.15 12h2.1M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M5.4 18.6l1.5-1.5M17.1 6.9l1.5-1.5" {...s} />
    </svg>
  )
}

export function IconMoon({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M15.1 3.9a7.5 7.5 0 1 0 5 13.1A6.4 6.4 0 0 1 15.1 3.9z" {...soft} />
      <path d="M15.1 3.9a7.5 7.5 0 1 0 5 13.1A6.4 6.4 0 0 1 15.1 3.9z" {...s} />
    </svg>
  )
}

export function IconSearch({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <circle cx="10.5" cy="10.5" r="5.75" {...soft} />
      <circle cx="10.5" cy="10.5" r="5.75" {...s} />
      <path d="M15.2 15.2L20 20" {...s} />
    </svg>
  )
}

export function IconBell({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path
        d="M12 3.75c-2.9 0-5.25 2.2-5.25 4.9v2.1c0 .85-.28 1.68-.8 2.35l-.85 1.1c-.55.7-.05 1.7.85 1.7h12.1c.9 0 1.4-1 .85-1.7l-.85-1.1a3.9 3.9 0 0 1-.8-2.35v-2.1c0-2.7-2.35-4.9-5.25-4.9z"
        {...soft}
      />
      <path
        d="M12 3.75c-2.9 0-5.25 2.2-5.25 4.9v2.1c0 .85-.28 1.68-.8 2.35l-.85 1.1c-.55.7-.05 1.7.85 1.7h12.1c.9 0 1.4-1 .85-1.7l-.85-1.1a3.9 3.9 0 0 1-.8-2.35v-2.1c0-2.7-2.35-4.9-5.25-4.9z"
        {...s}
      />
      <path d="M10.2 18.35a2 2 0 0 0 3.6 0" {...s} />
    </svg>
  )
}

export function IconClose({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="12" r="9.25" {...soft} />
      <path d="M8.75 8.75l6.5 6.5M15.25 8.75l-6.5 6.5" {...s} />
    </svg>
  )
}

/** Узнаваемая корзина (контур: ручка, объём, полоски) — без лишней заливки. */
export function IconTrash({ className, title }: Props) {
  const w = 1.75
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
      <circle cx="8" cy="8.25" r="4" {...soft} />
      <circle cx="8" cy="8.25" r="4" {...s} />
      <path d="M11.6 11.6 20.25 20.25" {...s} />
      <path d="M16.75 16.75h2.75M18.1 15.1v3.5" {...s} strokeWidth={sw * 0.9} />
    </svg>
  )
}

export function IconTicket({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path
        d="M4.5 7.75h15a1.75 1.75 0 0 1 1.75 1.75v1.6a2.1 2.1 0 0 0 0 4.2v1.6A1.75 1.75 0 0 1 19.5 18.65h-15A1.75 1.75 0 0 1 2.75 16.9v-1.6a2.1 2.1 0 0 0 0-4.2V9.5A1.75 1.75 0 0 1 4.5 7.75Z"
        {...soft}
      />
      <path
        d="M4.5 7.75h15a1.75 1.75 0 0 1 1.75 1.75v1.6a2.1 2.1 0 0 0 0 4.2v1.6A1.75 1.75 0 0 1 19.5 18.65h-15A1.75 1.75 0 0 1 2.75 16.9v-1.6a2.1 2.1 0 0 0 0-4.2V9.5A1.75 1.75 0 0 1 4.5 7.75Z"
        {...s}
      />
      <path d="M8 11.5v5" {...s} strokeWidth={sw * 0.9} opacity={0.85} strokeDasharray="2.2 2.4" />
    </svg>
  )
}

export function IconSignal({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="18" r="1.35" fill="currentColor" stroke="none" />
      <path d="M8.2 14.4a5.4 5.4 0 0 1 7.6 0" {...s} />
      <path d="M5.4 11.2a9.2 9.2 0 0 1 13.2 0" {...s} opacity={0.85} />
      <path d="M2.9 8.1a13 13 0 0 1 18.2 0" {...s} opacity={0.55} />
    </svg>
  )
}

export function IconSignalOff({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="18" r="1.35" fill="currentColor" stroke="none" />
      <path d="M8.2 14.4a5.4 5.4 0 0 1 7.6 0" {...s} opacity={0.45} />
      <path d="M5.4 11.2a9.2 9.2 0 0 1 13.2 0" {...s} opacity={0.35} />
      <path d="M4.5 5.25 19.5 19.5" {...s} />
    </svg>
  )
}

export function IconClock({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="12" r="8.25" {...soft} />
      <circle cx="12" cy="12" r="8.25" {...s} />
      <path d="M12 7.75v4.6l3.1 1.85" {...s} />
    </svg>
  )
}

export function IconCheckBadge({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="12" r="8.25" {...soft} />
      <circle cx="12" cy="12" r="8.25" {...s} />
      <path d="M8.4 12.15 11 14.7l4.7-5.2" {...s} />
    </svg>
  )
}

export function IconActivity({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.25" {...soft} />
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.25" {...s} />
      <path d="M6.5 13.25 9.1 10.4l2.3 2.5 3.2-4.15L17.5 12.2" {...s} />
    </svg>
  )
}

export function IconBook({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M5 4.75h6.25A2.5 2.5 0 0 1 13.75 7.25V19.5H5.75A1.75 1.75 0 0 1 4 17.75V6.5A1.75 1.75 0 0 1 5.75 4.75H5z" {...soft} />
      <path d="M13.75 7.25H18.5A1.75 1.75 0 0 1 20.25 9v10.5H13.75V7.25z" {...soft} />
      <path d="M12 5.25v14.25M5 4.75h6.25A2.5 2.5 0 0 1 13.75 7.25V19.5H5.75A1.75 1.75 0 0 1 4 17.75V6.5A1.75 1.75 0 0 1 5.75 4.75H5" {...s} />
      <path d="M13.75 7.25H18.5A1.75 1.75 0 0 1 20.25 9v10.5H13.75" {...s} />
      <path d="M16 11h2.5M16 13.5h2.5" {...s} strokeWidth={sw * 0.85} opacity={0.8} />
    </svg>
  )
}

export function IconGraph({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <circle cx="6.5" cy="8" r="2.6" {...soft} />
      <circle cx="17" cy="6.5" r="2.6" {...soft} />
      <circle cx="15.5" cy="16.5" r="2.6" {...soft} />
      <circle cx="6.5" cy="8" r="2.6" {...s} />
      <circle cx="17" cy="6.5" r="2.6" {...s} />
      <circle cx="15.5" cy="16.5" r="2.6" {...s} />
      <path d="M8.7 7.2 14.7 6.4M8.5 9.4l5.1 5.6" {...s} />
    </svg>
  )
}

export function IconWarehouse({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M3.25 10.75 12 4.75l8.75 6V19.5A1.75 1.75 0 0 1 19 21.25H5A1.75 1.75 0 0 1 3.25 19.5v-8.75Z" {...soft} />
      <path d="M3.25 10.75 12 4.75l8.75 6" {...s} />
      <path d="M5 21.25h14A1.75 1.75 0 0 0 20.75 19.5v-8" {...s} />
      <path d="M12 4.75v16.5" {...s} opacity={0.55} />
      <rect x="7" y="13.25" width="3.5" height="4.75" rx="0.6" {...s} />
      <rect x="13.5" y="13.25" width="3.5" height="4.75" rx="0.6" {...s} />
    </svg>
  )
}

export function IconPrinter({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      {/* корпус */}
      <path d="M6 9.25h12a2.5 2.5 0 0 1 2.5 2.5v5A1.75 1.75 0 0 1 18.75 18.5H5.25A1.75 1.75 0 0 1 3.5 16.75v-5A2.5 2.5 0 0 1 6 9.25Z" {...soft} />
      <path d="M6 9.25h12a2.5 2.5 0 0 1 2.5 2.5v5A1.75 1.75 0 0 1 18.75 18.5H5.25A1.75 1.75 0 0 1 3.5 16.75v-5A2.5 2.5 0 0 1 6 9.25Z" {...s} />
      {/* лоток сверху */}
      <path d="M7.5 3.75h9A1.25 1.25 0 0 1 17.75 5v4.25H6.25V5A1.25 1.25 0 0 1 7.5 3.75Z" {...soft} />
      <path d="M7.5 3.75h9A1.25 1.25 0 0 1 17.75 5v4.25H6.25V5A1.25 1.25 0 0 1 7.5 3.75Z" {...s} />
      {/* бумага снизу */}
      <path d="M7.25 18.5v2.25A1 1 0 0 0 8.25 21.75h7.5a1 1 0 0 0 1-1V18.5" {...s} />
      <path d="M8.5 20h7" {...s} strokeWidth={sw * 0.85} opacity={0.7} />
      {/* индикатор / кнопка */}
      <circle cx="17.35" cy="13" r="1" fill="currentColor" fillOpacity={0.85} stroke="none" />
      <path d="M6.5 13h5.5" {...s} strokeWidth={sw * 0.85} opacity={0.7} />
    </svg>
  )
}

export function IconDisk({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <ellipse cx="12" cy="7.5" rx="8.25" ry="3.5" {...soft} />
      <ellipse cx="12" cy="7.5" rx="8.25" ry="3.5" {...s} />
      <path d="M3.75 7.5v9c0 1.93 3.7 3.5 8.25 3.5s8.25-1.57 8.25-3.5v-9" {...s} />
      <ellipse cx="12" cy="16.5" rx="8.25" ry="3.5" {...s} />
      <ellipse cx="12" cy="12" rx="8.25" ry="3.5" {...s} opacity={0.55} />
    </svg>
  )
}

export function IconPencil({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M4.25 19.75h3.75l10.2-10.2a2.1 2.1 0 0 0 0-3l-0.95-0.95a2.1 2.1 0 0 0-3 0L4.25 15.8v3.95z" {...soft} />
      <path d="M4.25 19.75h3.75l10.2-10.2a2.1 2.1 0 0 0 0-3l-0.95-0.95a2.1 2.1 0 0 0-3 0L4.25 15.8v3.95z" {...s} />
      <path d="M13 6.75l4.25 4.25" {...s} opacity={0.85} />
    </svg>
  )
}

export function IconLock({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <rect x="5" y="10.25" width="14" height="10.25" rx="2.25" {...soft} />
      <rect x="5" y="10.25" width="14" height="10.25" rx="2.25" {...s} />
      <path d="M8.25 10.25V8a3.75 3.75 0 0 1 7.5 0v2.25" {...s} />
      <circle cx="12" cy="15.25" r="1.35" fill="currentColor" fillOpacity={0.85} stroke="none" />
    </svg>
  )
}

export function IconSettings({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path
        d="M10.15 3.55c.28-1.05 1.77-1.05 2.05 0l.22.82a1.75 1.75 0 0 0 2.12 1.18l.8-.27c1.02-.34 1.9.78 1.32 1.68l-.45.7a1.75 1.75 0 0 0 .64 2.4l.76.4c.97.5.72 1.95-.38 2.17l-.85.17a1.75 1.75 0 0 0-1.35 1.99l.12.86c.16 1.08-1.1 1.78-1.95 1.08l-.66-.54a1.75 1.75 0 0 0-2.22 0l-.66.54c-.85.7-2.11 0-1.95-1.08l.12-.86a1.75 1.75 0 0 0-1.35-1.99l-.85-.17c-1.1-.22-1.35-1.67-.38-2.17l.76-.4a1.75 1.75 0 0 0 .64-2.4l-.45-.7c-.58-.9.3-2.02 1.32-1.68l.8.27a1.75 1.75 0 0 0 2.12-1.18l.22-.82Z"
        {...soft}
      />
      <path
        d="M10.15 3.55c.28-1.05 1.77-1.05 2.05 0l.22.82a1.75 1.75 0 0 0 2.12 1.18l.8-.27c1.02-.34 1.9.78 1.32 1.68l-.45.7a1.75 1.75 0 0 0 .64 2.4l.76.4c.97.5.72 1.95-.38 2.17l-.85.17a1.75 1.75 0 0 0-1.35 1.99l.12.86c.16 1.08-1.1 1.78-1.95 1.08l-.66-.54a1.75 1.75 0 0 0-2.22 0l-.66.54c-.85.7-2.11 0-1.95-1.08l.12-.86a1.75 1.75 0 0 0-1.35-1.99l-.85-.17c-1.1-.22-1.35-1.67-.38-2.17l.76-.4a1.75 1.75 0 0 0 .64-2.4l-.45-.7c-.58-.9.3-2.02 1.32-1.68l.8.27a1.75 1.75 0 0 0 2.12-1.18l.22-.82Z"
        {...s}
      />
      <circle cx="12" cy="12" r="3.1" {...soft} fillOpacity={0.22} />
      <circle cx="12" cy="12" r="3.1" {...s} />
    </svg>
  )
}
