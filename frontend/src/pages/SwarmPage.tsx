import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type SwarmOverview, type SwarmService } from '../api'
import { useAuth } from '../AuthContext'
import { useConfirmDialog } from '../components/ConfirmDialog'
import { PageHeader } from '../components/PageHeader'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

function desiredReplicas(value: string): number {
  const part = value.includes('/') ? value.split('/')[1] : value
  const parsed = Number(part)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 32 ? parsed : 1
}

export function SwarmPage() {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirmDialog()
  const { user } = useAuth()
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [sshUser, setSshUser] = useState('root')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<SwarmOverview | null>(null)
  const [replicas, setReplicas] = useState<Record<string, string>>({})
  const [output, setOutput] = useState('')

  if (user && !user.is_superuser && user.role !== 'editor') {
    return <Navigate to="/" replace />
  }

  function login() {
    const sshPort = Number(port)
    return {
      host: host.trim(),
      ssh_port: sshPort,
      ssh_user: sshUser.trim(),
      ssh_password: password,
    }
  }

  function loginReady() {
    const sshPort = Number(port)
    return Boolean(host.trim() && sshUser.trim() && password && Number.isInteger(sshPort) && sshPort >= 1 && sshPort <= 65535)
  }

  function remember(next: SwarmOverview) {
    setView(next)
    setOutput(next.output || '')
    setReplicas((prev) => {
      const seeded: Record<string, string> = {}
      for (const service of next.services) {
        seeded[service.name] = prev[service.name] ?? String(desiredReplicas(service.replicas))
      }
      return seeded
    })
  }

  async function connect() {
    if (!loginReady()) {
      toast.error(t('swarm.needLogin'))
      return
    }
    setBusy(true)
    try {
      remember(await api.swarmOverview(login()))
    } catch (error) {
      setOutput(error instanceof Error ? error.message : t('common.error'))
      toast.error(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function scale(service: SwarmService) {
    const count = Number(replicas[service.name])
    if (!Number.isInteger(count) || count < 0 || count > 32) {
      toast.error(t('swarm.badReplicas'))
      return
    }
    const ok = await confirm.ask({
      title: t('swarm.scale'),
      body: t('swarm.confirmScale', { service: service.name, host: host.trim(), replicas: count }),
      confirmLabel: t('swarm.scale'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      const next = await api.swarmScale({ ...login(), service: service.name, replicas: count })
      remember({ ...next, swarm: view?.swarm || next.swarm, manager: view?.manager || next.manager, nodes: view?.nodes || next.nodes })
      toast.ok(t('swarm.scale'))
    } catch (error) {
      setOutput(error instanceof Error ? error.message : t('common.error'))
      toast.error(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function rollback(service: SwarmService) {
    const ok = await confirm.ask({
      title: t('swarm.rollback'),
      body: t('swarm.confirmRollback', { service: service.name, host: host.trim() }),
      confirmLabel: t('swarm.rollback'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      const next = await api.swarmRollback({ ...login(), service: service.name })
      remember({ ...next, swarm: view?.swarm || next.swarm, manager: view?.manager || next.manager, nodes: view?.nodes || next.nodes })
      toast.ok(t('swarm.rollback'))
    } catch (error) {
      setOutput(error instanceof Error ? error.message : t('common.error'))
      toast.error(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {confirm.dialog}
      <PageHeader title={t('nav.swarm')} subtitle={t('swarm.lead')} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs font-medium text-[var(--color-fg-subtle)]">
          {t('swarm.host')}
          <input className="app-input mt-1 font-mono" value={host} onChange={(event) => setHost(event.target.value)} placeholder="10.0.0.10" autoComplete="off" />
        </label>
        <label className="text-xs font-medium text-[var(--color-fg-subtle)]">
          {t('swarm.port')}
          <input className="app-input mt-1 font-mono" value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" />
        </label>
        <label className="text-xs font-medium text-[var(--color-fg-subtle)]">
          {t('swarm.user')}
          <input className="app-input mt-1 font-mono" value={sshUser} onChange={(event) => setSshUser(event.target.value)} autoComplete="off" />
        </label>
        <label className="text-xs font-medium text-[var(--color-fg-subtle)]">
          {t('swarm.password')}
          <input className="app-input mt-1" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
        </label>
      </div>
      <div>
        <button type="button" className="app-btn app-btn-primary" disabled={busy || !loginReady()} onClick={() => void connect()}>
          {busy ? t('swarm.connecting') : t('swarm.connect')}
        </button>
      </div>
      {view ? (
        <p className="text-sm text-[var(--color-fg-muted)]">
          {t('swarm.swarmState')}: <span className="font-medium text-[var(--color-fg)]">{view.swarm || '—'}</span>
          {' · '}
          {view.manager ? t('swarm.manager') : t('swarm.worker')}
        </p>
      ) : null}
      {view ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">{t('swarm.nodes')}</h2>
          {view.nodes.length === 0 ? (
            <p className="text-sm text-[var(--color-fg-muted)]">{t('swarm.emptyNodes')}</p>
          ) : (
            <div className="app-scroll overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="text-xs text-[var(--color-fg-subtle)]">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">{t('swarm.hostname')}</th>
                    <th className="px-2 py-1.5 font-medium">{t('swarm.status')}</th>
                    <th className="px-2 py-1.5 font-medium">{t('swarm.availability')}</th>
                    <th className="px-2 py-1.5 font-medium">{t('swarm.role')}</th>
                    <th className="px-2 py-1.5 font-medium">{t('swarm.engine')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.nodes.map((node) => (
                    <tr key={node.id || node.hostname} className="border-t border-[var(--color-border)]">
                      <td className="px-2 py-1.5 font-medium">{node.hostname}</td>
                      <td className="px-2 py-1.5">{node.status}</td>
                      <td className="px-2 py-1.5">{node.availability}</td>
                      <td className="px-2 py-1.5">{node.manager || '—'}</td>
                      <td className="px-2 py-1.5 font-mono text-xs">{node.engine}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
      {view ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">{t('swarm.services')}</h2>
          {view.services.length === 0 ? (
            <p className="text-sm text-[var(--color-fg-muted)]">{t('swarm.emptyServices')}</p>
          ) : (
            <div className="app-scroll overflow-x-auto">
              <table className="w-full min-w-[52rem] text-left text-sm">
                <thead className="text-xs text-[var(--color-fg-subtle)]">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">{t('swarm.hostname')}</th>
                    <th className="px-2 py-1.5 font-medium">{t('swarm.mode')}</th>
                    <th className="px-2 py-1.5 font-medium">{t('swarm.replicas')}</th>
                    <th className="px-2 py-1.5 font-medium">{t('swarm.image')}</th>
                    <th className="px-2 py-1.5 font-medium">{t('swarm.ports')}</th>
                    <th className="px-2 py-1.5 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {view.services.map((service) => (
                    <tr key={service.id || service.name} className="border-t border-[var(--color-border)]">
                      <td className="px-2 py-1.5 font-medium">{service.name}</td>
                      <td className="px-2 py-1.5">{service.mode}</td>
                      <td className="px-2 py-1.5">
                        <span className="mr-2 font-mono text-xs text-[var(--color-fg-subtle)]">{service.replicas}</span>
                        <input
                          className="app-input w-16 font-mono"
                          value={replicas[service.name] ?? ''}
                          inputMode="numeric"
                          onChange={(event) => setReplicas((prev) => ({ ...prev, [service.name]: event.target.value }))}
                        />
                      </td>
                      <td className="max-w-[16rem] truncate px-2 py-1.5 font-mono text-xs" title={service.image}>
                        {service.image}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-xs">{service.ports || '—'}</td>
                      <td className="px-2 py-1.5">
                        <div className="flex gap-2">
                          <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => void scale(service)}>
                            {t('swarm.scale')}
                          </button>
                          <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => void rollback(service)}>
                            {t('swarm.rollback')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
      {output ? (
        <section>
          <h2 className="mb-1 text-xs font-medium text-[var(--color-fg-subtle)]">{t('swarm.output')}</h2>
          <pre className="app-scroll max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 font-mono text-xs">
            {output}
          </pre>
        </section>
      ) : null}
    </div>
  )
}
