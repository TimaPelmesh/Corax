import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type LlmNode } from '../api'
import { useLocale } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

type Turn = { role: 'user' | 'assistant'; content: string }

export function LlmChatPage() {
  const { t } = useLocale()
  const toast = useToast()
  const [nodes, setNodes] = useState<LlmNode[]>([])
  const [nodeId, setNodeId] = useState(0)
  const [text, setText] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.llmCluster().then((snap) => {
      setNodes(snap.nodes)
      const central = snap.nodes.find((node) => node.role === 'central') ?? snap.nodes[0]
      if (central) setNodeId(central.id)
    }).catch((err) => toast.error(err instanceof Error ? err.message : t('common.error')))
  }, [t, toast])

  const node = nodes.find((item) => item.id === nodeId)
  const ready = !!node && (!!node.metrics_url || !!node.chat_base_url)

  async function send() {
    const content = text.trim()
    if (!content || !nodeId || busy) return
    const history = [...turns, { role: 'user' as const, content }]
    setTurns(history)
    setText('')
    setBusy(true)
    try {
      const reply = await api.llmChat({
        node_id: nodeId,
        messages: history.map((turn) => ({ role: turn.role, content: turn.content })),
      })
      setTurns([...history, { role: 'assistant', content: reply.content }])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      <Link className="text-sm text-[var(--color-fg-muted)]" to="/llm-cluster">
        {t('nav.llmCluster')}
      </Link>
      <label className="text-sm">
        <span className="app-label">{t('llmCluster.host')}</span>
        <select className="app-input" value={nodeId} onChange={(event) => setNodeId(Number(event.target.value))}>
          {nodes.map((item) => (
            <option key={item.id} value={item.id}>
              {item.hostname} · {item.model || item.role}
            </option>
          ))}
        </select>
      </label>
      {!ready ? <p className="text-sm text-[var(--color-fg-muted)]">{t('llmCluster.chatNeed')}</p> : null}
      <div className="app-card min-h-64 space-y-3 p-4">
        {turns.length === 0 ? <p className="text-sm text-[var(--color-fg-muted)]">{t('llmCluster.chatEmpty')}</p> : null}
        {turns.map((turn, index) => (
          <div key={`${turn.role}-${index}`} className={turn.role === 'user' ? 'text-right' : 'text-left'}>
            <div
              className={`inline-block max-w-[90%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                turn.role === 'user' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
              }`}
            >
              {turn.content}
            </div>
          </div>
        ))}
        {busy ? <p className="text-xs text-[var(--color-fg-muted)]">{t('llmCluster.thinking')}</p> : null}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <input
          className="app-input"
          value={text}
          placeholder={t('llmCluster.chatPlaceholder')}
          onChange={(event) => setText(event.target.value)}
          disabled={!ready || busy}
        />
        <button type="submit" className="app-btn app-btn-primary" disabled={!ready || busy || !text.trim()}>
          {t('llmCluster.chatSend')}
        </button>
      </form>
    </div>
  )
}
