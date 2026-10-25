import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ServerAuditJob, ServerAuditJobAction } from '../api'
import { IconClose } from '../components/icons'
import { useT } from '../i18n/LocaleContext'
import { ServerAuditActions } from './ServerAuditActions'

type ManageTab = 'actions' | 'files' | 'collect'

export function ServerAuditManageModal({
  open,
  hostname,
  jobs,
  busy,
  locale,
  onClose,
  onQueue,
  collect,
}: {
  open: boolean
  hostname: string
  jobs: ServerAuditJob[]
  busy: boolean
  locale: string
  onClose: () => void
  onQueue: (action: ServerAuditJobAction, target: string, body?: string) => Promise<void>
  collect: ReactNode
}) {
  const t = useT()
  const [tab, setTab] = useState<ManageTab>('actions')
  if (!open) return null

  const tabs: { id: ManageTab; label: string }[] = [
    { id: 'actions', label: t('serverAudit.actions') },
    { id: 'files', label: t('serverAudit.actGroupFiles') },
    { id: 'collect', label: t('serverAudit.settings') },
  ]

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-manage-title"
        className="flex max-h-[100dvh] w-full max-w-5xl flex-col overflow-hidden rounded-none border-0 bg-[var(--color-surface)] shadow-none sm:max-h-[min(44rem,calc(100dvh-2rem))] sm:rounded-xl sm:border sm:border-[var(--color-border)] sm:shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
          <div className="min-w-0">
            <h2 id="audit-manage-title" className="truncate text-base font-semibold">
              {t('serverAudit.manage')}
              <span className="ml-2 font-normal text-[var(--color-fg-subtle)]">{hostname}</span>
            </h2>
            <p className="mt-1 text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.manageLead')}</p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-lg border border-[var(--color-border)] p-1.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>
        <div role="tablist" aria-label={t('serverAudit.manage')} className="flex gap-1 border-b border-[var(--color-border)] px-3 py-2">
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
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className={tab === 'collect' ? 'hidden' : ''}>
            <ServerAuditActions
              jobs={jobs}
              busy={busy}
              locale={locale}
              view={tab === 'files' ? 'files' : 'ops'}
              onQueue={onQueue}
            />
          </div>
          <div className={tab === 'collect' ? '' : 'hidden'}>{collect}</div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
