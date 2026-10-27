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
      <rect x="2.6" y="3.8" width="13.6" height="10.4" rx="1.6" {...soft} />
      <rect x="2.6" y="3.8" width="13.6" height="10.4" rx="1.6" {...s} />
      <path d="M2.6 12.2h13.6" {...s} />
      <path d="M7.2 16.6h4.4M9.4 14.2v2.4" {...s} />
      <rect x="17.1" y="6.2" width="4.4" height="12.4" rx="1" {...soft} />
      <rect x="17.1" y="6.2" width="4.4" height="12.4" rx="1" {...s} />
      <path d="M18.15 8.3h2.3M18.15 10.3h2.3M18.15 12.3h1.5" {...s} strokeWidth={sw * 0.8} opacity={0.75} />
      <circle cx="19.3" cy="16.35" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconVm({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <rect x="4.4" y="4.1" width="15.2" height="11.2" rx="1.8" {...soft} />
      <rect x="4.4" y="4.1" width="15.2" height="11.2" rx="1.8" {...s} strokeDasharray="2.6 1.7" />
      <rect x="7.1" y="6.6" width="9.8" height="6.2" rx="1" {...s} />
      <path d="M10.3 8.2v3.1L13.6 9.75Z" fill="currentColor" stroke="none" />
      <rect x="6.2" y="16.4" width="11.6" height="3.4" rx="0.9" {...soft} />
      <rect x="6.2" y="16.4" width="11.6" height="3.4" rx="0.9" {...s} />
      <path d="M8.1 18.1h7.8" {...s} strokeWidth={sw * 0.8} opacity={0.7} />
    </svg>
  )
}

export function IconUser({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="8" r="3.4" {...soft} />
      <path d="M5 19.5v-1.15A5.35 5.35 0 0 1 10.35 13h3.3A5.35 5.35 0 0 1 19 18.35V19.5" {...soft} />
      <circle cx="12" cy="8" r="3.4" {...s} />
      <path d="M5 19.5v-1.15A5.35 5.35 0 0 1 10.35 13h3.3A5.35 5.35 0 0 1 19 18.35V19.5" {...s} />
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
      <path d="M15 4.75H8.75A2.5 2.5 0 0 0 6.25 7.25v9.5a2.5 2.5 0 0 0 2.5 2.5H15" {...soft} />
      <path d="M15 4.75H8.75A2.5 2.5 0 0 0 6.25 7.25v9.5a2.5 2.5 0 0 0 2.5 2.5H15" {...s} />
      <path d="M10.5 12h8.25M16.15 8.6 19.75 12l-3.6 3.4" {...s} />
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

export function IconSend({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M4.4 11.2 19.2 4.6c.55-.25 1.1.3.85.85L13.4 19.6a.7.7 0 0 1-1.28.05l-2.2-5.1-5.1-2.2a.7.7 0 0 1 .05-1.28z" {...soft} />
      <path d="M4.4 11.2 19.2 4.6c.55-.25 1.1.3.85.85L13.4 19.6a.7.7 0 0 1-1.28.05l-2.2-5.1-5.1-2.2a.7.7 0 0 1 .05-1.28z" {...s} />
      <path d="M10.05 13.95 14.4 9.6" {...s} strokeWidth={sw * 0.95} />
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
        d="M6.2 3.6h8.1L18.6 8.1v11.6A1.7 1.7 0 0 1 16.9 21.4H7.1A1.7 1.7 0 0 1 5.4 19.7V5.3A1.7 1.7 0 0 1 7.1 3.6Z"
        {...soft}
      />
      <path
        d="M6.2 3.6h8.1L18.6 8.1v11.6A1.7 1.7 0 0 1 16.9 21.4H7.1A1.7 1.7 0 0 1 5.4 19.7V5.3A1.7 1.7 0 0 1 7.1 3.6Z"
        {...s}
      />
      <path d="M14.3 3.6V8.2h4.3" {...s} />
      <path d="M8.2 12.1h7.6M8.2 15h7.6M8.2 17.9h5.2" {...s} strokeWidth={sw * 0.9} opacity={0.85} />
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

/** Monitoring / Zabbix — dashboard panel, not Wi‑Fi. */
export function IconZabbix({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <rect x="3.25" y="4.25" width="17.5" height="13.5" rx="2.2" {...soft} />
      <rect x="3.25" y="4.25" width="17.5" height="13.5" rx="2.2" {...s} />
      <path d="M7 14.25V10.5M10.25 14.25V8.25M13.5 14.25v-4M16.75 14.25V9.1" {...s} />
      <path d="M6.5 19.25h11" {...s} strokeWidth={sw * 0.9} />
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

export function IconAssistant({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path
        d="M5.4 5.75h10.7A2.6 2.6 0 0 1 18.7 8.35v6.15a2.6 2.6 0 0 1-2.6 2.6h-5.35L7.1 20.1v-3h-1.7A2.6 2.6 0 0 1 2.8 14.5V8.35A2.6 2.6 0 0 1 5.4 5.75z"
        {...soft}
      />
      <path
        d="M5.4 5.75h10.7A2.6 2.6 0 0 1 18.7 8.35v6.15a2.6 2.6 0 0 1-2.6 2.6h-5.35L7.1 20.1v-3h-1.7A2.6 2.6 0 0 1 2.8 14.5V8.35A2.6 2.6 0 0 1 5.4 5.75z"
        {...s}
      />
      <path d="M7.35 10.7h6.4M7.35 13.35h4.1" {...s} strokeWidth={sw * 0.9} opacity={0.9} />
      <path d="M18.35 4.15v2.55M17.1 5.42h2.5" {...s} strokeWidth={sw * 0.95} />
    </svg>
  )
}

export function IconFolder({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path
        d="M3.75 8.25A1.75 1.75 0 0 1 5.5 6.5h3.2l1.4 1.5h8.4A1.75 1.75 0 0 1 20.25 9.75v7A1.75 1.75 0 0 1 18.5 18.5H5.5A1.75 1.75 0 0 1 3.75 16.75v-8.5z"
        {...soft}
      />
      <path
        d="M3.75 8.25A1.75 1.75 0 0 1 5.5 6.5h3.2l1.4 1.5h8.4A1.75 1.75 0 0 1 20.25 9.75v7A1.75 1.75 0 0 1 18.5 18.5H5.5A1.75 1.75 0 0 1 3.75 16.75v-8.5z"
        {...s}
      />
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

export function IconInfo({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="12" r="8.25" {...soft} />
      <circle cx="12" cy="12" r="8.25" {...s} />
      <circle cx="12" cy="8.15" r="1.05" fill="currentColor" stroke="none" />
      <path d="M12 11.15v5.4" {...s} strokeWidth={sw * 1.15} />
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

export function IconImage({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <rect x="3.5" y="5" width="17" height="14" rx="2.25" {...soft} />
      <rect x="3.5" y="5" width="17" height="14" rx="2.25" {...s} />
      <circle cx="8.6" cy="9.6" r="1.45" fill="currentColor" fillOpacity={0.55} stroke="none" />
      <path d="M4.2 16.4 9.1 12.1l3.2 2.4 3.1-3.6 4.4 5.5" {...s} />
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
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        {...soft}
      />
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        {...s}
      />
      <circle cx="12" cy="12" r="3" {...s} />
    </svg>
  )
}

/** Стилизованный треугольник «подробнее» (play / chevron). */
export function IconDetails({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <path d="M9.2 6.4c-.7-.45-1.6.05-1.6.88v9.44c0 .83.9 1.33 1.6.88l7.4-4.72c.64-.41.64-1.35 0-1.76L9.2 6.4Z" {...soft} fillOpacity={0.22} />
      <path
        d="M9.2 6.4c-.7-.45-1.6.05-1.6.88v9.44c0 .83.9 1.33 1.6.88l7.4-4.72c.64-.41.64-1.35 0-1.76L9.2 6.4Z"
        fill="currentColor"
        fillOpacity={0.92}
        stroke="none"
      />
    </svg>
  )
}

export function IconRouter({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <path d="M7.2 10.2 6.1 3.6M16.8 10.2 17.9 3.6" {...s} />
      <circle cx="6.05" cy="3.35" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="17.95" cy="3.35" r="1.05" fill="currentColor" stroke="none" />
      <rect x="3.2" y="10.1" width="17.6" height="10.2" rx="2.1" {...soft} />
      <rect x="3.2" y="10.1" width="17.6" height="10.2" rx="2.1" {...s} />
      <rect x="5.1" y="12.15" width="6.4" height="2.5" rx="0.55" {...s} />
      <circle cx="14.15" cy="13.4" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="16.55" cy="13.4" r="0.85" fill="currentColor" fillOpacity={0.55} stroke="none" />
      <circle cx="18.85" cy="13.4" r="0.85" fill="currentColor" fillOpacity={0.32} stroke="none" />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={5.2 + i * 3.5} y="16.35" width="2.35" height="2.35" rx="0.4" fill="currentColor" fillOpacity={0.5} stroke="none" />
      ))}
    </svg>
  )
}

export function IconSwitch({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <rect x="2.4" y="6.2" width="19.2" height="11.6" rx="2" {...soft} />
      <rect x="2.4" y="6.2" width="19.2" height="11.6" rx="2" {...s} />
      <path d="M4.3 8.35h3.4" {...s} strokeWidth={sw * 0.85} />
      <circle cx="9.2" cy="8.35" r="0.55" fill="currentColor" stroke="none" />
      <circle cx="10.7" cy="8.35" r="0.55" fill="currentColor" fillOpacity={0.45} stroke="none" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <rect key={`a-${i}`} x={4.15 + i * 2.7} y="10.35" width="2.05" height="2.55" rx="0.35" fill="currentColor" fillOpacity={0.62} stroke="none" />
      ))}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <rect key={`b-${i}`} x={4.15 + i * 2.7} y="13.35" width="2.05" height="2.55" rx="0.35" fill="currentColor" fillOpacity={0.38} stroke="none" />
      ))}
    </svg>
  )
}

export function IconAccessPoint({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <ellipse cx="12" cy="15.6" rx="6.4" ry="3.15" {...soft} />
      <ellipse cx="12" cy="15.6" rx="6.4" ry="3.15" {...s} />
      <ellipse cx="12" cy="15.15" rx="3.1" ry="1.45" {...s} opacity={0.7} />
      <circle cx="12" cy="15.1" r="0.85" fill="currentColor" stroke="none" />
      <path d="M12 12.3V6.4" {...s} />
      <circle cx="12" cy="5.55" r="1.15" {...s} />
      <path d="M8.15 8.55a5.2 5.2 0 0 1 7.7 0M6.2 6.45a8 8 0 0 1 11.6 0" {...s} />
    </svg>
  )
}

export function IconFirewall({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="1.6" {...soft} />
      <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="1.6" {...s} />
      <path d="M3.4 8.4h17.2M3.4 12h17.2M3.4 15.6h17.2" {...s} />
      <path d="M12 4.4v4M8.2 8.4v3.6M15.8 8.4v3.6M12 12v3.6M8.2 15.6v3.99M15.8 15.6v3.99" {...s} />
    </svg>
  )
}

export function IconServer({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      {[0, 1, 2].map((row) => {
        const y = 3.7 + row * 5.7
        return (
          <g key={row}>
            <rect x="3.3" y={y} width="17.4" height="5" rx="1.15" {...soft} />
            <rect x="3.3" y={y} width="17.4" height="5" rx="1.15" {...s} />
            <circle cx="6.15" cy={y + 2.5} r="0.8" fill="currentColor" stroke="none" />
            <rect x="8.3" y={y + 1.45} width="5.4" height="2.1" rx="0.35" fill="currentColor" fillOpacity={0.28} stroke="none" />
            <rect x="14.2" y={y + 1.45} width="4.6" height="2.1" rx="0.35" fill="currentColor" fillOpacity={0.18} stroke="none" />
          </g>
        )
      })}
    </svg>
  )
}

export function IconNas({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <rect x="3.6" y="4.2" width="16.8" height="15.6" rx="2" {...soft} />
      <rect x="3.6" y="4.2" width="16.8" height="15.6" rx="2" {...s} />
      <rect x="5.5" y="6.3" width="13" height="4.3" rx="0.8" {...s} />
      <rect x="5.5" y="11.4" width="13" height="4.3" rx="0.8" {...s} />
      <path d="M7 8.45h8.2M7 13.55h8.2" {...s} strokeWidth={sw * 0.8} opacity={0.7} />
      <circle cx="16.2" cy="17.55" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconCloud({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <path d="M7.6 17.35h9.6A3.85 3.85 0 0 0 21.1 13.6c0-2-1.45-3.65-3.4-3.95A5.15 5.15 0 0 0 8 8.15 4 4 0 0 0 3.85 12.2c0 2.2 1.7 4 3.95 4.15Z" {...soft} />
      <path d="M7.6 17.35h9.6A3.85 3.85 0 0 0 21.1 13.6c0-2-1.45-3.65-3.4-3.95A5.15 5.15 0 0 0 8 8.15 4 4 0 0 0 3.85 12.2c0 2.2 1.7 4 3.95 4.15Z" {...s} />
      <circle cx="9.2" cy="13.35" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="12.15" cy="13.35" r="0.85" fill="currentColor" fillOpacity={0.55} stroke="none" />
      <circle cx="15.1" cy="13.35" r="0.85" fill="currentColor" fillOpacity={0.32} stroke="none" />
    </svg>
  )
}

export function IconCable({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <path d="M7.6 8.1c2.4 0 2.8 2.5 4.4 3.9 1.5 1.3 2.3 3.9 4.6 3.9" {...s} />
      <rect x="2.5" y="5.7" width="5.3" height="4.8" rx="0.9" {...soft} />
      <rect x="2.5" y="5.7" width="5.3" height="4.8" rx="0.9" {...s} />
      <path d="M3.4 5.7V4.3M5.15 5.7V4.3M6.9 5.7V4.3" {...s} />
      <rect x="16.2" y="13.5" width="5.3" height="4.8" rx="0.9" {...soft} />
      <rect x="16.2" y="13.5" width="5.3" height="4.8" rx="0.9" {...s} />
      <path d="M17.1 18.3v1.4M18.85 18.3v1.4M20.6 18.3v1.4" {...s} />
    </svg>
  )
}

export function IconNetworkMap({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <circle cx="7.2" cy="7.4" r="2.55" {...soft} />
      <circle cx="16.8" cy="8.1" r="2.55" {...soft} />
      <circle cx="12" cy="16.6" r="2.7" {...soft} />
      <circle cx="7.2" cy="7.4" r="2.55" {...s} />
      <circle cx="16.8" cy="8.1" r="2.55" {...s} />
      <circle cx="12" cy="16.6" r="2.7" {...s} />
      <path d="M9.5 8.2 14.4 8.6M8.4 9.6 10.7 14.4M15.4 10.2 13.3 14.4" {...s} />
    </svg>
  )
}

export function IconRoom({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <path d="M4.4 5.2h15.2v13.6H4.4z" {...soft} />
      <path d="M4.4 5.2h15.2v13.6H14.7" {...s} />
      <path d="M9.3 18.8V15a1.4 1.4 0 0 1 1.4-1.4h2.6A1.4 1.4 0 0 1 14.7 15v3.8" {...s} />
      <path d="M7.1 8.3h3.2M7.1 11h4.6" {...s} strokeWidth={sw * 0.85} opacity={0.75} />
    </svg>
  )
}

export function IconRack({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <rect x="5.2" y="3.3" width="13.6" height="17.4" rx="1.5" {...soft} />
      <rect x="5.2" y="3.3" width="13.6" height="17.4" rx="1.5" {...s} />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x="7.15" y={5.35 + i * 3.55} width="9.7" height="2.55" rx="0.45" {...s} />
      ))}
      <circle cx="6.55" cy="6.6" r="0.45" fill="currentColor" stroke="none" />
      <circle cx="17.45" cy="6.6" r="0.45" fill="currentColor" stroke="none" />
      <circle cx="6.55" cy="17.4" r="0.45" fill="currentColor" stroke="none" />
      <circle cx="17.45" cy="17.4" r="0.45" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconDownload({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <path d="M12 4.5v10.2" {...s} />
      <path d="M8.2 11.6 12 15.4l3.8-3.8" {...s} />
      <path d="M5.2 18.8h13.6" {...s} />
    </svg>
  )
}

export function IconUndo({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <path d="M8 8.2 4.4 11.5 8 14.8" {...s} />
      <path d="M4.6 11.5h8.6c3.4 0 6.2 2.2 6.2 5.2" {...s} />
    </svg>
  )
}

export function IconList({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" {...soft} />
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" {...s} />
      <path d="M7 9h10M7 12h10M7 15h6" {...s} strokeWidth={sw * 0.9} />
    </svg>
  )
}

export function IconChart({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M4 19.5h16" {...s} />
      <rect x="6" y="12" width="3" height="6" rx="0.6" {...soft} />
      <rect x="10.5" y="8" width="3" height="10" rx="0.6" {...soft} />
      <rect x="15" y="5" width="3" height="13" rx="0.6" {...soft} />
      <rect x="6" y="12" width="3" height="6" rx="0.6" {...s} />
      <rect x="10.5" y="8" width="3" height="10" rx="0.6" {...s} />
      <rect x="15" y="5" width="3" height="13" rx="0.6" {...s} />
    </svg>
  )
}

export function IconTree({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <rect x="9" y="3.5" width="6" height="4" rx="1" {...soft} />
      <rect x="3.5" y="16" width="6" height="4" rx="1" {...soft} />
      <rect x="14.5" y="16" width="6" height="4" rx="1" {...soft} />
      <rect x="9" y="3.5" width="6" height="4" rx="1" {...s} />
      <rect x="3.5" y="16" width="6" height="4" rx="1" {...s} />
      <rect x="14.5" y="16" width="6" height="4" rx="1" {...s} />
      <path d="M12 7.5v3.2M12 10.7H6.5V16M12 10.7h5.5V16" {...s} />
    </svg>
  )
}

export function IconPower({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M12 3.5v7" {...s} />
      <path d="M8.2 6.2a7 7 0 1 0 7.6 0" {...s} />
    </svg>
  )
}

export function IconRedo({ className, title }: Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={!title} role={title ? 'img' : 'presentation'}>
      {title ? <title>{title}</title> : null}
      <path d="M16 8.2 19.6 11.5 16 14.8" {...s} />
      <path d="M19.4 11.5H10.8c-3.4 0-6.2 2.2-6.2 5.2" {...s} />
    </svg>
  )
}
