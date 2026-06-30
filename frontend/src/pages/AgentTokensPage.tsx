import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type AgentTokenCreated, type AgentTokenRow } from '../api'
import { useAuth } from '../AuthContext'
import { IconKey } from '../components/icons'

export function AgentTokensPage() {
  const { user } = useAuth()
  const [rows, setRows] = useState<AgentTokenRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [allowedHostname, setAllowedHostname] = useState('')
  const [createdOnce, setCreatedOnce] = useState<AgentTokenCreated | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const data = await api.agentTokens()
      setRows(data)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    setCreatedOnce(null)
    try {
      const row = await api.createAgentToken({
        label: label || null,
        allowed_hostname: allowedHostname.trim() || null,
      })
      setCreatedOnce(row)
      setLabel('')
      setAllowedHostname('')
      void load()
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Ошибка')
    }
  }

  async function onRevoke(id: number) {
    if (!confirm('Отозвать токен? Агенты с этим ключом перестанут проходить авторизацию.')) return
    setErr(null)
    try {
      await api.revokeAgentToken(id)
      void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка')
    }
  }

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconKey className="h-7 w-7 text-red-600" />
        </div>
        <div>
          <h1 className="page-title">Токены агентов</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Отдельный ключ на машину или группу. В заголовке агента:{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">Authorization: Bearer &lt;public_id&gt;.&lt;secret&gt;</code>
            . Общий секрет из <code className="text-xs">AGENT_TOKEN</code> в .env по-прежнему поддерживается.
          </p>
        </div>
      </div>

      {createdOnce ? (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-neutral-900">
          <div className="font-medium">Сохраните токен сейчас — он больше не будет показан:</div>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-white p-3 font-mono text-xs text-slate-800">
            {createdOnce.token}
          </pre>
          <button
            type="button"
            className="mt-2 text-sm font-medium text-red-700 underline"
            onClick={() => void navigator.clipboard.writeText(createdOnce.token)}
          >
            Копировать
          </button>
        </div>
      ) : null}

      {err ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
      ) : null}

      <form onSubmit={onCreate} className="app-card mb-10 max-w-xl space-y-4 p-6 sm:p-7">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Новый токен</h2>
        <div className="mt-4 space-y-3">
          <div>
            <label className="app-label">Подпись (необязательно)</label>
            <input
              className="app-input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Например: бухгалтерия, ноутбук Иванова"
            />
          </div>
          <div>
            <label className="app-label">Только для hostname (необязательно)</label>
            <input
              className="app-input"
              value={allowedHostname}
              onChange={(e) => setAllowedHostname(e.target.value)}
              placeholder="DESKTOP-ABC — если пусто, принимается любой hostname"
            />
          </div>
          <button
            type="submit"
            className="app-btn app-btn-primary"
          >
            Создать токен
          </button>
        </div>
      </form>

      <h2 className="mb-3 text-sm font-semibold text-slate-900">Все токены</h2>
      {loading ? (
        <p className="text-sm text-slate-500">Загрузка…</p>
      ) : (
        <div className="app-card overflow-hidden p-0">
          <div className="overflow-x-auto overscroll-x-contain">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="app-table-head">
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">Префикс</th>
                <th className="px-4 py-3">Подпись</th>
                <th className="px-4 py-3">Hostname</th>
                <th className="px-4 py-3">Создан</th>
                <th className="px-4 py-3">Последнее использование</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="app-table-row border-b border-neutral-100 last:border-0">
                  <td className="px-4 py-3 font-mono text-xs">{r.id}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{r.public_id_prefix}</td>
                  <td className="px-4 py-3 text-slate-700">{r.label ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-700">{r.allowed_hostname ?? 'любой'}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                    {r.last_used_at ? new Date(r.last_used_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {r.revoked_at ? (
                      <span className="text-xs text-slate-400">отозван {new Date(r.revoked_at).toLocaleDateString()}</span>
                    ) : (
                      <button
                        type="button"
                        className="text-sm font-medium text-red-600 hover:text-red-700"
                        onClick={() => void onRevoke(r.id)}
                      >
                        Отозвать
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 ? <p className="p-4 text-sm text-slate-500">Пока нет токенов</p> : null}
          </div>
        </div>
      )}
    </div>
  )
}
