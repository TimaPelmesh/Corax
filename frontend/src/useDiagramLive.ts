import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { diagramLiveWebSocketUrl } from './api'

export type DiagramLivePeer = {
  user_id: number
  username: string
  full_name: string | null
}

export type DiagramLiveIconDrag = {
  user_id: number
  icons: Array<{ id: string; x: number; y: number }>
}

const ECHO_IGNORE_MS = 650
/** Быстрая подтяжка чужого сохранения после WS. */
const REMOTE_LAYOUT_DEBOUNCE_MS = 45

function parseIconDragMessage(o: Record<string, unknown>): DiagramLiveIconDrag | null {
  if (typeof o.user_id !== 'number' || !Number.isFinite(o.user_id)) return null
  const raw = o.icons
  if (!Array.isArray(raw) || !raw.length) return null
  const icons: Array<{ id: string; x: number; y: number }> = []
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue
    const r = it as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id.trim()) continue
    const x = Number(r.x)
    const y = Number(r.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    icons.push({ id: r.id.trim(), x, y })
  }
  return icons.length ? { user_id: o.user_id, icons } : null
}

export function useDiagramLive(params: {
  diagramId: number | null
  enabled: boolean
  saveState: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
  autosaveInFlightRef: MutableRefObject<boolean>
  lastLocalCommitAtRef: MutableRefObject<number>
  refetchLayout: () => Promise<void>
  onRemoteIconDragRef?: MutableRefObject<((p: DiagramLiveIconDrag) => void) | null>
}) {
  const { diagramId, enabled, saveState, autosaveInFlightRef, lastLocalCommitAtRef, refetchLayout, onRemoteIconDragRef } =
    params

  const [liveConnected, setLiveConnected] = useState(false)
  const [peers, setPeers] = useState<DiagramLivePeer[]>([])

  const wsRef = useRef<WebSocket | null>(null)
  const pingRef = useRef<number | null>(null)
  const reconnectRef = useRef<number | null>(null)
  const remoteLayoutTimerRef = useRef<number | null>(null)

  const saveStateRef = useRef(saveState)
  useEffect(() => {
    saveStateRef.current = saveState
  }, [saveState])

  const connect = useCallback(() => {
    if (!diagramId || !enabled) return
    const url = diagramLiveWebSocketUrl(diagramId)
    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.onopen = () => {
      setLiveConnected(true)
      if (pingRef.current) window.clearInterval(pingRef.current)
      pingRef.current = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'ping' }))
          } catch {
            /* ignore */
          }
        }
      }, 25_000)
    }
    ws.onclose = () => {
      setLiveConnected(false)
      if (pingRef.current) {
        window.clearInterval(pingRef.current)
        pingRef.current = null
      }
      wsRef.current = null
      if (!enabled || !diagramId) return
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current)
      reconnectRef.current = window.setTimeout(() => connect(), 2500)
    }
    ws.onerror = () => {
      ws.close()
    }
    ws.onmessage = (ev) => {
      let data: unknown
      try {
        data = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (!data || typeof data !== 'object') return
      const o = data as Record<string, unknown>
      if (o.type === 'presence' && Array.isArray(o.peers)) {
        setPeers(o.peers as DiagramLivePeer[])
        return
      }
      if (o.type === 'layout_changed') {
        const since = Date.now() - lastLocalCommitAtRef.current
        if (since < ECHO_IGNORE_MS) return
        if (remoteLayoutTimerRef.current) window.clearTimeout(remoteLayoutTimerRef.current)
        remoteLayoutTimerRef.current = window.setTimeout(() => {
          remoteLayoutTimerRef.current = null
          const dirty = saveStateRef.current === 'dirty' || autosaveInFlightRef.current
          if (dirty) return
          void refetchLayout()
        }, REMOTE_LAYOUT_DEBOUNCE_MS)
        return
      }
      if (o.type === 'icon_drag') {
        const parsed = parseIconDragMessage(o)
        if (parsed) onRemoteIconDragRef?.current?.(parsed)
        return
      }
    }
  }, [autosaveInFlightRef, diagramId, enabled, lastLocalCommitAtRef, onRemoteIconDragRef, refetchLayout])

  const sendIconDrag = useCallback((icons: Array<{ id: string; x: number; y: number }>) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !icons.length) return
    try {
      ws.send(JSON.stringify({ type: 'icon_drag', icons }))
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    if (!diagramId || !enabled) {
      if (remoteLayoutTimerRef.current) {
        window.clearTimeout(remoteLayoutTimerRef.current)
        remoteLayoutTimerRef.current = null
      }
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      setLiveConnected(false)
      setPeers([])
      return
    }
    connect()
    return () => {
      if (remoteLayoutTimerRef.current) {
        window.clearTimeout(remoteLayoutTimerRef.current)
        remoteLayoutTimerRef.current = null
      }
      if (reconnectRef.current) {
        window.clearTimeout(reconnectRef.current)
        reconnectRef.current = null
      }
      if (pingRef.current) {
        window.clearInterval(pingRef.current)
        pingRef.current = null
      }
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [connect, diagramId, enabled])

  return { liveConnected, peers, sendIconDrag }
}
