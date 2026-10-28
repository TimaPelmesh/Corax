import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type AgentPairingRow, type AgentTokenCreated, type AgentTokenRow } from '../api'
import { useAuth } from '../AuthContext'
import { useConfirmDialog } from '../components/ConfirmDialog'
import { IconKey } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { TableSkeleton } from '../components/Skeleton'
import { StatusPill } from '../components/ui/StatusPill'
import { useT } from '../i18n/LocaleContext'
import { activeAgentTokens } from '../lib/agentTokensUi'
import { useToast } from '../ToastContext'

export function AgentTokensPage() {
  const t = useT()
  const toast = useToast()
  const { user } = useAuth()
  const { ask, dialog } = useConfirmDialog()
  const [rows, setRows] = useState<AgentTokenRow[]>([])
  const [pending, setPending] = useState<AgentPairingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [allowedHostname, setAllowedHostname] = useState('')
  const [createdOnce, setCreatedOnce] = useState<AgentTokenCreated | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const [tokens, pairings] = await Promise.all([api.agentTokens(), api.agentPairings()])
      setRows(tokens)
      setPending(pairings)
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('common.error')
      setLoadError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void api.agentPairings().then(setPending).catch(() => undefined)
    }, 4000)
    return () => window.clearInterval(timer)
  }, [])

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
    const ok = await ask({
      title: t('agentTokens.revokeAction'),
      body: t('agentTokens.revokeConfirm'),
      confirmLabel: t('agentTokens.revokeAction'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.revokeAgentToken(id)
      setCreatedOnce((prev) => (prev && prev.id === id ? null : prev))
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    }
  }

  async function onRevokeAll() {
    const ok = await ask({
      title: t('agentTokens.revokeAll'),
      body: t('agentTokens.revokeAllConfirm'),
      confirmLabel: t('agentTokens.revokeAll'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      const result = await api.revokeAllAgentTokens()
      setCreatedOnce(null)
      toast.ok(t('agentTokens.revokeAllDone', { count: result.revoked }))
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    }
  }

  async function onApprove(id: number) {
    try {
      await api.approveAgentPairing(id)
      toast.ok(t('agentTokens.connected'))
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    }
  }

  async function onReject(id: number) {
    try {
      await api.rejectAgentPairing(id)
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    }
  }

  const active = activeAgentTokens(rows)

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
      {dialog}
      <PageHeader
        icon={<IconKey className="h-7 w-7" />}
        title={t('titles.agentTokens')}
        subtitle={t('pages.agentTokensSubtitle')}
      />

      {loadError && !loading ? (
        <section className="app-panel space-y-3">
          <p className="text-sm text-[var(--color-fg)]">{loadError}</p>
          <p className="text-xs text-[var(--color-fg-muted)]">{t('agentTokens.loadErrorHint')}</p>
          <button
            type="button"
            className="app-btn app-btn-primary w-full sm:w-auto"
            onClick={() => {
              setLoading(true)
              void load()
            }}
          >
            {t('common.refresh')}
          </button>
        </section>
      ) : null}

      <section className="app-panel">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[13px] font-semibold text-[var(--color-fg-subtle)]">
                {t('agentTokens.pendingTitle')}
              </h2>
              {pending.length > 0 ? (
                <StatusPill tone="warning">{t('agentTokens.pendingCount', { n: pending.length })}</StatusPill>
              ) : (
                <StatusPill tone="neutral">{t('agentTokens.pendingEmpty')}</StatusPill>
              )}
            </div>
            <p className="mt-1 max-w-2xl text-sm text-[var(--color-fg-muted)]">{t('agentTokens.pendingHint')}</p>
          </div>
        </div>
        {pending.length === 0 ? (
          <div className="app-empty-state mt-4 !py-6">{t('agentTokens.pendingEmpty')}</div>
        ) : (
          <ul className="mt-4 divide-y divide-[var(--color-border)]">
            {pending.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-3 py-3 first:pt-0 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="font-medium text-[var(--color-fg)]">{row.hostname}</div>
                  <div className="text-xs text-[var(--color-fg-muted)]">
                    {new Date(row.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                  <button
                    type="button"
                    className="app-btn app-btn-primary w-full !min-h-0 text-sm sm:w-auto"
                    onClick={() => void onApprove(row.id)}
                  >
                    {t('agentTokens.connect')}
                  </button>
                  <button
                    type="button"
                    className="app-btn app-btn-secondary w-full !min-h-0 text-sm sm:w-auto"
                    onClick={() => void onReject(row.id)}
                  >
                    {t('agentTokens.reject')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {createdOnce ? (
        <div className="app-alert app-alert-warning text-sm">
          <div className="font-medium">{t('agentTokens.saveNowTitle')}</div>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--color-surface)] p-3 font-mono text-xs text-[var(--color-fg)]">
            {createdOnce.token}
          </pre>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              className="app-btn app-btn-secondary w-full !min-h-0 text-sm sm:w-auto"
              onClick={() => void navigator.clipboard.writeText(createdOnce.token)}
            >
              {t('agentTokens.copyToken')}
            </button>
            <button
              type="button"
              className="app-btn app-btn-secondary w-full !min-h-0 text-sm sm:w-auto"
              onClick={() => setCreatedOnce(null)}
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      ) : null}

      <form onSubmit={onCreate} className="app-panel max-w-xl space-y-4">
        <h2 className="text-[13px] font-semibold text-[var(--color-fg-subtle)]">
          {t('agentTokens.newTokenTitle')}
        </h2>
        <div className="space-y-3">
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
          <button type="submit" className="app-btn app-btn-primary w-full sm:w-auto">
            {t('agentTokens.createToken')}
          </button>
        </div>
      </form>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('agentTokens.allTokensTitle')}</h2>
        <button
          type="button"
          className="app-btn app-btn-secondary w-full !min-h-0 text-sm sm:w-auto"
          disabled={active.length === 0}
          onClick={() => void onRevokeAll()}
        >
          {t('agentTokens.revokeAll')}
        </button>
      </div>
      {loading ? (
        <div className="app-card overflow-hidden p-0">
          <TableSkeleton rows={6} cols={5} />
        </div>
      ) : active.length === 0 ? (
        <div className="app-empty-state">{t('agentTokens.emptyState')}</div>
      ) : (
        <div className="app-card app-table-shell overflow-hidden p-0">
          <div className="overflow-x-auto overscroll-x-contain">
            <table className="app-table min-w-[40rem] w-full text-left text-sm">
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
                {active.map((r) => (
                  <tr key={r.id} className="app-table-row border-b border-[var(--color-border)] last:border-0">
                    <td className="app-table-cell font-mono text-xs">{r.id}</td>
                    <td className="app-table-cell-muted font-mono text-xs">{r.public_id_prefix}</td>
                    <td className="app-table-cell">{r.label ?? '—'}</td>
                    <td className="app-table-cell">{r.allowed_hostname ?? t('agentTokens.anyHostname')}</td>
                    <td className="app-table-cell-muted whitespace-nowrap">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="app-table-cell-muted whitespace-nowrap">
                      {r.last_used_at ? new Date(r.last_used_at).toLocaleString() : '—'}
                    </td>
                    <td className="app-table-cell text-right">
                      <button
                        type="button"
                        className="text-sm font-medium text-[var(--color-error-fg)] hover:underline"
                        onClick={() => void onRevoke(r.id)}
                      >
                        {t('agentTokens.revokeAction')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
