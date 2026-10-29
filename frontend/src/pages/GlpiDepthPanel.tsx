import { useState } from 'react'
import { api, type GlpiDepthItem } from '../api'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

export function GlpiDepthPanel() {
  const t = useT()
  const toast = useToast()
  const [ticketId, setTicketId] = useState('')
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<string[]>([])

  function show(payload: { available: boolean; items: GlpiDepthItem[]; error?: string }, kind: 'license' | 'followup') {
    if (!payload.available) {
      setLines([t('settingsGlpi.depthOff')])
      return
    }
    if (payload.error) {
      toast.error(payload.error)
    }
    if (payload.items.length === 0) {
      setLines([t('settingsGlpi.depthEmpty')])
      return
    }
    setLines(
      payload.items.map((item) =>
        kind === 'license'
          ? `${item.name || '—'}${item.software ? ` · ${item.software}` : ''}${item.seats != null ? ` · ${item.seats}` : ''}`
          : `${item.at || ''} ${item.author || ''} ${item.content || ''}`.trim(),
      ),
    )
  }

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.depthTitle')}</h2>
      <p className="mt-1 text-sm leading-relaxed text-[var(--color-fg-muted)]">{t('settingsGlpi.depthHint')}</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <button
          type="button"
          className="app-btn app-btn-secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void api
              .glpiLicenses()
              .then((payload) => show(payload, 'license'))
              .catch((e) => toast.error(e instanceof Error ? e.message : t('common.error')))
              .finally(() => setBusy(false))
          }}
        >
          {t('settingsGlpi.loadLicenses')}
        </button>
        <label className="text-sm text-[var(--color-fg)]">
          {t('settingsGlpi.ticketId')}
          <input
            className="app-input mt-1 w-36"
            inputMode="numeric"
            value={ticketId}
            onChange={(e) => setTicketId(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        <button
          type="button"
          className="app-btn app-btn-secondary"
          disabled={busy || !ticketId}
          onClick={() => {
            setBusy(true)
            void api
              .glpiFollowups(Number(ticketId))
              .then((payload) => show(payload, 'followup'))
              .catch((e) => toast.error(e instanceof Error ? e.message : t('common.error')))
              .finally(() => setBusy(false))
          }}
        >
          {t('settingsGlpi.loadFollowups')}
        </button>
      </div>
      {lines.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm text-[var(--color-fg)]">
          {lines.map((line, index) => (
            <li key={`${index}-${line}`}>{line}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
