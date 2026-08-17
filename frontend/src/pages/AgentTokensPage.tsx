import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type AgentTokenCreated, type AgentTokenRow } from '../api'
import { useAuth } from '../AuthContext'
import { IconKey } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { TableSkeleton } from '../components/Skeleton'
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
      <PageHeader
        icon={<IconKey className="h-7 w-7" />}
        title={t('titles.agentTokens')}
        subtitle={t('pages.agentTokensSubtitle')}
      />

      {createdOnce ? (
        <div className="app-alert app-alert-warning mb-6 text-sm">
          <div className="font-medium">{t('agentTokens.saveNowTitle')}</div>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--color-surface)] p-3 font-mono text-xs text-[var(--color-fg)]">
            {createdOnce.token}
          </pre>
          <button
            type="button"
            className="mt-2 text-sm font-medium text-[var(--color-primary)] underline"
            onClick={() => void navigator.clipboard.writeText(createdOnce.token)}
          >
            {t('agentTokens.copyToken')}
          </button>
        </div>
      ) : null}

      <form onSubmit={onCreate} className="app-card mb-10 max-w-xl space-y-4 p-6 sm:p-7">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
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

      <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">{t('agentTokens.allTokensTitle')}</h2>
      {loading ? (
        <div className="app-card overflow-hidden p-0">
          <TableSkeleton rows={6} cols={5} />
        </div>
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
                <tr key={r.id} className="app-table-row border-b border-[var(--color-border)] last:border-0">
                  <td className="px-4 py-3 font-mono text-xs">{r.id}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--color-fg-muted)]">{r.public_id_prefix}</td>
                  <td className="px-4 py-3 text-[var(--color-fg)]">{r.label ?? '—'}</td>
                  <td className="px-4 py-3 text-[var(--color-fg)]">{r.allowed_hostname ?? t('agentTokens.anyHostname')}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-[var(--color-fg-muted)]">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-[var(--color-fg-muted)]">
                    {r.last_used_at ? new Date(r.last_used_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {r.revoked_at ? (
                      <span className="text-xs text-[var(--color-fg-subtle)]">
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
          {rows.length === 0 ? <p className="p-4 text-sm text-[var(--color-fg-muted)]">{t('agentTokens.emptyState')}</p> : null}
          </div>
        </div>
      )}
    </div>
  )
}
