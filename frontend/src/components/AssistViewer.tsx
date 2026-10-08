import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { api, assistLiveWebSocketUrl, type AssistSession } from '../api'
import { useT } from '../i18n/LocaleContext'

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
  const wsRef = useRef<WebSocket | null>(null)
  const [waiting, setWaiting] = useState(true)
  const [hint, setHint] = useState(t('remoteConnect.assistWaiting', { host: session.hostname }))

  useEffect(() => {
    const ws = new WebSocket(assistLiveWebSocketUrl(session.id))
    ws.binaryType = 'blob'
    wsRef.current = ws
    const waitTimer = window.setTimeout(() => {
      setHint(t('remoteConnect.assistNoTray', { host: session.hostname }))
    }, 28000)
    ws.onmessage = async (event) => {
      if (typeof event.data === 'string') return
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
      ctx?.drawImage(bmp, 0, 0)
      bmp.close()
      setWaiting(false)
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

  async function hangup() {
    try {
      wsRef.current?.send(JSON.stringify({ type: 'end' }))
    } catch {
      /* already closed */
    }
    await api.assistEnd(session.id).catch(() => undefined)
    onClose()
  }

  return createPortal(
    <div className="assist-root" role="dialog" aria-modal="true" aria-label={t('remoteConnect.assist')}>
      <div className="assist-shell">
        <header className="assist-bar">
          <div>
            <p className="assist-kicker">Corax Assist</p>
            <p className="assist-host">{session.hostname}</p>
          </div>
          <button type="button" className="app-btn app-btn-secondary !min-h-0 text-sm" onClick={() => void hangup()}>
            {t('remoteConnect.assistEnd')}
          </button>
        </header>
        <div className="assist-stage">
          {waiting ? <p className="assist-wait">{hint}</p> : null}
          <canvas
            ref={canvasRef}
            className="assist-canvas"
            tabIndex={0}
            onContextMenu={(event) => event.preventDefault()}
            onMouseMove={(event) => {
              const p = pos(event)
              send([{ t: 'm', x: p.x, y: p.y, b: 0, d: 2 }])
            }}
            onMouseDown={(event) => {
              event.preventDefault()
              canvasRef.current?.focus()
              const p = pos(event)
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
        </div>
      </div>
    </div>,
    document.body,
  )
}
