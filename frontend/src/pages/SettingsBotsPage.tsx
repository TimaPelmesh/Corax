import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api,
  type CoraxBot,
  type CoraxBotDialogs,
  type CoraxBotDialogNode,
} from '../api'
import { useConfirmDialog } from '../components/ConfirmDialog'
import { IconAssistant, IconTrash } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { StatusPill, type StatusPillTone } from '../components/ui/StatusPill'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

const STATUS_TONE: Record<string, StatusPillTone> = {
  draft: 'neutral',
  registered: 'success',
  paused: 'warning',
}

type DialogButton = { label: string; next: string }

function nodeList(dialogs: CoraxBotDialogs): { id: string; node: CoraxBotDialogNode }[] {
  const nodes = dialogs.nodes || {}
  return Object.keys(nodes).map((id) => ({ id, node: nodes[id] }))
}

function emptyCreate(): { name: string; purpose: string; channel: 'bitrix24' | 'local' } {
  return { name: '', purpose: '', channel: 'bitrix24' }
}

export function SettingsBotsPanel({ embedded = false }: { embedded?: boolean }) {
  const t = useT()
  const toast = useToast()
  const { ask, dialog: confirmDialog } = useConfirmDialog()
  const [items, setItems] = useState<CoraxBot[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState<CoraxBot | null>(null)
  const [creating, setCreating] = useState(emptyCreate())
  const [showCreate, setShowCreate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const rows = await api.coraxBots()
      setItems(rows)
      setSelectedId((prev) => {
        if (prev && rows.some((row) => row.id === prev)) return prev
        return rows[0]?.id ?? null
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsBots.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const row = items.find((item) => item.id === selectedId) ?? null
    setDraft(row ? structuredClone(row) : null)
  }, [items, selectedId])

  const dirty = useMemo(() => {
    if (!draft) return false
    const origin = items.find((item) => item.id === draft.id)
    if (!origin) return false
    return JSON.stringify(origin) !== JSON.stringify(draft)
  }, [draft, items])

  async function createBot() {
    const name = creating.name.trim()
    if (!name) {
      toast.error(t('settingsBots.nameRequired'))
      return
    }
    setBusy(true)
    try {
      const row = await api.createCoraxBot({
        name,
        purpose: creating.purpose.trim(),
        channel: creating.channel,
      })
      setCreating(emptyCreate())
      setShowCreate(false)
      await load()
      setSelectedId(row.id)
      toast.ok(t('settingsBots.created'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsBots.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function saveDraft() {
    if (!draft) return
    setBusy(true)
    try {
      const next = await api.updateCoraxBot(draft.id, {
        name: draft.name,
        purpose: draft.purpose,
        channel: draft.channel,
        status: draft.status,
        dialogs: draft.dialogs,
        ai_enabled: draft.ai_enabled,
        ai_model: draft.ai_model,
        ai_system_prompt: draft.ai_system_prompt,
        config: draft.config,
      })
      setItems((prev) => prev.map((row) => (row.id === next.id ? next : row)))
      setDraft(next)
      toast.ok(t('settingsBots.saved'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsBots.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function registerBot() {
    if (!draft) return
    setBusy(true)
    try {
      if (dirty) {
        await api.updateCoraxBot(draft.id, {
          name: draft.name,
          purpose: draft.purpose,
          channel: draft.channel,
          status: draft.status,
          dialogs: draft.dialogs,
          ai_enabled: draft.ai_enabled,
          ai_model: draft.ai_model,
          ai_system_prompt: draft.ai_system_prompt,
          config: draft.config,
        })
      }
      const next = await api.registerCoraxBot(draft.id)
      setItems((prev) => prev.map((row) => (row.id === next.id ? next : row)))
      setDraft(next)
      toast.ok(t('settingsBots.registered'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsBots.registerFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function unregisterBot() {
    if (!draft) return
    const ok = await ask({
      title: t('settingsBots.unregisterTitle'),
      body: t('settingsBots.unregisterBody'),
      confirmLabel: t('settingsBots.unregister'),
    })
    if (!ok) return
    setBusy(true)
    try {
      const next = await api.unregisterCoraxBot(draft.id)
      setItems((prev) => prev.map((row) => (row.id === next.id ? next : row)))
      setDraft(next)
      toast.ok(t('settingsBots.unregistered'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsBots.registerFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function removeBot() {
    if (!draft) return
    const ok = await ask({
      title: t('settingsBots.deleteTitle'),
      body: t('settingsBots.deleteBody', { name: draft.name }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.deleteCoraxBot(draft.id)
      setSelectedId(null)
      await load()
      toast.ok(t('settingsBots.deleted'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsBots.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  function patchNode(nodeId: string, patch: Partial<CoraxBotDialogNode>) {
    if (!draft) return
    const nodes = { ...(draft.dialogs.nodes || {}) }
    nodes[nodeId] = { ...(nodes[nodeId] || { type: 'message' }), ...patch }
    setDraft({ ...draft, dialogs: { ...draft.dialogs, nodes } })
  }

  function renameNode(oldId: string, nextId: string) {
    if (!draft) return
    const id = nextId.trim().replace(/\s+/g, '_')
    if (!id || id === oldId || (draft.dialogs.nodes || {})[id]) return
    const nodes = { ...(draft.dialogs.nodes || {}) }
    nodes[id] = nodes[oldId]
    delete nodes[oldId]
    const entry = draft.dialogs.entry === oldId ? id : draft.dialogs.entry
    setDraft({ ...draft, dialogs: { entry, nodes } })
  }

  function addNode() {
    if (!draft) return
    let n = 1
    const nodes = { ...(draft.dialogs.nodes || {}) }
    while (nodes[`step_${n}`]) n += 1
    const id = `step_${n}`
    nodes[id] = { type: 'message', text: '', buttons: [] }
    setDraft({ ...draft, dialogs: { ...draft.dialogs, nodes } })
  }

  function removeNode(nodeId: string) {
    if (!draft) return
    const nodes = { ...(draft.dialogs.nodes || {}) }
    delete nodes[nodeId]
    const entry = draft.dialogs.entry === nodeId ? Object.keys(nodes)[0] || 'start' : draft.dialogs.entry
    setDraft({ ...draft, dialogs: { entry, nodes } })
  }

  function setButtons(nodeId: string, buttons: DialogButton[]) {
    patchNode(nodeId, { buttons })
  }

  const createBtn = (
    <button type="button" className="app-btn" disabled={busy} onClick={() => setShowCreate(true)}>
      {t('settingsBots.create')}
    </button>
  )

  return (
    <div className={embedded ? 'flex flex-col gap-4' : 'settings-page settings-page--wide'}>
      {confirmDialog}
      {embedded ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsBots.embeddedTitle')}</h2>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('settingsBots.subtitle')}</p>
          </div>
          {createBtn}
        </div>
      ) : (
        <PageHeader
          icon={<IconAssistant className="h-5 w-5" />}
          title={t('titles.bots')}
          subtitle={t('settingsBots.subtitle')}
          actions={createBtn}
        />
      )}

      {showCreate ? (
        <div className="app-panel mb-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-[var(--color-fg-muted)]">{t('settingsBots.name')}</span>
            <input
              className="app-input w-full"
              value={creating.name}
              onChange={(e) => setCreating((prev) => ({ ...prev, name: e.target.value }))}
              placeholder={t('settingsBots.namePh')}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-[var(--color-fg-muted)]">{t('settingsBots.channel')}</span>
            <select
              className="app-input w-full"
              value={creating.channel}
              onChange={(e) =>
                setCreating((prev) => ({
                  ...prev,
                  channel: e.target.value === 'local' ? 'local' : 'bitrix24',
                }))
              }
            >
              <option value="bitrix24">Bitrix24</option>
              <option value="local">{t('settingsBots.channelLocal')}</option>
            </select>
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="mb-1 block text-[var(--color-fg-muted)]">{t('settingsBots.purpose')}</span>
            <input
              className="app-input w-full"
              value={creating.purpose}
              onChange={(e) => setCreating((prev) => ({ ...prev, purpose: e.target.value }))}
              placeholder={t('settingsBots.purposePh')}
            />
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <button type="button" className="app-btn" disabled={busy} onClick={() => void createBot()}>
              {t('settingsBots.createConfirm')}
            </button>
            <button
              type="button"
              className="app-btn app-btn-secondary"
              disabled={busy}
              onClick={() => {
                setShowCreate(false)
                setCreating(emptyCreate())
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-[var(--color-fg-muted)]">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-muted)]">{t('settingsBots.empty')}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <div className="flex flex-col gap-1">
            {items.map((row) => (
              <button
                key={row.id}
                type="button"
                className={`rounded-lg border px-3 py-2 text-left transition ${
                  row.id === selectedId
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary-muted)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-muted)]'
                }`}
                onClick={() => setSelectedId(row.id)}
              >
                <div className="truncate text-sm font-semibold text-[var(--color-fg)]">{row.name}</div>
                <div className="mt-0.5 truncate text-xs text-[var(--color-fg-muted)]">
                  {row.purpose || row.channel}
                </div>
                <div className="mt-1">
                  <StatusPill tone={STATUS_TONE[row.status] || 'neutral'}>{t(`settingsBots.status.${row.status}` as 'settingsBots.status.draft')}</StatusPill>
                </div>
              </button>
            ))}
          </div>

          {draft ? (
            <div className="flex flex-col gap-4">
              <div className="app-panel grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="mb-1 block text-[var(--color-fg-muted)]">{t('settingsBots.name')}</span>
                  <input
                    className="app-input w-full"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-[var(--color-fg-muted)]">{t('settingsBots.channel')}</span>
                  <select
                    className="app-input w-full"
                    value={draft.channel}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        channel: e.target.value === 'local' ? 'local' : 'bitrix24',
                      })
                    }
                  >
                    <option value="bitrix24">Bitrix24</option>
                    <option value="local">{t('settingsBots.channelLocal')}</option>
                  </select>
                </label>
                <label className="block text-sm sm:col-span-2">
                  <span className="mb-1 block text-[var(--color-fg-muted)]">{t('settingsBots.purpose')}</span>
                  <textarea
                    className="app-input min-h-[4rem] w-full"
                    value={draft.purpose}
                    onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
                  />
                </label>
                <div className="flex flex-wrap gap-2 sm:col-span-2">
                  <button type="button" className="app-btn" disabled={busy || !dirty} onClick={() => void saveDraft()}>
                    {t('common.save')}
                  </button>
                  {draft.channel === 'bitrix24' ? (
                    draft.status === 'registered' ? (
                      <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => void unregisterBot()}>
                        {t('settingsBots.unregister')}
                      </button>
                    ) : (
                      <button type="button" className="app-btn" disabled={busy} onClick={() => void registerBot()}>
                        {t('settingsBots.register')}
                      </button>
                    )
                  ) : null}
                  <button
                    type="button"
                    className="app-btn app-btn-secondary text-[var(--color-error-fg)]"
                    disabled={busy}
                    onClick={() => void removeBot()}
                  >
                    <span className="inline-flex items-center gap-1">
                      <IconTrash className="h-3.5 w-3.5" />
                      {t('common.delete')}
                    </span>
                  </button>
                  {draft.external_bot_id ? (
                    <span className="self-center text-xs text-[var(--color-fg-subtle)]">
                      Bitrix ID: {draft.external_bot_id}
                      {draft.code ? ` · ${draft.code}` : ''}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="app-panel">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsBots.dialogs')}</h2>
                    <p className="text-xs text-[var(--color-fg-muted)]">{t('settingsBots.dialogsHint')}</p>
                  </div>
                  <button type="button" className="app-btn app-btn-secondary text-sm" onClick={addNode}>
                    {t('settingsBots.addStep')}
                  </button>
                </div>
                <label className="mb-3 block text-sm">
                  <span className="mb-1 block text-[var(--color-fg-muted)]">{t('settingsBots.entry')}</span>
                  <select
                    className="app-input w-full max-w-xs"
                    value={draft.dialogs.entry || ''}
                    onChange={(e) => setDraft({ ...draft, dialogs: { ...draft.dialogs, entry: e.target.value } })}
                  >
                    {nodeList(draft.dialogs).map(({ id }) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-col gap-3">
                  {nodeList(draft.dialogs).map(({ id, node }) => {
                    const buttons = Array.isArray(node.buttons) ? (node.buttons as DialogButton[]) : []
                    return (
                      <div key={id} className="rounded-lg border border-[var(--color-border)] p-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <input
                            className="app-input w-36 font-mono text-xs"
                            defaultValue={id}
                            onBlur={(e) => renameNode(id, e.target.value)}
                            title={t('settingsBots.stepId')}
                          />
                          <select
                            className="app-input w-32 text-sm"
                            value={node.type || 'message'}
                            onChange={(e) => patchNode(id, { type: e.target.value })}
                          >
                            <option value="message">message</option>
                            <option value="input">input</option>
                            <option value="ai">ai</option>
                          </select>
                          <button type="button" className="ml-auto app-btn app-btn-secondary p-1.5" onClick={() => removeNode(id)} aria-label={t('common.delete')}>
                            <IconTrash className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        {node.type === 'input' ? (
                          <textarea
                            className="app-input mb-2 min-h-[3rem] w-full text-sm"
                            value={String(node.prompt || '')}
                            onChange={(e) => patchNode(id, { prompt: e.target.value })}
                            placeholder={t('settingsBots.promptPh')}
                          />
                        ) : node.type === 'ai' ? (
                          <input
                            className="app-input mb-2 w-full text-sm"
                            value={String(node.fallback || '')}
                            onChange={(e) => patchNode(id, { fallback: e.target.value })}
                            placeholder={t('settingsBots.fallbackPh')}
                          />
                        ) : (
                          <textarea
                            className="app-input mb-2 min-h-[3rem] w-full text-sm"
                            value={String(node.text || '')}
                            onChange={(e) => patchNode(id, { text: e.target.value })}
                            placeholder={t('settingsBots.messagePh')}
                          />
                        )}
                        {node.type !== 'ai' ? (
                          <div className="space-y-1.5">
                            <div className="text-xs font-medium text-[var(--color-fg-muted)]">{t('settingsBots.buttons')}</div>
                            {buttons.map((btn, idx) => (
                              <div key={idx} className="flex gap-2">
                                <input
                                  className="app-input flex-1 text-sm"
                                  value={btn.label}
                                  onChange={(e) => {
                                    const next = buttons.map((b, i) => (i === idx ? { ...b, label: e.target.value } : b))
                                    setButtons(id, next)
                                  }}
                                  placeholder={t('settingsBots.buttonLabel')}
                                />
                                <input
                                  className="app-input w-28 font-mono text-xs"
                                  value={btn.next}
                                  onChange={(e) => {
                                    const next = buttons.map((b, i) => (i === idx ? { ...b, next: e.target.value } : b))
                                    setButtons(id, next)
                                  }}
                                  placeholder="next"
                                />
                                <button
                                  type="button"
                                  className="app-btn app-btn-secondary px-2 text-xs"
                                  onClick={() => setButtons(id, buttons.filter((_, i) => i !== idx))}
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                            <button
                              type="button"
                              className="app-btn app-btn-secondary text-xs"
                              onClick={() => setButtons(id, [...buttons, { label: '', next: '' }])}
                            >
                              {t('settingsBots.addButton')}
                            </button>
                            {node.type === 'input' ? (
                              <input
                                className="app-input mt-1 w-full max-w-xs font-mono text-xs"
                                value={String(node.next || '')}
                                onChange={(e) => patchNode(id, { next: e.target.value })}
                                placeholder={t('settingsBots.nextPh')}
                              />
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="app-panel grid gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsBots.ai')}</h2>
                  <p className="text-xs text-[var(--color-fg-muted)]">{t('settingsBots.aiHint')}</p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.ai_enabled}
                    onChange={(e) => setDraft({ ...draft, ai_enabled: e.target.checked })}
                  />
                  {t('settingsBots.aiEnabled')}
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-[var(--color-fg-muted)]">{t('settingsBots.aiModel')}</span>
                  <input
                    className="app-input w-full max-w-md"
                    value={draft.ai_model}
                    onChange={(e) => setDraft({ ...draft, ai_model: e.target.value })}
                    placeholder="ollama / lmstudio model id"
                    disabled={!draft.ai_enabled}
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-[var(--color-fg-muted)]">{t('settingsBots.aiPrompt')}</span>
                  <textarea
                    className="app-input min-h-[6rem] w-full"
                    value={draft.ai_system_prompt}
                    onChange={(e) => setDraft({ ...draft, ai_system_prompt: e.target.value })}
                    placeholder={t('settingsBots.aiPromptPh')}
                    disabled={!draft.ai_enabled}
                  />
                </label>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** Standalone route kept for bookmarks; prefer Bitrix24 → Конструктор. */
export function SettingsBotsPage() {
  return <SettingsBotsPanel />
}
