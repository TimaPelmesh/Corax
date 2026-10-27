import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, llmLiveWebSocketUrl, type LlmCluster, type LlmNode } from '../api'
import { useLocale } from '../i18n/LocaleContext'

function gb(mb: number) {
  return `${(mb / 1024).toFixed(1)} GB`
}

export function LlmTopologyPage() {
  const { t } = useLocale()
  const [cluster, setCluster] = useState<LlmCluster | null>(null)

  useEffect(() => {
    let stop = false
    const pull = async () => {
      try {
        const snap = await api.llmCluster()
        if (!stop) setCluster(snap)
      } catch {
        /* the dashboard shows the error */
      }
    }
    void pull()
    const timer = window.setInterval(() => void pull(), 5000)
    let socket: WebSocket | null = null
    try {
      socket = new WebSocket(llmLiveWebSocketUrl())
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data)) as LlmCluster
          if (!stop && data?.nodes) setCluster(data)
        } catch {
          /* ignore */
        }
      }
    } catch {
      socket = null
    }
    return () => {
      stop = true
      window.clearInterval(timer)
      socket?.close()
    }
  }, [])

  const nodes = cluster?.nodes ?? []
  const central = nodes.find((node) => node.role === 'central') ?? nodes[0]
  const workers = nodes.filter((node) => node !== central)

  return (
    <div className="space-y-4">
      <Link className="text-sm text-[var(--color-fg-muted)]" to="/llm-cluster">
        {t('nav.llmCluster')}
      </Link>
      <p className="text-sm text-[var(--color-fg-muted)]">{t('llmCluster.flow')}</p>
      <div className="app-card overflow-auto p-4">
        <svg viewBox="0 0 760 420" className="h-auto w-full min-w-[640px]" role="img">
          {workers.map((worker, index) => {
            const y = 70 + index * 110
            return (
              <g key={worker.id}>
                <line x1="250" y1="190" x2="470" y2={y + 28} stroke="currentColor" strokeOpacity="0.35" />
                <text x="300" y={((190 + y + 28) / 2) - 6} className="fill-current text-[11px]" fontSize="11">
                  {worker.rpc.map((row) => row.port).filter(Boolean).join(', ') || 'rpc'}
                </text>
                <NodeBox x={470} y={y} node={worker} />
              </g>
            )
          })}
          {central ? <NodeBox x={40} y={150} node={central} /> : null}
        </svg>
        {!central ? <p className="text-sm text-[var(--color-fg-muted)]">{t('llmCluster.empty')}</p> : null}
      </div>
    </div>
  )
}

function NodeBox({ x, y, node }: { x: number; y: number; node: LlmNode }) {
  const vram = node.gpus.reduce((sum, gpu) => sum + (gpu.mem_total_mb || 0), 0)
  const label = node.role === 'central' ? 'llama-server' : 'rpc-server'
  return (
    <g>
      <rect x={x} y={y} width="240" height="78" rx="12" fill="none" stroke="currentColor" strokeOpacity="0.45" />
      <text x={x + 14} y={y + 24} fontSize="14" className="fill-current">
        {node.hostname}
      </text>
      <text x={x + 14} y={y + 44} fontSize="12" className="fill-current" opacity="0.7">
        {label} · {node.online ? 'online' : 'offline'}
      </text>
      <text x={x + 14} y={y + 62} fontSize="12" className="fill-current" opacity="0.7">
        {vram ? gb(vram) : 'VRAM —'}
      </text>
    </g>
  )
}
