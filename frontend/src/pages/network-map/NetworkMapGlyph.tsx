import type { ReactNode } from 'react'

type Pt = { x: number; y: number }

const INK = '#1e3a5f'
const TOP = '#eef4ff'
const SIDE = '#b4c6e8'
const FACE = '#5b82d6'
const LED_ON = '#059669'
const LED_OFF = '#94a3b8'
const ANT = '#1e3a5f'

const TINT = {
  router: { top: '#e8effc', side: '#9bb6e8', face: '#3b6fd4' },
  switch: { top: '#e6f5f2', side: '#8fc4bb', face: '#0f766e' },
  firewall: { top: '#fceee8', side: '#e0a48c', face: '#c2410c' },
  server: { top: '#eceafc', side: '#a9a3e0', face: '#4338ca' },
  nas: { top: '#f0e9fc', side: '#b9a3e0', face: '#6d28d9' },
  pc: { top: '#eef1f5', side: '#b7c0cc', face: '#475569' },
  corax: { top: '#e8effc', side: '#93b4ea', face: '#2563eb' },
  printer: { top: '#f3f1ee', side: '#c4bdb4', face: '#57534e' },
  rack: { top: '#eef1f5', side: '#b7c0cc', face: '#64748b' },
} as const

function iso(x: number, y: number, z: number, ox: number, oy: number): Pt {
  return { x: ox + (x - y) * 0.9, y: oy + (x + y) * 0.5 - z }
}

function pts(list: Pt[]): string {
  return list.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

function IsoBox({
  ox,
  oy,
  w,
  d,
  h,
  top = TOP,
  side = SIDE,
  face = FACE,
}: {
  ox: number
  oy: number
  w: number
  d: number
  h: number
  top?: string
  side?: string
  face?: string
}) {
  const p = (x: number, y: number, z: number) => iso(x, y, z, ox, oy)
  const a = p(0, 0, h)
  const b = p(w, 0, h)
  const c = p(w, d, h)
  const e = p(0, d, h)
  const f = p(0, 0, 0)
  const g = p(w, 0, 0)
  const h0 = p(0, d, 0)
  return (
    <g stroke={INK} strokeWidth="0.95" strokeLinejoin="round" strokeLinecap="round">
      <polygon points={pts([a, e, h0, f])} fill={side} />
      <polygon points={pts([a, b, g, f])} fill={face} />
      <polygon points={pts([a, b, c, e])} fill={top} />
      <polygon
        points={pts([p(1.4, 1.2, h), p(w - 1.6, 1.2, h), p(w - 3.2, 3.1, h), p(3, 3.1, h)])}
        fill="#ffffff"
        stroke="none"
        opacity="0.42"
      />
    </g>
  )
}

function IsoFrontDot({
  ox,
  oy,
  fx,
  fz,
  r = 1.15,
  fill,
}: {
  ox: number
  oy: number
  fx: number
  fz: number
  r?: number
  fill: string
}) {
  const p = iso(fx, 0, fz, ox, oy)
  return <circle cx={p.x} cy={p.y} r={r} fill={fill} stroke={INK} strokeWidth="0.4" />
}

function Antenna({ ox, oy, x, y, z, h = 14 }: { ox: number; oy: number; x: number; y: number; z: number; h?: number }) {
  const base = iso(x, y, z, ox, oy)
  const tip = iso(x, y, z + h, ox, oy)
  return (
    <g stroke={ANT} strokeWidth="1.15" strokeLinecap="round">
      <line x1={base.x} y1={base.y} x2={tip.x} y2={tip.y} />
      <circle cx={tip.x} cy={tip.y} r="1.35" fill={ANT} stroke="none" />
    </g>
  )
}

function RouterMark() {
  const ox = 22
  const oy = 44
  return (
    <>
      <Antenna ox={ox} oy={oy} x={6} y={14} z={13} />
      <Antenna ox={ox} oy={oy} x={16} y={14} z={13} />
      <IsoBox ox={ox} oy={oy} w={22} d={14} h={13} {...TINT.router} />
      <IsoFrontDot ox={ox} oy={oy} fx={5} fz={8} fill={LED_ON} />
      <IsoFrontDot ox={ox} oy={oy} fx={9} fz={8} fill={LED_OFF} />
      <IsoFrontDot ox={ox} oy={oy} fx={13} fz={8} fill={LED_OFF} />
    </>
  )
}

function SwitchMark() {
  const ox = 18
  const oy = 44
  const p = (x: number, y: number, z: number) => iso(x, y, z, ox, oy)
  const ports = [4, 7.2, 10.4, 13.6, 16.8, 20, 23.2]
  return (
    <>
      <IsoBox ox={ox} oy={oy} w={28} d={12} h={10} {...TINT.switch} />
      {ports.map((fx) => {
        const a = p(fx, 0, 6.6)
        const b = p(fx + 2.2, 0, 6.6)
        const c = p(fx + 2.2, 0, 3.4)
        const d = p(fx, 0, 3.4)
        return <polygon key={fx} points={pts([a, b, c, d])} fill="#2a2a2a" stroke={INK} strokeWidth="0.35" />
      })}
      <IsoFrontDot ox={ox} oy={oy} fx={5} fz={8.2} r={0.9} fill={LED_ON} />
    </>
  )
}

function FirewallMark() {
  const ox = 22
  const oy = 44
  const p = (x: number, y: number, z: number) => iso(x, y, z, ox, oy)
  const mortar = '#9a4a2e'
  return (
    <>
      <IsoBox ox={ox} oy={oy} w={22} d={14} h={14} {...TINT.firewall} />
      {[3, 7, 11].map((fz) => (
        <line
          key={fz}
          x1={p(1.5, 0, fz).x}
          y1={p(1.5, 0, fz).y}
          x2={p(20.5, 0, fz).x}
          y2={p(20.5, 0, fz).y}
          stroke={mortar}
          strokeWidth="0.7"
        />
      ))}
      {[5, 11, 17].map((fx) => (
        <line
          key={fx}
          x1={p(fx, 0, 14).x}
          y1={p(fx, 0, 14).y}
          x2={p(fx, 0, 0).x}
          y2={p(fx, 0, 0).y}
          stroke={mortar}
          strokeWidth="0.7"
        />
      ))}
    </>
  )
}

function ApMark() {
  return (
    <>
      <ellipse cx="32" cy="42" rx="16" ry="7.2" fill="#7eb8c4" stroke={INK} strokeWidth="0.95" />
      <ellipse cx="32" cy="40.2" rx="16" ry="7.2" fill="#d7eef2" stroke={INK} strokeWidth="0.95" />
      <ellipse cx="32" cy="40.2" rx="6.5" ry="2.8" fill="#0e7490" stroke={INK} strokeWidth="0.6" />
      <circle cx="32" cy="40" r="1.4" fill={LED_ON} stroke={INK} strokeWidth="0.4" />
      <line x1="32" y1="33.4" x2="32" y2="16" stroke={ANT} strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="32" cy="15" r="1.5" fill={ANT} />
      <path d="M24 22.5c4.6-4.2 11.4-4.2 16 0" fill="none" stroke="#0e7490" strokeWidth="1.05" strokeLinecap="round" />
      <path d="M21 18.5c6.4-6 15.6-6 22 0" fill="none" stroke="#5aa3b4" strokeWidth="1" strokeLinecap="round" />
    </>
  )
}

function ServerMark() {
  const ox = 24
  const oy = 48
  const p = (x: number, y: number, z: number) => iso(x, y, z, ox, oy)
  return (
    <>
      <IsoBox ox={ox} oy={oy} w={16} d={16} h={22} {...TINT.server} />
      {[6, 11, 16].map((fz) => {
        const a = p(2.2, 0, fz)
        const b = p(13.8, 0, fz)
        const c = p(13.8, 0, fz - 3.2)
        const d = p(2.2, 0, fz - 3.2)
        return (
          <g key={fz}>
            <polygon points={pts([a, b, c, d])} fill="#312e81" stroke={INK} strokeWidth="0.55" />
            <IsoFrontDot ox={ox} oy={oy} fx={4.2} fz={fz - 1.5} r={0.75} fill={LED_ON} />
          </g>
        )
      })}
    </>
  )
}

function NasMark() {
  const ox = 22
  const oy = 46
  const p = (x: number, y: number, z: number) => iso(x, y, z, ox, oy)
  return (
    <>
      <IsoBox ox={ox} oy={oy} w={20} d={14} h={16} {...TINT.nas} />
      {[5, 9.5, 14].map((fx) => {
        const a = p(fx, 0, 13)
        const b = p(fx + 3.2, 0, 13)
        const c = p(fx + 3.2, 0, 3)
        const d = p(fx, 0, 3)
        return <polygon key={fx} points={pts([a, b, c, d])} fill="#4c1d95" stroke={INK} strokeWidth="0.55" />
      })}
      <IsoFrontDot ox={ox} oy={oy} fx={17.4} fz={8} r={0.9} fill={LED_ON} />
    </>
  )
}

function PcMark() {
  const towerOx = 14
  const towerOy = 48
  const monOx = 30
  const monOy = 42
  const p = (x: number, y: number, z: number) => iso(x, y, z, monOx, monOy)
  const screen = [p(2, 0, 16), p(18, 0, 16), p(18, 0, 4), p(2, 0, 4)]
  return (
    <>
      <IsoBox ox={towerOx} oy={towerOy} w={10} d={12} h={18} {...TINT.pc} />
      <IsoFrontDot ox={towerOx} oy={towerOy} fx={5} fz={4} r={0.85} fill={LED_ON} />
      <IsoBox ox={monOx} oy={monOy} w={20} d={6} h={18} top="#e8eef8" face="#334155" />
      <polygon points={pts(screen)} fill="#1d4ed8" stroke={INK} strokeWidth="0.55" />
      <line
        x1={iso(10, 0, 0, monOx, monOy).x}
        y1={iso(10, 0, 0, monOx, monOy).y}
        x2={iso(10, 0, -6, monOx, monOy).x}
        y2={iso(10, 0, -6, monOx, monOy).y}
        stroke={INK}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <ellipse
        cx={iso(10, 0, -6.2, monOx, monOy).x}
        cy={iso(10, 0, -6.2, monOx, monOy).y + 1.4}
        rx="6"
        ry="1.6"
        fill="#64748b"
        stroke={INK}
        strokeWidth="0.7"
      />
    </>
  )
}

function VmMark() {
  return (
    <>
      <PcMark />
      <rect x="38" y="12" width="18" height="11" rx="2" fill="#7c3aed" stroke={INK} strokeWidth="0.8" />
      <text x="47" y="20.2" textAnchor="middle" fontSize="7" fontWeight="700" fill="#f4f4f4">
        VM
      </text>
    </>
  )
}

function PrinterMark() {
  const ox = 18
  const oy = 46
  const p = (x: number, y: number, z: number) => iso(x, y, z, ox, oy)
  return (
    <>
      <IsoBox ox={ox} oy={oy} w={26} d={14} h={10} {...TINT.printer} />
      <polygon
        points={pts([p(5, 4, 10), p(21, 4, 10), p(18, 10, 16), p(8, 10, 16)])}
        fill="#f4f1ea"
        stroke={INK}
        strokeWidth="0.8"
      />
      <polygon
        points={pts([p(6, 0, 4), p(20, 0, 4), p(20, 0, 1.5), p(6, 0, 1.5)])}
        fill="#1e3a5f"
        stroke={INK}
        strokeWidth="0.5"
      />
    </>
  )
}

function CloudMark() {
  return (
    <>
      <path
        d="M18 40.5c-5.4 0-9.5-3.8-9.5-8.4 0-4.2 3.2-7.7 7.4-8.3C17.4 18.6 22.2 15 28.2 15c6.4 0 11.6 4.3 12.8 10.1 1.1-.4 2.3-.6 3.6-.6 5.4 0 9.7 4 9.7 9 0 5-4.3 9-9.7 9H18Z"
        fill="#bfdbfe"
        stroke={INK}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path
        d="M20 37.5c-4.2 0-7.2-2.7-7.2-6.2 0-3.1 2.4-5.7 5.6-6.2.8-4.3 4.6-7.4 9.3-7.4 4.9 0 8.9 3.2 9.9 7.6 4.2.3 7.5 3.4 7.5 7.2 0 4-3.6 7.1-8 7.1H20Z"
        fill="#eff6ff"
        stroke="none"
      />
    </>
  )
}

function CoraxMark() {
  const ox = 22
  const oy = 46
  const p = (x: number, y: number, z: number) => iso(x, y, z, ox, oy)
  const screen = [p(4, 0, 13), p(16, 0, 13), p(16, 0, 6), p(4, 0, 6)]
  return (
    <>
      <IsoBox ox={ox} oy={oy} w={20} d={14} h={16} {...TINT.corax} />
      <polygon points={pts(screen)} fill="#1e40af" stroke={INK} strokeWidth="0.45" />
      <IsoFrontDot ox={ox} oy={oy} fx={6} fz={4} fill={LED_ON} />
      <IsoFrontDot ox={ox} oy={oy} fx={10} fz={4} fill={LED_OFF} />
      <IsoFrontDot ox={ox} oy={oy} fx={14} fz={4} fill={LED_OFF} />
    </>
  )
}

function CableMark() {
  return (
    <path
      d="M28 10 16 30h10L22 54 48 26H36L42 10Z"
      fill="#2563eb"
      stroke={INK}
      strokeWidth="1.05"
      strokeLinejoin="round"
    />
  )
}

function NoteMark() {
  return (
    <>
      <path d="M18 14h24l4 4v32H18V14Z" fill="#f3e27a" stroke={INK} strokeWidth="1" strokeLinejoin="round" />
      <path d="M42 14v6h6" fill="none" stroke={INK} strokeWidth="1" />
      <path d="M24 28h16M24 35h16M24 42h11" stroke="#b59a2a" strokeWidth="1.15" strokeLinecap="round" />
    </>
  )
}

function ImageMark() {
  return (
    <>
      <rect x="12" y="16" width="40" height="32" rx="2" fill="#eff6ff" stroke={INK} strokeWidth="1" />
      <path d="M12 40 24 28l8 8 8-10 12 14" fill="#93c5fd" stroke={INK} strokeWidth="0.8" strokeLinejoin="round" />
      <circle cx="24" cy="24" r="3.2" fill="#fbbf24" stroke={INK} strokeWidth="0.7" />
    </>
  )
}

function RoomMark() {
  return (
    <>
      <rect x="12" y="16" width="40" height="32" fill="#ecfdf3" stroke={INK} strokeWidth="1.1" strokeDasharray="3 2" />
      <rect x="20" y="24" width="10" height="8" fill="#a7f3d0" stroke={INK} strokeWidth="0.7" />
      <rect x="34" y="30" width="10" height="10" fill="#a7f3d0" stroke={INK} strokeWidth="0.7" />
    </>
  )
}

function RackMark() {
  const ox = 24
  const oy = 48
  const p = (x: number, y: number, z: number) => iso(x, y, z, ox, oy)
  return (
    <>
      <IsoBox ox={ox} oy={oy} w={16} d={14} h={24} {...TINT.rack} />
      {[5, 9, 13, 17, 21].map((fz) => (
        <line
          key={fz}
          x1={p(1.6, 0, fz).x}
          y1={p(1.6, 0, fz).y}
          x2={p(14.4, 0, fz).x}
          y2={p(14.4, 0, fz).y}
          stroke="#334155"
          strokeWidth="0.9"
        />
      ))}
    </>
  )
}

function UnknownMark() {
  const ox = 22
  const oy = 44
  return (
    <>
      <IsoBox ox={ox} oy={oy} w={20} d={14} h={12} {...TINT.pc} />
      <text x="32" y="38" textAnchor="middle" fontSize="12" fontWeight="700" fill={INK}>
        ?
      </text>
    </>
  )
}

const GLYPHS: Record<string, () => ReactNode> = {
  switch: SwitchMark,
  controller: SwitchMark,
  router: RouterMark,
  gateway: RouterMark,
  modem: RouterMark,
  firewall: FirewallMark,
  ap: ApMark,
  server: ServerMark,
  corax: CoraxMark,
  nas: NasMark,
  pc: PcMark,
  host: PcMark,
  computer: PcMark,
  vm: VmMark,
  printer: PrinterMark,
  cloud: CloudMark,
  cable: CableMark,
  note: NoteMark,
  image: ImageMark,
  room: RoomMark,
  rack: RackMark,
  unknown: UnknownMark,
}

const SIZE: Record<string, string> = {
  sm: 'h-5 w-5',
  md: 'h-9 w-9',
  lg: 'h-14 w-14',
  wide: 'h-14 w-14',
}

export function NetworkMapGlyph({
  kind,
  size = 'md',
  active,
  neighbor,
  className = '',
}: {
  kind: string
  size?: keyof typeof SIZE
  active?: boolean
  neighbor?: boolean
  className?: string
}) {
  const tone = (kind || 'unknown').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'unknown'
  const Glyph = GLYPHS[tone] || UnknownMark
  return (
    <span
      className={`network-map-mark is-${tone} ${SIZE[size]} ${active ? 'is-active' : ''} ${neighbor ? 'is-neighbor' : ''} ${className}`}
    >
      <svg viewBox="0 0 64 64" className="network-map-iso" aria-hidden>
        <Glyph />
      </svg>
    </span>
  )
}
