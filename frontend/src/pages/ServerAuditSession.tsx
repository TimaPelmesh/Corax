import { useState } from 'react'
import { api } from '../api'
import { useConfirmDialog } from '../components/ConfirmDialog'
import { useT } from '../i18n/LocaleContext'

const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9:._@-]{0,80}$/
const UNITS = [
  'llama-server',
  'rpc-server-gpu0',
  'rpc-server-gpu1',
  'rpc-server-gpu2',
  'rpc-server-gpu3',
  'rpc-server',
  'corax-audit',
  'nginx',
  'ssh',
  'sshd',
  'docker',
  'postgresql',
]

type Action = 'logs' | 'status' | 'start' | 'stop' | 'restart' | 'gpu' | 'update-scripts'

export function ServerAuditSession({ hostId, address }: { hostId: number; address: string }) {
  const t = useT()
  const confirm = useConfirmDialog()
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('root')
  const [password, setPassword] = useState('')
  const [unit, setUnit] = useState('llama-server')
  const [customUnit, setCustomUnit] = useState('')
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState('')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const chosen = customUnit.trim() || unit

  async function run(action: Action) {
    const sshPort = Number(port)
    if (!address || !user.trim() || !password || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) return
    if (action === 'restart' || action === 'stop' || action === 'update-scripts') {
      const title =
        action === 'update-scripts' ? t('serverAudit.sshUpdate') : action === 'stop' ? t('serverAudit.sshStop') : t('serverAudit.sshRestart')
      const ok = await confirm.ask({
        title,
        body: t('serverAudit.sshConfirm', { action: title, host: address, unit: action === 'update-scripts' ? '/opt/corax-agent' : chosen }),
        confirmLabel: title,
        tone: 'danger',
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      const result = await api.serverAuditSsh(hostId, {
        ssh_port: sshPort,
        ssh_user: user.trim(),
        ssh_password: password,
        action,
        target: chosen,
        lines: 160,
      })
      setExitCode(result.exit_code)
      setOutput(result.output || t('serverAudit.sshEmptyResult'))
    } catch (error) {
      setExitCode(null)
      setOutput(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  const ready = Boolean(address && user.trim() && password && !busy && UNIT_RE.test(chosen))

  return (
    <div className="flex flex-col gap-3">
      {confirm.dialog}
      <p className="text-sm text-[var(--color-fg-muted)]">{t('serverAudit.sshLead')}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs font-medium text-[var(--color-fg-subtle)]">
          {t('serverAudit.sshAddress')}
          <input className="app-input mt-1 font-mono" value={address || '—'} readOnly />
        </label>
        <label className="text-xs font-medium text-[var(--color-fg-subtle)]">
          {t('serverAudit.sshPort')}
          <input className="app-input mt-1" value={port} inputMode="numeric" onChange={(event) => setPort(event.target.value)} />
        </label>
        <label className="text-xs font-medium text-[var(--color-fg-subtle)]">
          {t('serverAudit.sshUser')}
          <input className="app-input mt-1" value={user} autoComplete="off" onChange={(event) => setUser(event.target.value)} />
        </label>
        <label className="text-xs font-medium text-[var(--color-fg-subtle)]">
          {t('serverAudit.sshPassword')}
          <input
            className="app-input mt-1"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
      </div>
      <p className="text-xs text-[var(--color-fg-subtle)]">{t('serverAudit.sshPasswordHint')}</p>
      {!address ? <p className="text-sm text-amber-700 dark:text-amber-300">{t('serverAudit.sshNoAddress')}</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[12rem] text-xs font-medium text-[var(--color-fg-subtle)]">
          {t('serverAudit.sshUnit')}
          <select className="app-input app-select mt-1" value={unit} onChange={(event) => setUnit(event.target.value)}>
            {UNITS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-[12rem] flex-1 text-xs font-medium text-[var(--color-fg-subtle)]">
          {t('serverAudit.sshUnitAny')}
          <input
            className="app-input mt-1 font-mono"
            value={customUnit}
            placeholder="nginx"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setCustomUnit(event.target.value)}
          />
        </label>
        <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2" disabled={!ready} onClick={() => void run('logs')}>
          {t('serverAudit.sshLogs')}
        </button>
        <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2" disabled={!ready} onClick={() => void run('status')}>
          {t('serverAudit.sshStatus')}
        </button>
        <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2" disabled={!ready} onClick={() => void run('start')}>
          {t('serverAudit.sshStart')}
        </button>
        <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2" disabled={!ready} onClick={() => void run('stop')}>
          {t('serverAudit.sshStop')}
        </button>
        <button type="button" className="app-btn app-btn-danger !min-h-0 !px-3 !py-2" disabled={!ready} onClick={() => void run('restart')}>
          {t('serverAudit.sshRestart')}
        </button>
        <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2" disabled={!ready} onClick={() => void run('gpu')}>
          {t('serverAudit.sshGpu')}
        </button>
        <button type="button" className="app-btn app-btn-primary !min-h-0 !px-3 !py-2" disabled={!ready} onClick={() => void run('update-scripts')}>
          {busy ? t('serverAudit.sshBusy') : t('serverAudit.sshUpdate')}
        </button>
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-[var(--color-fg-subtle)]">
          {t('serverAudit.sshOutput')}
          {exitCode != null ? <span className="ml-2 font-mono">{exitCode}</span> : null}
        </div>
        <pre className="max-h-80 min-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-muted)] p-3 font-mono text-xs text-[var(--color-fg)]">
          {output || t('serverAudit.sshEmpty')}
        </pre>
      </div>
    </div>
  )
}
