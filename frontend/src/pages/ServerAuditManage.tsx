import { useState, type ReactNode } from 'react'
import type { ServerAuditJob, ServerAuditJobAction } from '../api'
import { AppModal } from '../components/ui/AppModal'
import { useT } from '../i18n/LocaleContext'
import { ServerAuditActions } from './ServerAuditActions'
import { ServerAuditSession } from './ServerAuditSession'

type ManageTab = 'session' | 'actions' | 'files' | 'collect'

export function ServerAuditManageModal({
  open,
  hostname,
  jobs,
  busy,
  locale,
  onClose,
  onQueue,
  collect,
  hostId,
  address,
  sessionOnly,
}: {
  open: boolean
  hostname: string
  jobs: ServerAuditJob[]
  busy: boolean
  locale: string
  onClose: () => void
  onQueue: (action: ServerAuditJobAction, target: string, body?: string) => Promise<void>
  collect: ReactNode
  hostId: number
  address: string
  sessionOnly?: boolean
}) {
  const t = useT()
  const [tab, setTab] = useState<ManageTab>(sessionOnly ? 'session' : 'actions')

  const tabs: { id: ManageTab; label: string }[] = sessionOnly
    ? [{ id: 'session', label: t('serverAudit.sshTab') }]
    : [
        { id: 'session', label: t('serverAudit.sshTab') },
        { id: 'actions', label: t('serverAudit.actions') },
        { id: 'files', label: t('serverAudit.actGroupFiles') },
        { id: 'collect', label: t('serverAudit.settings') },
      ]

  return (
    <AppModal
      open={open}
      onClose={onClose}
      size="xl"
      title={
        <>
          {t('serverAudit.manage')}
          <span className="ml-2 font-normal text-[var(--color-fg-subtle)]">{hostname}</span>
        </>
      }
    >
      <div role="tablist" aria-label={t('serverAudit.manage')} className="-mx-4 -mt-4 mb-4 flex gap-1 border-b border-[var(--color-border)] px-3 py-2">
        {tabs.map((item) => {
          const active = tab === item.id
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`min-h-9 flex-1 rounded-lg px-3 py-1.5 text-sm font-medium ${
                active
                  ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm ring-1 ring-[var(--color-border)]'
                  : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
              }`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          )
        })}
      </div>
      <div className={tab === 'session' ? '' : 'hidden'}>
        <ServerAuditSession hostId={hostId} address={address} />
      </div>
      <div className={tab === 'actions' || tab === 'files' ? '' : 'hidden'}>
        <ServerAuditActions
          jobs={jobs}
          busy={busy}
          locale={locale}
          view={tab === 'files' ? 'files' : 'ops'}
          onQueue={onQueue}
        />
      </div>
      <div className={tab === 'collect' ? '' : 'hidden'}>{collect}</div>
    </AppModal>
  )
}
