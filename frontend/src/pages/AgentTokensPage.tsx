import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type AgentTokenCreated, type AgentTokenRow } from '../api'
import { useAuth } from '../AuthContext'
import { IconKey } from '../components/icons'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

export function AgentTokensPage() {
  const t = useT()
  const toast = useToast()
  const { user } = useAuth()
  const [rows, setRows] = useState<AgentTokenRow[]>([])
  const [loading, setLoading] = useState(true)
  const [label, setLabel] = useState('')
  const [allowedHostname, setAllowedHostname] = useState('')
  const [createdOnce, setCreatedOnce] = useState<AgentTokenCreated | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.agentTokens()
      setRows(data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault()
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
      toast.error(err instanceof Error ? err.message : t('common.error'))
    }
  }

  async function onRevoke(id: number) {
    if (!confirm(t('agentTokens.revokeConfirm'))) return
    try {
      await api.revokeAgentToken(id)
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    }
  }

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconKey className="h-7 w-7 text-blue-600" />
        </div>
        <div>
          <h1 className="page-title">{t('titles.agentTokens')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            {t('pages.agentTokensSubtitle')}
          </p>
        </div>
      </div>

      {createdOnce ? (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-neutral-900">
          <div className="font-medium">{t('agentTokens.saveNowTitle')}</div>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-white p-3 font-mono text-xs text-slate-800">
            {createdOnce.token}
          </pre>
          <button
            type="button"
            className="mt-2 text-sm font-medium text-blue-700 underline"
            onClick={() => void navigator.clipboard.writeText(createdOnce.token)}
          >
            {t('agentTokens.copyToken')}
          </button>
        </div>
      ) : null}

      <form onSubmit={onCreate} className="app-card mb-10 max-w-xl space-y-4 p-6 sm:p-7">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
          {t('agentTokens.newTokenTitle')}
        </h2>
        <div className="mt-4 space-y-3">
          <div>
            <label className="app-label">{t('agentTokens.labelLabel')}</label>
            <input
              className="app-input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('agentTokens.labelPlaceholder')}
            />
          </div>
          <div>
            <label className="app-label">{t('agentTokens.hostnameLabel')}</label>
            <input
              className="app-input"
              value={allowedHostname}
              onChange={(e) => setAllowedHostname(e.target.value)}
              placeholder={t('agentTokens.hostnamePlaceholder')}
            />
          </div>
          <button
            type="submit"
            className="app-btn app-btn-primary"
          >
            {t('agentTokens.createToken')}
          </button>
        </div>
      </form>

      <h2 className="mb-3 text-sm font-semibold text-slate-900">{t('agentTokens.allTokensTitle')}</h2>
      {loading ? (
        <p className="text-sm text-slate-500">{t('common.loading')}</p>
      ) : (
        <div className="app-card overflow-hidden p-0">
          <div className="overflow-x-auto overscroll-x-contain">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="app-table-head">
                <th className="px-4 py-3">{t('agentTokens.tableId')}</th>
                <th className="px-4 py-3">{t('agentTokens.tablePrefix')}</th>
                <th className="px-4 py-3">{t('agentTokens.tableLabel')}</th>
                <th className="px-4 py-3">{t('agentTokens.tableHostname')}</th>
                <th className="px-4 py-3">{t('agentTokens.tableCreated')}</th>
                <th className="px-4 py-3">{t('agentTokens.tableLastUsed')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="app-table-row border-b border-neutral-100 last:border-0">
                  <td className="px-4 py-3 font-mono text-xs">{r.id}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{r.public_id_prefix}</td>
                  <td className="px-4 py-3 text-slate-700">{r.label ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-700">{r.allowed_hostname ?? t('agentTokens.anyHostname')}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                    {r.last_used_at ? new Date(r.last_used_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {r.revoked_at ? (
                      <span className="text-xs text-slate-400">
                        {t('agentTokens.revokedOn', {
                          date: new Date(r.revoked_at).toLocaleDateString(),
                        })}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="text-sm font-medium text-blue-600 hover:text-blue-700"
                        onClick={() => void onRevoke(r.id)}
                      >
                        {t('agentTokens.revokeAction')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 ? <p className="p-4 text-sm text-slate-500">{t('agentTokens.emptyState')}</p> : null}
          </div>
        </div>
      )}
    </div>
  )
}
