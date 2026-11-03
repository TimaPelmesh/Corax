import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import {
  api,
  type SwarmHostRow,
  type SwarmJoinToken,
  type SwarmOverview,
  type SwarmRole,
  type SwarmService,
} from '../api'
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

function roleLabel(t: (key: string) => string, role: string) {
  return role === 'manager' ? t('swarm.roleManager') : t('swarm.roleWorker')
}

export function SwarmPage() {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirmDialog()
  const { user } = useAuth()
  const [hosts, setHosts] = useState<SwarmHostRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [passwords, setPasswords] = useState<Record<number, string>>({})
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [view, setView] = useState<SwarmOverview | null>(null)
  const [replicas, setReplicas] = useState<Record<string, string>>({})
  const [output, setOutput] = useState('')
  const [joinToken, setJoinToken] = useState<SwarmJoinToken | null>(null)

  const [label, setLabel] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [sshUser, setSshUser] = useState('root')
  const [role, setRole] = useState<SwarmRole>('worker')
  const [advertise, setAdvertise] = useState('')
  const [newPassword, setNewPassword] = useState('')

  const selected = useMemo(() => hosts.find((row) => row.id === selectedId) ?? null, [hosts, selectedId])
  const managers = useMemo(() => hosts.filter((row) => row.role === 'manager'), [hosts])

  const refreshHosts = useCallback(async () => {
    const rows = await api.swarmHosts()
    setHosts(rows)
    setSelectedId((prev) => (prev && rows.some((row) => row.id === prev) ? prev : rows[0]?.id ?? null))
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await refreshHosts()
      } catch (error) {
        if (!cancelled) toast.error(error instanceof Error ? error.message : t('common.error'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshHosts, t, toast])

  if (user && !user.is_superuser && user.role !== 'editor') {
    return <Navigate to="/" replace />
  }

  function setPassword(id: number, value: string) {
    setPasswords((prev) => ({ ...prev, [id]: value }))
  }

  function passwordFor(id: number) {
    return (passwords[id] || '').trim()
  }

  function rememberOverview(next: SwarmOverview) {
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

  function upsertHost(next: SwarmHostRow) {
    setHosts((prev) => {
      const idx = prev.findIndex((row) => row.id === next.id)
      if (idx < 0) return [...prev, next]
      const copy = prev.slice()
      copy[idx] = next
      return copy
    })
  }

  async function addHost() {
    const sshPort = Number(port)
    if (!host.trim() || !sshUser.trim() || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
      toast.error(t('swarm.needHost'))
      return
    }
    setBusy(true)
    try {
      const created = await api.createSwarmHost({
        label: label.trim(),
        host: host.trim(),
        ssh_port: sshPort,
        ssh_user: sshUser.trim(),
        role,
        advertise_addr: advertise.trim(),
      })
      upsertHost(created)
      setSelectedId(created.id)
      if (newPassword.trim()) setPassword(created.id, newPassword.trim())
      setLabel('')
      setHost('')
      setAdvertise('')
      setNewPassword('')
      setRole('worker')
      toast.ok(t('swarm.hostAdded'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function probe(row: SwarmHostRow) {
    const password = passwordFor(row.id)
    if (!password) {
      toast.error(t('swarm.needPassword'))
      return
    }
    setBusy(true)
    try {
      const result = await api.swarmHostProbe(row.id, { ssh_password: password })
      upsertHost(result.host)
      setOutput(result.output || '')
      if (result.ok) toast.ok(t('swarm.probeOk'))
      else toast.error(result.host.last_error || t('common.error'))
    } catch (error) {
      setOutput(error instanceof Error ? error.message : t('common.error'))
      toast.error(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function initSwarm(row: SwarmHostRow) {
    const password = passwordFor(row.id)
    if (!password) {
      toast.error(t('swarm.needPassword'))
      return
    }
    const ok = await confirm.ask({
      title: t('swarm.init'),
      body: t('swarm.confirmInit', { host: row.host }),
      confirmLabel: t('swarm.init'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      const result = await api.swarmHostInit(row.id, {
        ssh_password: password,
        advertise_addr: row.advertise_addr || undefined,
      })
      upsertHost(result.host)
      setOutput(result.output || '')
      toast.ok(t('swarm.initOk'))
    } catch (error) {
      setOutput(error instanceof Error ? error.message : t('common.error'))
      toast.error(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function fetchToken(row: SwarmHostRow, tokenRole: SwarmRole) {
    const password = passwordFor(row.id)
    if (!password) {
      toast.error(t('swarm.needPassword'))
      return
    }
    setBusy(true)
    try {
      const result = await api.swarmHostJoinToken(row.id, { ssh_password: password, token_role: tokenRole })
      setJoinToken(result)
      setOutput(result.token)
      toast.ok(t('swarm.tokenOk'))
    } catch (error) {
      setOutput(error instanceof Error ? error.message : t('common.error'))
      toast.error(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function joinSwarm(row: SwarmHostRow) {
    const password = passwordFor(row.id)
    if (!password) {
      toast.error(t('swarm.needPassword'))
      return
    }
    if (!joinToken?.token || !joinToken.manager_addr) {
      toast.error(t('swarm.needToken'))
      return
    }
    const wanted = row.role === 'manager' ? 'manager' : 'worker'
    if (joinToken.token_role !== wanted) {
      toast.error(t('swarm.tokenRoleMismatch', { role: roleLabel(t, wanted) }))
      return
    }
    const ok = await confirm.ask({
      title: t('swarm.join'),
      body: t('swarm.confirmJoin', { host: row.host, manager: joinToken.manager_addr, role: roleLabel(t, wanted) }),
      confirmLabel: t('swarm.join'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      const result = await api.swarmHostJoin(row.id, {
        ssh_password: password,
        token: joinToken.token,
        manager_addr: joinToken.manager_addr,
      })
      upsertHost(result.host)
      setOutput(result.output || '')
      toast.ok(t('swarm.joinOk'))
    } catch (error) {
      setOutput(error instanceof Error ? error.message : t('common.error'))
      toast.error(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function leaveSwarm(row: SwarmHostRow) {
    const password = passwordFor(row.id)
    if (!password) {
      toast.error(t('swarm.needPassword'))
      return
    }
    const ok = await confirm.ask({
      title: t('swarm.leave'),
      body: t('swarm.confirmLeave', { host: row.host }),
      confirmLabel: t('swarm.leave'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      const result = await api.swarmHostLeave(row.id, { ssh_password: password, force: row.role === 'manager' })
      upsertHost(result.host)
      setOutput(result.output || '')
      toast.ok(t('swarm.leaveOk'))
    } catch (error) {
      setOutput(error instanceof Error ? error.message : t('common.error'))
      toast.error(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function monitor(row: SwarmHostRow) {
    const password = passwordFor(row.id)
    if (!password) {
      toast.error(t('swarm.needPassword'))
      return
    }
    setBusy(true)
    setSelectedId(row.id)
    try {
      const next = await api.swarmHostOverview(row.id, { ssh_password: password })
      rememberOverview(next)
      upsertHost({
        ...row,
        last_swarm_state: next.swarm || row.last_swarm_state,
        last_is_manager: next.manager,
        last_error: '',
        last_checked_at: new Date().toISOString(),
      })
    } catch (error) {
      setOutput(error instanceof Error ? error.message : t('common.error'))
      toast.error(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function removeHost(row: SwarmHostRow) {
    const ok = await confirm.ask({
      title: t('swarm.remove'),
      body: t('swarm.confirmRemove', { host: row.host }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.deleteSwarmHost(row.id)
      setHosts((prev) => prev.filter((item) => item.id !== row.id))
      setPasswords((prev) => {
        const copy = { ...prev }
        delete copy[row.id]
        return copy
      })
      if (selectedId === row.id) {
        setSelectedId(null)
        setView(null)
      }
      toast.ok(t('swarm.removed'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function scale(service: SwarmService) {
    if (!selected) return
    const password = passwordFor(selected.id)
    const count = Number(replicas[service.name])
    if (!password) {
      toast.error(t('swarm.needPassword'))
      return
    }
    if (!Number.isInteger(count) || count < 0 || count > 32) {
      toast.error(t('swarm.badReplicas'))
      return
    }
    const ok = await confirm.ask({
      title: t('swarm.scale'),
      body: t('swarm.confirmScale', { service: service.name, host: selected.host, replicas: count }),
      confirmLabel: t('swarm.scale'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      const next = await api.swarmScale({
        host: selected.host,
        ssh_port: selected.ssh_port,
        ssh_user: selected.ssh_user,
        ssh_password: password,
        service: service.name,
        replicas: count,
      })
      rememberOverview({
        ...next,
        swarm: view?.swarm || next.swarm,
        manager: view?.manager || next.manager,
        nodes: view?.nodes || next.nodes,
      })
      toast.ok(t('swarm.scale'))
    } catch (error) {
      setOutput(error instanceof Error ? error.message : t('common.error'))
      toast.error(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function rollback(service: SwarmService) {
    if (!selected) return
    const password = passwordFor(selected.id)
    if (!password) {
      toast.error(t('swarm.needPassword'))
      return
    }
    const ok = await confirm.ask({
      title: t('swarm.rollback'),
      body: t('swarm.confirmRollback', { service: service.name, host: selected.host }),
      confirmLabel: t('swarm.rollback'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      const next = await api.swarmRollback({
        host: selected.host,
        ssh_port: selected.ssh_port,
        ssh_user: selected.ssh_user,
        ssh_password: password,
        service: service.name,
      })
      rememberOverview({
        ...next,
        swarm: view?.swarm || next.swarm,
        manager: view?.manager || next.manager,
        nodes: view?.nodes || next.nodes,
      })
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

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{t('swarm.inventory')}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <label className="text-xs font-medium text-[var(--color-fg-subtle)]">
            {t('swarm.label')}
            <input className="app-input mt-1" value={label} onChange={(event) => setLabel(event.target.value)} autoComplete="off" />
          </label>
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
            {t('swarm.role')}
            <select className="app-input mt-1" value={role} onChange={(event) => setRole(event.target.value as SwarmRole)}>
              <option value="manager">{t('swarm.roleManager')}</option>
              <option value="worker">{t('swarm.roleWorker')}</option>
            </select>
          </label>
          <label className="text-xs font-medium text-[var(--color-fg-subtle)]">
            {t('swarm.advertise')}
            <input
              className="app-input mt-1 font-mono"
              value={advertise}
              onChange={(event) => setAdvertise(event.target.value)}
              placeholder="10.0.0.10"
              autoComplete="off"
            />
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-xs font-medium text-[var(--color-fg-subtle)]">
            {t('swarm.passwordSession')}
            <input
              className="app-input mt-1"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
            />
          </label>
          <div className="flex items-end">
            <button type="button" className="app-btn app-btn-primary" disabled={busy} onClick={() => void addHost()}>
              {t('swarm.addHost')}
            </button>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t('swarm.hosts')}</h2>
        {loading ? (
          <p className="text-sm text-[var(--color-fg-muted)]">{t('common.loading')}</p>
        ) : hosts.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-muted)]">{t('swarm.emptyHosts')}</p>
        ) : (
          <div className="app-scroll overflow-x-auto">
            <table className="w-full min-w-[72rem] text-left text-sm">
              <thead className="text-xs text-[var(--color-fg-subtle)]">
                <tr>
                  <th className="px-2 py-1.5 font-medium">{t('swarm.label')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('swarm.host')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('swarm.role')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('swarm.swarmState')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('swarm.password')}</th>
                  <th className="px-2 py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {hosts.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-t border-[var(--color-border)] ${selectedId === row.id ? 'bg-[var(--color-surface-muted)]' : ''}`}
                  >
                    <td className="px-2 py-1.5 font-medium">{row.label || row.last_node_name || '—'}</td>
                    <td className="px-2 py-1.5 font-mono text-xs">
                      {row.host}:{row.ssh_port}
                      {row.last_error ? (
                        <div className="mt-0.5 max-w-[16rem] truncate text-[var(--color-danger)]" title={row.last_error}>
                          {row.last_error}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5">{roleLabel(t, row.role)}</td>
                    <td className="px-2 py-1.5">
                      {row.last_swarm_state || '—'}
                      {row.last_is_manager ? ` · ${t('swarm.managerShort')}` : ''}
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        className="app-input w-36"
                        type="password"
                        value={passwords[row.id] ?? ''}
                        onChange={(event) => setPassword(row.id, event.target.value)}
                        autoComplete="new-password"
                        placeholder="••••••••"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex flex-wrap gap-1.5">
                        <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => void probe(row)}>
                          {t('swarm.probe')}
                        </button>
                        {row.role === 'manager' ? (
                          <>
                            <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => void initSwarm(row)}>
                              {t('swarm.init')}
                            </button>
                            <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => void fetchToken(row, 'worker')}>
                              {t('swarm.tokenWorker')}
                            </button>
                            <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => void fetchToken(row, 'manager')}>
                              {t('swarm.tokenManager')}
                            </button>
                            <button type="button" className="app-btn app-btn-primary" disabled={busy} onClick={() => void monitor(row)}>
                              {t('swarm.monitor')}
                            </button>
                          </>
                        ) : (
                          <button type="button" className="app-btn app-btn-secondary" disabled={busy || !joinToken} onClick={() => void joinSwarm(row)}>
                            {t('swarm.join')}
                          </button>
                        )}
                        {row.role === 'manager' && joinToken?.token_role === 'manager' ? (
                          <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => void joinSwarm(row)}>
                            {t('swarm.join')}
                          </button>
                        ) : null}
                        <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => void leaveSwarm(row)}>
                          {t('swarm.leave')}
                        </button>
                        <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => void removeHost(row)}>
                          {t('swarm.remove')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {joinToken ? (
          <p className="text-sm text-[var(--color-fg-muted)]">
            {t('swarm.tokenReady', { role: roleLabel(t, String(joinToken.token_role)), addr: joinToken.manager_addr })}
          </p>
        ) : managers.length ? (
          <p className="text-sm text-[var(--color-fg-muted)]">{t('swarm.tokenHint')}</p>
        ) : null}
      </section>

      {view ? (
        <p className="text-sm text-[var(--color-fg-muted)]">
          {t('swarm.swarmState')}: <span className="font-medium text-[var(--color-fg)]">{view.swarm || '—'}</span>
          {' · '}
          {view.manager ? t('swarm.manager') : t('swarm.worker')}
          {selected ? ` · ${selected.host}` : ''}
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
