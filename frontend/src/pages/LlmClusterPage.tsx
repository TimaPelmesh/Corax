import { CategoryScale, Chart as ChartJS, Filler, Legend, LinearScale, LineElement, PointElement, Tooltip } from 'chart.js'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Line } from 'react-chartjs-2'
import { Link } from 'react-router-dom'
import { api, llmLiveWebSocketUrl, type LlmAuditRow, type LlmCluster, type LlmNode } from '../api'
import { useAuth } from '../AuthContext'
import { useLocale } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler)

function gb(mb: number | null | undefined) {
  if (mb == null || !Number.isFinite(mb)) return '—'
  return `${(mb / 1024).toFixed(1)} GB`
}

function num(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toFixed(digits)
}

export function LlmClusterPage() {
  const { t } = useLocale()
  const { user } = useAuth()
  const toast = useToast()
  const canManage = !!user && (user.is_superuser || user.role === 'editor' || user.role === 'llm-operator')
  const [cluster, setCluster] = useState<LlmCluster | null>(null)
  const [audit, setAudit] = useState<LlmAuditRow[]>([])
  const [hosts, setHosts] = useState<Array<{ id: number; hostname: string }>>([])
  const [error, setError] = useState('')
  const [hostId, setHostId] = useState(0)
  const [role, setRole] = useState('central')
  const [metricsUrl, setMetricsUrl] = useState('')
  const [chatUrl, setChatUrl] = useState('')
  const [modelDir, setModelDir] = useState('/models')
  const [ports, setPorts] = useState('50052,50053')
  const [logText, setLogText] = useState('')
  const [draft, setDraft] = useState<Record<number, { model: string; ngl: string; rpc: string; flash: boolean; metrics: boolean; ctx: string; port: string }>>({})

  const load = useCallback(async () => {
    try {
      const [snap, rows] = await Promise.all([api.llmCluster(), api.llmAudit()])
      setCluster(snap)
      setAudit(rows)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'))
    }
  }, [t])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    let socket: WebSocket | null = null
    try {
      socket = new WebSocket(llmLiveWebSocketUrl())
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data)) as LlmCluster
          if (data && Array.isArray(data.nodes)) setCluster(data)
        } catch {
          /* ignore a bad frame */
        }
      }
    } catch {
      socket = null
    }
    return () => {
      window.clearInterval(timer)
      socket?.close()
    }
  }, [load])

  useEffect(() => {
    if (!canManage) return
    void api.llmAuditHosts().then((rows) => {
      setHosts(rows.map((row) => ({ id: row.id, hostname: row.hostname })))
      setHostId((current) => current || rows[0]?.id || 0)
    }).catch(() => setHosts([]))
  }, [canManage])

  const chart = useMemo(() => {
    const series = cluster?.series ?? []
    return {
      labels: series.map((point) => (point.t ? point.t.slice(11, 19) : '')),
      datasets: [
        {
          label: t('llmCluster.generate'),
          data: series.map((point) => point.predicted_tokens_seconds),
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,0.12)',
          fill: true,
          pointRadius: 0,
          tension: 0.25,
        },
        {
          label: t('llmCluster.prompt'),
          data: series.map((point) => point.prompt_tokens_seconds),
          borderColor: '#0ea5e9',
          pointRadius: 0,
          tension: 0.25,
        },
      ],
    }
  }, [cluster?.series, t])

  async function queue(node: LlmNode, action: string, target = '', body?: string | null) {
    try {
      await api.llmJob(node.id, { action, target, body })
      toast.ok(t('llmCluster.queued'))
      if (action === 'journal') {
        window.setTimeout(async () => {
          const jobs = await api.llmJobs(node.id)
          const hit = jobs.find((job) => job.action === 'journal' && job.output)
          setLogText(hit?.output || jobs[0]?.output || '')
        }, 4000)
      }
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'))
    }
  }

  function formOf(node: LlmNode) {
    return (
      draft[node.id] ?? {
        model: node.model || node.models[0]?.path || '',
        ngl: '99',
        rpc: '',
        flash: true,
        metrics: true,
        ctx: '4096',
        port: '8080',
      }
    )
  }

  function patchDraft(node: LlmNode, patch: Partial<ReturnType<typeof formOf>>) {
    setDraft((current) => ({ ...current, [node.id]: { ...formOf(node), ...patch } }))
  }

  async function apply(node: LlmNode) {
    const form = formOf(node)
    const body = JSON.stringify({
      model: form.model,
      ngl: Number(form.ngl),
      rpc: form.rpc || undefined,
      flash_attn: form.flash,
      metrics: form.metrics,
      ctx: Number(form.ctx),
      port: Number(form.port),
      listen: '0.0.0.0',
    })
    await queue(node, 'llama-apply', 'llama-server', body)
  }

  async function addNode() {
    try {
      await api.saveLlmNode({
        host_id: hostId,
        role,
        metrics_url: metricsUrl || null,
        chat_base_url: chatUrl || null,
        rpc_ports: ports,
        model_dir: modelDir,
      })
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'))
    }
  }

  const agg = cluster?.aggregate

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2 text-sm">
          <Link className="app-btn app-btn-secondary !min-h-0 !px-3 !py-1" to="/llm-cluster/topology">
            {t('nav.llmTopology')}
          </Link>
          <Link className="app-btn app-btn-secondary !min-h-0 !px-3 !py-1" to="/llm-cluster/chat">
            {t('nav.llmChat')}
          </Link>
        </div>
        {canManage ? (
          <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-1" onClick={() => void api.llmScrape().then(() => load())}>
            {t('common.refresh')}
          </button>
        ) : null}
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={t('llmCluster.online')} value={`${agg?.nodes_online ?? 0} / ${agg?.nodes_total ?? 0}`} />
        <Stat label={t('llmCluster.pool')} value={`${gb(agg?.vram_used_mb)} / ${gb(agg?.vram_total_mb)}`} />
        <Stat label={t('llmCluster.model')} value={agg?.model || '—'} />
        <Stat
          label={t('llmCluster.speed')}
          value={`${num(agg?.predicted_tokens_seconds, 1)} t/s · ${
            agg?.status === 'ok' ? t('llmCluster.statusOk') : agg?.status === 'degraded' ? t('llmCluster.statusDegraded') : t('llmCluster.statusDown')
          }`}
        />
      </div>
      <div className="app-card p-4">
        <h2 className="mb-2 text-sm font-medium text-[var(--color-fg)]">{t('llmCluster.speed')}</h2>
        <div className="h-48">
          <Line
            data={chart}
            options={{
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: true, position: 'bottom' } },
              scales: { x: { type: 'category', display: true }, y: { type: 'linear', beginAtZero: true } },
            }}
          />
        </div>
      </div>
      {(cluster?.nodes ?? []).length === 0 ? <p className="text-sm text-[var(--color-fg-muted)]">{t('llmCluster.empty')}</p> : null}
      <div className="grid gap-3 xl:grid-cols-2">
        {(cluster?.nodes ?? []).map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            canManage={canManage}
            form={formOf(node)}
            onPatch={(patch) => patchDraft(node, patch)}
            onQueue={(action, target, body) => void queue(node, action, target, body)}
            onApply={() => void apply(node)}
            onRemove={() => void api.deleteLlmNode(node.id).then(() => load())}
            series={node.gpu_series ?? []}
          />
        ))}
      </div>
      {logText ? (
        <div className="app-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium">{t('llmCluster.logTitle')}</h2>
            <button type="button" className="text-xs text-[var(--color-fg-muted)]" onClick={() => setLogText('')}>
              {t('llmCluster.close')}
            </button>
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs text-[var(--color-fg)]">{logText}</pre>
        </div>
      ) : null}
      {canManage ? (
        <form
          className="app-card grid gap-3 p-4 md:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault()
            void addNode()
          }}
        >
          <label className="text-sm">
            <span className="app-label">{t('llmCluster.host')}</span>
            <select className="app-input" value={hostId} onChange={(event) => setHostId(Number(event.target.value))}>
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.hostname}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="app-label">{t('llmCluster.role')}</span>
            <select className="app-input" value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="central">{t('llmCluster.central')}</option>
              <option value="worker">{t('llmCluster.worker')}</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="app-label">{t('llmCluster.ports')}</span>
            <input className="app-input" value={ports} onChange={(event) => setPorts(event.target.value)} />
          </label>
          <label className="text-sm md:col-span-2">
            <span className="app-label">{t('llmCluster.metricsUrl')}</span>
            <input className="app-input" value={metricsUrl} placeholder="http://host:8080/metrics" onChange={(event) => setMetricsUrl(event.target.value)} />
          </label>
          <label className="text-sm">
            <span className="app-label">{t('llmCluster.modelDir')}</span>
            <input className="app-input" value={modelDir} onChange={(event) => setModelDir(event.target.value)} />
          </label>
          <label className="text-sm md:col-span-2">
            <span className="app-label">{t('llmCluster.chatUrl')}</span>
            <input className="app-input" value={chatUrl} placeholder="http://host:8080" onChange={(event) => setChatUrl(event.target.value)} />
          </label>
          <div className="flex items-end">
            <button type="submit" className="app-btn app-btn-primary" disabled={!hostId}>
              {t('llmCluster.save')}
            </button>
          </div>
        </form>
      ) : null}
      <div className="app-card overflow-auto p-4">
        <h2 className="mb-2 text-sm font-medium">{t('llmCluster.audit')}</h2>
        <table className="w-full text-left text-xs">
          <tbody>
            {audit.map((row) => (
              <tr key={row.id} className="border-t border-[var(--color-border)]">
                <td className="py-1 pr-3">{row.created_at?.replace('T', ' ').slice(0, 19)}</td>
                <td className="py-1 pr-3">{row.username}</td>
                <td className="py-1 pr-3">{row.action}</td>
                <td className="py-1 pr-3">{row.target}</td>
                <td className="py-1 text-[var(--color-fg-muted)]">{JSON.stringify(row.params)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Spark({ values }: { values: Array<number | null> }) {
  const nums = values.filter((value): value is number => value != null && Number.isFinite(value))
  if (nums.length < 2) return null
  const max = Math.max(100, ...nums)
  const width = 120
  const height = 28
  const d = nums
    .map((value, index) => {
      const x = (index / (nums.length - 1)) * width
      const y = height - (value / max) * (height - 2) - 1
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-1 h-7 w-full" aria-hidden>
      <path d={d} fill="none" stroke="#2563eb" strokeWidth="1.5" />
    </svg>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="app-card p-4">
      <div className="text-xs text-[var(--color-fg-muted)]">{label}</div>
      <div className="mt-1 truncate text-lg font-medium text-[var(--color-fg)]">{value}</div>
    </div>
  )
}

function NodeCard({
  node,
  canManage,
  form,
  onPatch,
  onQueue,
  onApply,
  onRemove,
  series,
}: {
  node: LlmNode
  canManage: boolean
  form: { model: string; ngl: string; rpc: string; flash: boolean; metrics: boolean; ctx: string; port: string }
  onPatch: (patch: Partial<typeof form>) => void
  onQueue: (action: string, target?: string, body?: string | null) => void
  onApply: () => void
  onRemove: () => void
  series: LlmCluster['gpu_series']
}) {
  const { t } = useLocale()
  const units = ['llama-server', 'rpc-server-gpu0', 'rpc-server-gpu1']
  return (
    <section className="app-card space-y-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-medium text-[var(--color-fg)]">
            {node.hostname}{' '}
            <span className="text-xs font-normal text-[var(--color-fg-muted)]">
              {node.role === 'central' ? t('llmCluster.central') : t('llmCluster.worker')} · {node.online ? t('llmCluster.online') : t('llmCluster.offline')}
            </span>
          </h2>
          <p className="text-xs text-[var(--color-fg-muted)]">{node.ip_address || '—'}</p>
        </div>
        {canManage ? (
          <button type="button" className="text-xs text-[var(--color-fg-muted)]" onClick={onRemove}>
            {t('llmCluster.remove')}
          </button>
        ) : null}
      </div>
      <p className="text-sm">
        {t('llmCluster.layers')}: {node.layers.local_layers ?? '—'}
        {node.layers.total_layers != null ? ` / ${node.layers.total_layers}` : ''}{' '}
        <span className="text-xs text-[var(--color-fg-muted)]">
          {t('llmCluster.source')}: {node.layers.source}
          {node.layers.remote_layers != null ? ` · remote ${node.layers.remote_layers}` : ''}
        </span>
      </p>
      {node.layers.detail ? <p className="text-xs text-[var(--color-fg-muted)]">{node.layers.detail}</p> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {node.gpus.length === 0 ? <p className="text-xs text-[var(--color-fg-muted)]">{t('llmCluster.noGpu')}</p> : null}
        {node.gpus.map((gpu) => (
            <div key={gpu.index} className="rounded-xl border border-[var(--color-border)] p-2 text-xs">
              <div className="font-medium">
                GPU {gpu.index} {gpu.name}
              </div>
              <div>
                {t('llmCluster.vram')} {gb(gpu.mem_used_mb)} / {gb(gpu.mem_total_mb)} {t('llmCluster.contrib')}
              </div>
              <div>
                {num(gpu.util_percent, 0)}% · {num(gpu.temp_c, 0)}° · {num(gpu.power_w, 0)} W
              </div>
              <Spark values={series.filter((point) => point.index === gpu.index).map((point) => point.util_percent)} />
            </div>
          ))}
      </div>
      <div className="text-xs">
        {t('llmCluster.rpc')}:{' '}
        {node.rpc.map((row) => (
          <span key={row.port} className="mr-2">
            {row.unit}:{row.port}{' '}
            {row.listening == null ? t('llmCluster.unknown') : row.listening ? t('llmCluster.listening') : t('llmCluster.closed')}
            {' · '}
            {row.active ? t('llmCluster.active') : t('llmCluster.inactive')}
            {row.vram_total_mb ? ` · ${gb(row.vram_total_mb)}` : ''}
          </span>
        ))}
      </div>
      {canManage ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {units.map((unit) => (
              <span key={unit} className="flex gap-1">
                <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-2 !py-1 !text-xs" onClick={() => onQueue('start', unit)}>
                  {t('llmCluster.start')} {unit}
                </button>
                <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-2 !py-1 !text-xs" onClick={() => onQueue('stop', unit)}>
                  {t('llmCluster.stop')}
                </button>
                <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-2 !py-1 !text-xs" onClick={() => onQueue('restart', unit)}>
                  {t('llmCluster.restart')}
                </button>
                <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-2 !py-1 !text-xs" onClick={() => onQueue('journal', unit, '80')}>
                  {t('llmCluster.logs')}
                </button>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-2 !py-1 !text-xs" onClick={() => onQueue('models', node.model_dir)}>
              {t('llmCluster.models')}
            </button>
            <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-2 !py-1 !text-xs" onClick={() => onQueue('rpc-probe', 'rpc')}>
              {t('llmCluster.probe')}
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs">
              {t('llmCluster.pickModel')}
              <input className="app-input mt-1" list={`models-${node.id}`} value={form.model} onChange={(event) => onPatch({ model: event.target.value })} />
              <datalist id={`models-${node.id}`}>
                {node.models.map((model) => (
                  <option key={model.path} value={model.path}>
                    {model.name || model.path}
                  </option>
                ))}
              </datalist>
            </label>
            <label className="text-xs">
              {t('llmCluster.ngl')}
              <input className="app-input mt-1" value={form.ngl} onChange={(event) => onPatch({ ngl: event.target.value })} />
            </label>
            <label className="text-xs sm:col-span-2">
              {t('llmCluster.rpcFlag')}
              <input className="app-input mt-1" value={form.rpc} placeholder="10.0.0.2:50052,10.0.0.3:50053" onChange={(event) => onPatch({ rpc: event.target.value })} />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={form.flash} onChange={(event) => onPatch({ flash: event.target.checked })} />
              {t('llmCluster.flash')}
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={form.metrics} onChange={(event) => onPatch({ metrics: event.target.checked })} />
              {t('llmCluster.metricsFlag')}
            </label>
            <label className="text-xs">
              {t('llmCluster.ctx')}
              <input className="app-input mt-1" value={form.ctx} onChange={(event) => onPatch({ ctx: event.target.value })} />
            </label>
            <label className="text-xs">
              {t('llmCluster.port')}
              <input className="app-input mt-1" value={form.port} onChange={(event) => onPatch({ port: event.target.value })} />
            </label>
          </div>
          <button type="button" className="app-btn app-btn-primary !min-h-0 !px-3 !py-1 !text-xs" onClick={onApply} disabled={!form.model}>
            {t('llmCluster.apply')}
          </button>
        </div>
      ) : null}
    </section>
  )
}
