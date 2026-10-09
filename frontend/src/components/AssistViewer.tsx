import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { api, assistLiveWebSocketUrl, type AssistSession } from '../api'
import { useT } from '../i18n/LocaleContext'

type ScreenInfo = { i: number; w: number; h: number; p?: boolean }

type AssistMeta = {
  mon?: number
  mc?: number
  cx?: number
  cy?: number
  cv?: number
  w?: number
  h?: number
  mw?: number
  mh?: number
  screens?: ScreenInfo[]
}

const KEY_VK: Record<string, number> = {
  Enter: 13,
  Escape: 27,
  Backspace: 8,
  Tab: 9,
  ' ': 32,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  Control: 17,
  Shift: 16,
  Alt: 18,
}

function vkOf(event: KeyboardEvent): number {
  if (KEY_VK[event.key] != null) return KEY_VK[event.key]
  if (event.key.length === 1) {
    const code = event.key.toUpperCase().charCodeAt(0)
    if ((code >= 65 && code <= 90) || (code >= 48 && code <= 57)) return code
  }
  return 0
}


export function AssistViewer({ session, onClose }: { session: AssistSession; onClose: () => void }) {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const framesRef = useRef<number[]>([])
  const [waiting, setWaiting] = useState(true)
  const [late, setLate] = useState(false)
  const [hint, setHint] = useState(t('remoteConnect.assistWaiting', { host: session.hostname }))
  const [meta, setMeta] = useState<AssistMeta>({})
  const [fps, setFps] = useState(0)
  const [quality, setQuality] = useState(72)
  const [focused, setFocused] = useState(false)
  const [cursor, setCursor] = useState<{ x: number; y: number; visible: boolean }>({
    x: 0.5,
    y: 0.5,
    visible: false,
  })

  useEffect(() => {
    const ws = new WebSocket(assistLiveWebSocketUrl(session.id))
    ws.binaryType = 'blob'
    wsRef.current = ws
    const waitTimer = window.setTimeout(() => {
      setLate(true)
      setHint(t('remoteConnect.assistNoTray', { host: session.hostname }))
    }, 28000)
    ws.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        try {
          const packet = JSON.parse(event.data) as AssistMeta & { type?: string }
          if (packet.type === 'meta') {
            setMeta(packet)
            if (packet.cv) {
              setCursor((prev) => ({
                x: typeof packet.cx === 'number' ? packet.cx : prev.x,
                y: typeof packet.cy === 'number' ? packet.cy : prev.y,
                visible: prev.visible || packet.cv === 1,
              }))
            }
          }
        } catch {
          /* ignore */
        }
        return
      }
      const blob = event.data as Blob
      const bmp = await createImageBitmap(blob)
      const canvas = canvasRef.current
      if (!canvas) {
        bmp.close()
        return
      }
      if (canvas.width !== bmp.width) canvas.width = bmp.width
      if (canvas.height !== bmp.height) canvas.height = bmp.height
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(bmp, 0, 0)
      }
      bmp.close()
      const now = performance.now()
      framesRef.current = framesRef.current.filter((stamp) => now - stamp < 1000)
      framesRef.current.push(now)
      setFps(framesRef.current.length)
      setWaiting(false)
      setLate(false)
      window.clearTimeout(waitTimer)
    }
    ws.onclose = () => {
      window.clearTimeout(waitTimer)
    }
    return () => {
      window.clearTimeout(waitTimer)
      ws.close()
      wsRef.current = null
      void api.assistEnd(session.id).catch(() => undefined)
    }
  }, [session.id, session.hostname, t])

  function send(events: object[]) {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'input', events }))
  }

  function pos(event: MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    }
  }

  function onMove(event: MouseEvent<HTMLCanvasElement>) {
    const p = pos(event)
    setCursor({ x: p.x, y: p.y, visible: true })
    send([{ t: 'm', x: p.x, y: p.y, b: 0, d: 2 }])
  }

  async function hangup() {
    try {
      wsRef.current?.send(JSON.stringify({ type: 'end' }))
    } catch {
      /* already closed */
    }
    await api.assistEnd(session.id).catch(() => undefined)
    onClose()
  }

  function selectMonitor(index: number) {
    send([{ t: 's', i: index }])
    setMeta((prev) => ({ ...prev, mon: index }))
  }

  function setEncode(next: number) {
    setQuality(next)
    send([{ t: 'q', v: next }])
  }

  function toggleFullscreen() {
    const node = shellRef.current
    if (!node) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void node.requestFullscreen()
  }

  const screens = meta.screens?.length
    ? meta.screens
    : Array.from({ length: Math.max(1, meta.mc || 1) }, (_, i) => ({ i, w: 0, h: 0 }))
  const activeMon = meta.mon ?? 0
  const remoteW = meta.mw || meta.w || 0
  const remoteH = meta.mh || meta.h || 0
  const cursorStyle = cursor.visible
    ? {
        left: `${cursor.x * 100}%`,
        top: `${cursor.y * 100}%`,
      }
    : undefined

  return createPortal(
    <div className="assist-root" role="dialog" aria-modal="true" aria-label={t('remoteConnect.assist')}>
      <div className="assist-shell" ref={shellRef}>
        <header className="assist-bar">
          <div className="assist-identity">
            <p className="assist-kicker">Corax Assist</p>
            <p className="assist-host">{session.hostname}</p>
            {remoteW && remoteH ? (
              <p className="assist-size">{t('remoteConnect.assistSize', { w: remoteW, h: remoteH })}</p>
            ) : null}
          </div>
          <div className="assist-monitors" role="tablist" aria-label={t('remoteConnect.assistMonitors')}>
            {screens.map((screen, index) => (
              <button
                key={screen.i ?? index}
                type="button"
                role="tab"
                aria-selected={activeMon === index}
                className={`assist-mon${activeMon === index ? ' assist-mon-on' : ''}`}
                onClick={() => selectMonitor(index)}
              >
                {t('remoteConnect.assistMonitor', { n: index + 1 })}
                {screen.w && screen.h ? (
                  <span>
                    {screen.w}×{screen.h}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="assist-tools">
            <div className={`assist-pill${waiting ? '' : ' assist-pill-live'}`}>
              <span className="assist-pill-dot" />
              {waiting ? t('remoteConnect.assistConnecting') : t('remoteConnect.assistLive')}
            </div>
            {!waiting ? <span className="assist-fps">{t('remoteConnect.assistFps', { n: fps })}</span> : null}
            <button
              type="button"
              className={`assist-tool${quality <= 64 ? ' assist-tool-on' : ''}`}
              onClick={() => setEncode(58)}
            >
              {t('remoteConnect.assistQualitySmooth')}
            </button>
            <button
              type="button"
              className={`assist-tool${quality >= 78 ? ' assist-tool-on' : ''}`}
              onClick={() => setEncode(82)}
            >
              {t('remoteConnect.assistQualitySharp')}
            </button>
            <button type="button" className="assist-tool" onClick={() => toggleFullscreen()}>
              {t('remoteConnect.assistFullscreen')}
            </button>
            <button type="button" className="assist-hangup" onClick={() => void hangup()}>
              {t('remoteConnect.assistEnd')}
            </button>
          </div>
        </header>
        <div className={`assist-stage${waiting ? '' : ' assist-stage-live'}`}>
          {waiting ? (
            <div className="assist-wait">
              <div className="assist-rings" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <p className="assist-wait-title">{t('remoteConnect.assistConnecting')}</p>
              <p className="assist-wait-copy">{hint}</p>
              {late ? null : <div className="assist-wait-bar" />}
            </div>
          ) : null}
          <div className="assist-frame">
            <div className="assist-surface">
            <canvas
              ref={canvasRef}
              className="assist-canvas"
              tabIndex={0}
              onContextMenu={(event) => event.preventDefault()}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onMouseEnter={() => {
                setFocused(true)
                canvasRef.current?.focus()
              }}
              onMouseLeave={() => setCursor((prev) => ({ ...prev, visible: false }))}
              onMouseMove={onMove}
              onMouseDown={(event) => {
                event.preventDefault()
                canvasRef.current?.focus()
                setFocused(true)
                const p = pos(event)
                setCursor({ x: p.x, y: p.y, visible: true })
                send([{ t: 'm', x: p.x, y: p.y, b: event.button, d: 1 }])
              }}
              onMouseUp={(event) => {
                const p = pos(event)
                send([{ t: 'm', x: p.x, y: p.y, b: event.button, d: 0 }])
              }}
              onWheel={(event) => {
                event.preventDefault()
                send([{ t: 'w', d: Math.sign(-event.deltaY) * 120 }])
              }}
              onKeyDown={(event) => {
                event.preventDefault()
                const vk = vkOf(event.nativeEvent)
                if (vk) send([{ t: 'k', vk, d: 1 }])
              }}
              onKeyUp={(event) => {
                event.preventDefault()
                const vk = vkOf(event.nativeEvent)
                if (vk) send([{ t: 'k', vk, d: 0 }])
              }}
            />
            {cursor.visible && !waiting ? (
              <div className="assist-cursor" style={cursorStyle} aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22">
                  <path
                    d="M4.2 2.8 19 13.1l-7.2.3-3.6 7.6z"
                    fill="#f8fafc"
                    stroke="#0f172a"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            ) : null}
            </div>
          </div>
        </div>
        <footer className="assist-foot">
          <span className={focused ? 'assist-foot-on' : undefined}>
            {t('remoteConnect.assistPointer')}
          </span>
          <span>{t('remoteConnect.assistHintDetail')}</span>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
