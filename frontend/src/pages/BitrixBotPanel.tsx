import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, type BitrixBotCard, type BitrixBotPhrases, type BitrixBotSettings } from '../api'
import { useConfirmDialog } from '../components/ConfirmDialog'
import { IconSearch, IconTrash } from '../components/icons'
import { AppModal } from '../components/ui/AppModal'
import { StatusPill } from '../components/ui/StatusPill'
import { useT, type MessageKey } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

const COLORS = ['GREEN', 'RED', 'MINT', 'LIGHT_BLUE', 'DARK_BLUE', 'PURPLE', 'AQUA', 'PINK', 'LIME', 'BROWN', 'AZURE', 'GRAY'] as const
const COLOR_HEX: Record<(typeof COLORS)[number], string> = {
  GREEN: '#3dbe6e',
  RED: '#e15b64',
  MINT: '#2fbfae',
  LIGHT_BLUE: '#4aa3df',
  DARK_BLUE: '#2f5f98',
  PURPLE: '#7b61c9',
  AQUA: '#3aa8b8',
  PINK: '#d96b9a',
  LIME: '#8fbf3f',
  BROWN: '#a56b45',
  AZURE: '#3e7cb1',
  GRAY: '#7d8794',
}
const BACKGROUNDS: { id: string; label: MessageKey }[] = [
  { id: 'default', label: 'settingsBitrix.botBgDefault' },
  { id: 'azure', label: 'settingsBitrix.botBgAzure' },
  { id: 'mint', label: 'settingsBitrix.botBgMint' },
  { id: 'steel', label: 'settingsBitrix.botBgSteel' },
  { id: 'slate', label: 'settingsBitrix.botBgSlate' },
  { id: 'teal', label: 'settingsBitrix.botBgTeal' },
  { id: 'cornflower', label: 'settingsBitrix.botBgCornflower' },
  { id: 'sky', label: 'settingsBitrix.botBgSky' },
  { id: 'peach', label: 'settingsBitrix.botBgPeach' },
  { id: 'frost', label: 'settingsBitrix.botBgFrost' },
]

type PhraseKey = 'greeting_note' | 'greet_body' | 'greet_tail' | 'ask' | 'cancel' | 'accepted' | 'closed' | 'help' | 'nudge' | 'off' | 'no_ticket' | 'status'
type Pane = 'messages' | 'look' | 'extra'

const KINDS: { id: string; label: MessageKey; fields: PhraseKey[] }[] = [
  { id: 'greet', label: 'settingsBitrix.botMsgGreet', fields: ['greet_body', 'greeting_note', 'greet_tail'] },
  { id: 'ask', label: 'settingsBitrix.botMsgAsk', fields: ['ask'] },
  { id: 'accepted', label: 'settingsBitrix.botMsgAccepted', fields: ['accepted'] },
  { id: 'closed', label: 'settingsBitrix.botMsgClosed', fields: ['closed'] },
  { id: 'status', label: 'settingsBitrix.botMsgStatus', fields: ['status'] },
  { id: 'none', label: 'settingsBitrix.botMsgNone', fields: ['no_ticket'] },
  { id: 'nudge', label: 'settingsBitrix.botMsgNudge', fields: ['nudge'] },
  { id: 'cancel', label: 'settingsBitrix.botMsgCancel', fields: ['cancel'] },
  { id: 'help', label: 'settingsBitrix.botMsgHelp', fields: ['help'] },
  { id: 'off', label: 'settingsBitrix.botMsgOff', fields: ['off'] },
]

const FIELD_LABEL: Record<PhraseKey, MessageKey> = {
  greet_body: 'settingsBitrix.botGreetBody',
  greeting_note: 'settingsBitrix.botGreetingNote',
  greet_tail: 'settingsBitrix.botGreetTail',
  ask: 'settingsBitrix.botMsgAsk',
  cancel: 'settingsBitrix.botMsgCancel',
  accepted: 'settingsBitrix.botMsgAccepted',
  closed: 'settingsBitrix.botMsgClosed',
  help: 'settingsBitrix.botMsgHelp',
  nudge: 'settingsBitrix.botMsgNudge',
  off: 'settingsBitrix.botMsgOff',
  no_ticket: 'settingsBitrix.botMsgNone',
  status: 'settingsBitrix.botMsgStatus',
}

const PLACEHOLDER: Record<PhraseKey, string> = {
  greet_body: 'Я рядом и с радостью приму заявку.',
  greet_tail: 'Нажмите на кнопку ниже.',
  greeting_note: '',
  ask: 'Напишите, пожалуйста, одним сообщением, что нужно сделать: что заменить, исправить или что случилось. Я сразу заведу заявку.',
  cancel: 'Хорошо! Буду ждать вас снова тут.',
  accepted: 'Спасибо. 📝 Заявка №{id} принята.',
  closed: '{mark} Заявка №{id} {verb}.\nСпасибо, что обратились.{wish}\nЕсли понадобится ещё помощь — нажмите на кнопку ниже.',
  help: 'Нажмите на кнопку ниже.',
  nudge: '{hello}\nНажмите на кнопку ниже.',
  off: 'Приём заявок сейчас выключен.',
  no_ticket: 'Заявок от вас пока нет. Нажмите на кнопку ниже, чтобы создать первую.',
  status: '{mark} Заявка №{id} — {label}.',
}

const BLANK: BitrixBotPhrases = {
  greet_daypart: true,
  close_notice: true,
  greeting_note: '',
  greet_body: '',
  greet_tail: '',
  ask: '',
  cancel: '',
  accepted: '',
  closed: '',
  help: '',
  nudge: '',
  off: '',
  no_ticket: '',
  status: '',
}

function phrasesEqual(left: BitrixBotPhrases, right: BitrixBotPhrases) {
  if ((left.greet_daypart !== false) !== (right.greet_daypart !== false)) return false
  if ((left.close_notice !== false) !== (right.close_notice !== false)) return false
  const keys: PhraseKey[] = [
    'greeting_note',
    'greet_body',
    'greet_tail',
    'ask',
    'cancel',
    'accepted',
    'closed',
    'help',
    'nudge',
    'off',
    'no_ticket',
    'status',
  ]
  return keys.every((key) => String(left[key] || '') === String(right[key] || ''))
}

function shown(phrases: BitrixBotPhrases): BitrixBotPhrases {
  const next: BitrixBotPhrases = { ...phrases }
  ;(Object.keys(PLACEHOLDER) as PhraseKey[]).forEach((key) => {
    if (!String(next[key] || '').trim() && PLACEHOLDER[key]) next[key] = PLACEHOLDER[key]
  })
  return next
}

function fullPhrases(raw: BitrixBotPhrases | undefined, fallback: BitrixBotSettings | null, id: number): BitrixBotPhrases {
  if (raw) {
    return shown({
      ...BLANK,
      ...raw,
      greet_daypart: raw.greet_daypart !== false,
      close_notice: raw.close_notice !== false,
    })
  }
  if (fallback && fallback.bot_id === id) {
    return shown({
      ...BLANK,
      greet_daypart: fallback.greet_daypart !== false,
      close_notice: fallback.close_notice !== false,
      greeting_note: fallback.greeting_note || '',
    })
  }
  return shown({ ...BLANK })
}

const TOKENS: Record<string, string[]> = {
  greet: [],
  ask: ['{name}'],
  accepted: ['{id}', '{name}'],
  closed: ['{id}', '{name}', '{mark}', '{verb}', '{wish}', '{farewell}'],
  status: ['{id}', '{mark}', '{label}', '{title}'],
  none: [],
  nudge: ['{hello}', '{name}'],
  cancel: ['{name}'],
  help: [],
  off: [],
}

function daypart(hour: number) {
  if (hour >= 5 && hour < 12) return 'Доброе утро'
  if (hour >= 12 && hour < 17) return 'Добрый день'
  if (hour >= 17 && hour < 23) return 'Добрый вечер'
  return 'Доброй ночи'
}

function farewell(hour: number) {
  if (hour >= 5 && hour < 12) return 'Хорошего утра'
  if (hour >= 12 && hour < 17) return 'Хорошего дня'
  if (hour >= 17 && hour < 23) return 'Хорошего вечера'
  return 'Доброй ночи'
}

function localHour() {
  return new Date().getHours()
}

function fill(template: string, vars: Record<string, string>) {
  return template.replace(/\{([a-z_]+)\}/g, (all, key: string) => (key in vars ? vars[key] : all))
}

function line(value: string | undefined, fallback: string) {
  const text = (value || '').trim()
  return text || fallback
}

function previewOf(kind: string, phrases: BitrixBotPhrases) {
  const hour = localHour()
  const byTime = phrases.greet_daypart !== false
  const hello = byTime ? `${daypart(hour)}, Анна!` : 'Здравствуйте!'
  const wish = byTime ? ` ${farewell(hour)}, Анна!` : ''
  const vars = {
    id: '128',
    name: 'Анна',
    hello,
    wish,
    mark: '✅',
    verb: 'выполнена',
    farewell: byTime ? farewell(hour) : '',
    label: 'в работе',
    title: '[Битрикс] Не печатает',
  }
  if (kind === 'greet') {
    const parts = [hello, line(phrases.greet_body, PLACEHOLDER.greet_body)]
    if ((phrases.greeting_note || '').trim()) parts.push((phrases.greeting_note || '').trim())
    parts.push(line(phrases.greet_tail, PLACEHOLDER.greet_tail))
    return parts.join('\n')
  }
  const key: PhraseKey =
    kind === 'ask' ? 'ask'
    : kind === 'accepted' ? 'accepted'
    : kind === 'closed' ? 'closed'
    : kind === 'status' ? 'status'
    : kind === 'none' ? 'no_ticket'
    : kind === 'nudge' ? 'nudge'
    : kind === 'cancel' ? 'cancel'
    : kind === 'help' ? 'help'
    : 'off'
  const custom = (phrases[key] || '').trim()
  if (!custom && kind === 'closed') {
    return `✅ Заявка №128 выполнена.\nСпасибо, что обратились.${wish}\nЕсли понадобится ещё помощь — нажмите на кнопку ниже.`
  }
  if (!custom && kind === 'status') return '🔧 Заявка №128 — в работе.\n[Битрикс] Не печатает'
  if (!custom && kind === 'nudge') return `${hello}\nНажмите на кнопку ниже.`
  const text = fill(custom || PLACEHOLDER[key], vars)
  if (kind === 'status' && custom && !custom.includes('{title}')) return `${text}\n[Битрикс] Не печатает`
  return text
}

function matches(item: BitrixBotCard, needle: string) {
  if (!needle) return true
  return `${item.name} ${item.last_name} ${item.code} ${item.bot_id} ${item.position}`.toLowerCase().includes(needle)
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="app-label">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-[12px] leading-relaxed text-[var(--color-fg-subtle)]">{hint}</span> : null}
    </label>
  )
}

function renderBb(source: string): ReactNode[] {
  const re = /\[(\/)?(b|i|u|s|br|color)(?:=(#[0-9a-fA-F]{3,8}))?\]/gi
  const stack: Array<{ tag: string; color?: string; parts: ReactNode[] }> = [{ tag: 'root', parts: [] }]
  let last = 0
  let key = 0
  const pushText = (text: string) => {
    if (text) stack[stack.length - 1].parts.push(text)
  }
  for (const match of source.matchAll(re)) {
    const index = match.index ?? 0
    pushText(source.slice(last, index))
    last = index + match[0].length
    const closing = Boolean(match[1])
    const tag = match[2].toLowerCase()
    if (tag === 'br' && !closing) {
      stack[stack.length - 1].parts.push(<br key={key++} />)
      continue
    }
    if (!closing) {
      stack.push({ tag, color: match[3], parts: [] })
      continue
    }
    for (let i = stack.length - 1; i > 0; i -= 1) {
      if (stack[i].tag !== tag) continue
      const node = stack.splice(i, 1)[0]
      const inner = node.parts
      const el =
        tag === 'b' ? (
          <strong key={key++}>{inner}</strong>
        ) : tag === 'i' ? (
          <em key={key++}>{inner}</em>
        ) : tag === 'u' ? (
          <span key={key++} className="underline">{inner}</span>
        ) : tag === 's' ? (
          <s key={key++}>{inner}</s>
        ) : (
          <span key={key++} style={node.color ? { color: node.color } : undefined}>{inner}</span>
        )
      stack[i - 1].parts.push(el)
      break
    }
  }
  pushText(source.slice(last))
  while (stack.length > 1) {
    const node = stack.pop()
    if (node) stack[stack.length - 1].parts.push(...node.parts)
  }
  return stack[0].parts
}

const btn = 'app-btn app-btn-secondary !min-h-0'
const btnPrimary = 'app-btn app-btn-primary !min-h-0'

function Toggle({
  on,
  disabled,
  label,
  hint,
  onChange,
}: {
  on: boolean
  disabled?: boolean
  label: string
  hint: string
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex min-w-[16rem] items-center gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${on ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-border)]'}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition ${on ? 'left-[1.35rem]' : 'left-0.5'}`} />
      </button>
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-tight text-[var(--color-fg)]">{label}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-[var(--color-fg-subtle)]">{hint}</span>
      </span>
    </div>
  )
}

export function BitrixBotPanel({
  incomingEnabled,
  incomingBusy,
  onIncomingChange,
  onIncomingSettings,
}: {
  incomingEnabled: boolean
  incomingBusy?: boolean
  onIncomingChange: (enabled: boolean) => void
  onIncomingSettings: () => void
}) {
  const t = useT()
  const toast = useToast()
  const { ask, dialog } = useConfirmDialog()
  const [bot, setBot] = useState<BitrixBotSettings | null>(null)
  const [webhook, setWebhook] = useState('')
  const [token, setToken] = useState('')
  const [botId, setBotId] = useState('')
  const [code, setCode] = useState('')
  const [botType, setBotType] = useState('bot')
  const [name, setName] = useState('Бот заявок')
  const [lastName, setLastName] = useState('')
  const [position, setPosition] = useState('Приём заявок')
  const [email, setEmail] = useState('')
  const [color, setColor] = useState('GREEN')
  const [gender, setGender] = useState('')
  const [background, setBackground] = useState('default')
  const [eventMode, setEventMode] = useState('fetch')
  const [hidden, setHidden] = useState(false)
  const [reactions, setReactions] = useState(true)
  const [openline, setOpenline] = useState(false)
  const [avatar, setAvatar] = useState('')
  const [avatarPreview, setAvatarPreview] = useState('')
  const [bots, setBots] = useState<BitrixBotCard[]>([])
  const [scripts, setScripts] = useState<Record<string, BitrixBotPhrases>>({})
  const [phrases, setPhrases] = useState<BitrixBotPhrases>(BLANK)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [pane, setPane] = useState<Pane>('messages')
  const [connectOpen, setConnectOpen] = useState(false)
  const [kind, setKind] = useState('greet')
  const [query, setQuery] = useState('')
  const [pickQuery, setPickQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [listed, setListed] = useState(false)
  const [phraseStatus, setPhraseStatus] = useState<'idle' | 'saving' | 'saved' | 'restarting'>('idle')
  const boot = useRef(false)
  const draftRef = useRef<{ id: number; phrases: BitrixBotPhrases } | null>(null)
  const saveSeq = useRef(0)
  const fieldRefs = useRef<Partial<Record<PhraseKey, HTMLTextAreaElement | null>>>({})
  const kindRef = useRef(KINDS[0])
  const live = useRef({ bot, bots, scripts })
  live.current = { bot, bots, scripts }

  const take = useCallback((row: BitrixBotSettings) => {
    setBot(row)
    setScripts(row.scripts || {})
  }, [])

  const persist = useCallback((id: number, snapshot: BitrixBotPhrases, apply = false) => {
    const seq = ++saveSeq.current
    setPhraseStatus(apply ? 'restarting' : 'saving')
    return api.saveBitrixBotPhrases({
      bot_id: id,
      apply,
      greet_daypart: snapshot.greet_daypart !== false,
      close_notice: snapshot.close_notice !== false,
      greeting_note: snapshot.greeting_note || '',
      greet_body: snapshot.greet_body || '',
      greet_tail: snapshot.greet_tail || '',
      ask: snapshot.ask || '',
      cancel: snapshot.cancel || '',
      accepted: snapshot.accepted || '',
      closed: snapshot.closed || '',
      help: snapshot.help || '',
      nudge: snapshot.nudge || '',
      off: snapshot.off || '',
      no_ticket: snapshot.no_ticket || '',
      status: snapshot.status || '',
    }).then((next) => {
      if (seq !== saveSeq.current) return false
      setBot(next)
      setScripts(next.scripts || {})
      setPhraseStatus('saved')
      return true
    }).catch((error) => {
      if (seq !== saveSeq.current) return false
      setPhraseStatus('idle')
      toast.error(error instanceof Error ? error.message : t('settingsBitrix.saveFailed'))
      return false
    })
  }, [t, toast])

  const applyCard = useCallback((card: BitrixBotCard) => {
    setName(card.name || 'Бот заявок')
    setLastName(card.last_name || '')
    setPosition(card.position || '')
    setEmail(card.email || '')
    setCode(card.code || '')
    setBotType(card.bot_type || 'bot')
    setColor(card.color && card.color in COLOR_HEX ? card.color : 'GREEN')
    setGender(card.gender || '')
    setBackground(BACKGROUNDS.some((item) => item.id === card.background_id) ? card.background_id : 'default')
    setEventMode(card.event_mode === 'webhook' ? 'webhook' : 'fetch')
    setHidden(Boolean(card.hidden))
    setReactions(card.reactions !== false)
    setOpenline(Boolean(card.openline))
  }, [])

  const applySettings = useCallback((row: BitrixBotSettings) => {
    setName(row.name || 'Бот заявок')
    setLastName(row.last_name || '')
    setPosition(row.position || 'Приём заявок')
    setEmail(row.email || '')
    setCode(row.code || '')
    setBotType(row.bot_type || 'bot')
    setColor(row.color && row.color in COLOR_HEX ? row.color : 'GREEN')
    setGender(row.gender || '')
    setBackground(BACKGROUNDS.some((item) => item.id === row.background_id) ? row.background_id : 'default')
    setEventMode(row.event_mode === 'webhook' ? 'webhook' : 'fetch')
    setHidden(Boolean(row.hidden))
    setReactions(row.reactions !== false)
    setOpenline(Boolean(row.openline))
  }, [])

  function select(id: number, nextPane: Pane = 'messages') {
    const draft = draftRef.current
    if (draft && draft.id !== id) persist(draft.id, draft.phrases)
    draftRef.current = null
    const source = live.current
    setSelectedId(id)
    setBotId(String(id))
    setPane(nextPane)
    setPhrases(fullPhrases(source.scripts[String(id)], source.bot, id))
    const saved = source.bot?.bot_id === id ? source.bot : null
    const card = source.bots.find((item) => item.bot_id === id)
    if (saved?.name) applySettings(saved)
    else if (card) applyCard(card)
    else if (saved) applySettings(saved)
  }

  const loadBots = useCallback((overlay?: BitrixBotSettings | null) => {
    void api.bitrixBots().then((page) => {
      const saved = overlay === undefined ? live.current.bot : overlay
      setBots(saved?.bot_id ? page.items.map((item) => (
        item.bot_id === saved.bot_id
          ? {
              ...item,
              name: saved.name || item.name,
              last_name: saved.last_name,
              position: saved.position || item.position,
              color: saved.color || item.color,
              gender: saved.gender,
            }
          : item
      )) : page.items)
      setListed(true)
    }).catch((error) => {
      setBots([])
      setListed(true)
      toast.error(error instanceof Error ? error.message : t('settingsBitrix.loadFailed'))
    })
  }, [t, toast])

  useEffect(() => {
    void api.bitrixBot().then(take).catch((error) => {
      toast.error(error instanceof Error ? error.message : t('settingsBitrix.loadFailed'))
    })
  }, [take, t, toast])

  useEffect(() => {
    if (bot?.token_set && bot.webhook_set) loadBots()
    else {
      setBots([])
      setListed(false)
    }
  }, [bot?.token_set, bot?.webhook_set, loadBots])

  useEffect(() => {
    if (boot.current || !bot) return
    if (bot.webhook_set && bot.token_set && !listed) return
    boot.current = true
    const id = bot.bot_id || bots[0]?.bot_id || null
    if (id) select(id)
    else setConnectOpen(true)
    // select reads the latest list from a ref; boot runs once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot, bots, listed])

  useEffect(() => {
    if (!selectedId || draftRef.current) return
    const next = fullPhrases(scripts[String(selectedId)], bot, selectedId)
    setPhrases((current) => (phrasesEqual(current, next) ? current : next))
  }, [bot, scripts, selectedId])

  useEffect(() => {
    const draft = draftRef.current
    if (!draft) return
    const timer = window.setTimeout(() => {
      const job = draftRef.current
      if (!job || job.id !== draft.id) return
      void persist(job.id, job.phrases).finally(() => {
        if (draftRef.current === job) draftRef.current = null
      })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [phrases, persist, selectedId])

  useEffect(() => {
    if (!connectOpen) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setConnectOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [connectOpen])

  function edit(next: BitrixBotPhrases) {
    if (!selectedId) return
    setPhraseStatus('idle')
    setPhrases(next)
    draftRef.current = { id: selectedId, phrases: next }
  }

  async function applyMessages() {
    if (!selectedId) return
    const snapshot = phrases
    draftRef.current = null
    setBusy(true)
    try {
      const saved = await persist(selectedId, snapshot, true)
      const speaks = Boolean(bot?.bot_id && bot.bot_id === selectedId)
      if (saved) toast.ok(speaks ? t('settingsBitrix.botPhraseApplied') : t('settingsBitrix.botPhraseAppliedIdle'))
    } finally {
      setBusy(false)
    }
  }

  function payload(bindId: number | null | undefined, includeId: boolean) {
    const body: {
      webhook_url: string | null
      bot_token: string | null
      bot_id?: number | null
      code: string | null
      bot_type: string
      name: string
      last_name: string
      position: string
      email: string
      color: string
      gender: string
      background_id: string
      event_mode: string
      hidden: boolean
      reactions: boolean
      openline: boolean
    } = {
      webhook_url: webhook.trim() || null,
      bot_token: token.trim() || null,
      code: code.trim() || null,
      bot_type: botType,
      name,
      last_name: lastName,
      position,
      email: email.trim(),
      color,
      gender,
      background_id: background,
      event_mode: eventMode === 'webhook' ? 'webhook' : 'fetch',
      hidden,
      reactions,
      openline,
    }
    if (includeId) body.bot_id = bindId && bindId > 0 ? bindId : null
    return body
  }

  async function run(action: 'save' | 'register' | 'profile' | 'enable' | 'disable', bindId?: number | null) {
    setBusy(true)
    try {
      if (selectedId) {
        const snapshot = phrases
        draftRef.current = { id: selectedId, phrases: snapshot }
        const saved = await persist(selectedId, snapshot)
        if (draftRef.current?.phrases === snapshot) draftRef.current = null
        if (!saved) return
      }
      const next =
        action === 'save'
          ? await api.saveBitrixBot(payload(undefined, false))
          : action === 'register'
            ? await api.registerBitrixBot(payload(bindId ?? (botId ? Number(botId) : null), true))
            : action === 'enable'
              ? await api.setBitrixBotEnabled(true)
              : action === 'disable'
                ? await api.setBitrixBotEnabled(false)
                : await api.updateBitrixBotProfile({
                    name,
                    last_name: lastName,
                    position,
                    email: email.trim(),
                    color,
                    gender,
                    avatar_base64: avatar || null,
                    background_id: background,
                    bot_type: botType,
                    event_mode: eventMode === 'webhook' ? 'webhook' : 'fetch',
                    hidden,
                    reactions,
                    openline,
                  })
      take(next)
      applySettings(next)
      setWebhook('')
      setToken('')
      setAvatar('')
      setAvatarPreview('')
      if (next.bot_id) {
        setSelectedId(next.bot_id)
        setBotId(String(next.bot_id))
        setPhrases(fullPhrases(next.scripts?.[String(next.bot_id)], next, next.bot_id))
      }
      if (action === 'register') {
        setConnectOpen(false)
        setPane('messages')
      }
      if (action !== 'enable' && action !== 'disable') loadBots(next)
      else if (next.token_set && next.webhook_set) loadBots(next)
      toast.ok(t('settingsBitrix.botSaved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settingsBitrix.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function pushMode(mode: string) {
    setBusy(true)
    try {
      const next = await api.setBitrixBotMode(mode === 'webhook' ? 'webhook' : 'fetch')
      take(next)
      setEventMode(next.event_mode === 'webhook' ? 'webhook' : 'fetch')
      loadBots()
      toast.ok(t('settingsBitrix.botSaved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settingsBitrix.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function removeBot(id: number) {
    const item = bots.find((row) => row.bot_id === id)
    const label = item?.name || `#${id}`
    const ok = await ask({
      title: t('settingsBitrix.botDelete'),
      body: t('settingsBitrix.botDeleteConfirm', { id, name: label }),
      confirmLabel: t('settingsBitrix.botDelete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      const next = await api.unregisterBitrixBot(id)
      take(next)
      const rest = bots.filter((row) => row.bot_id !== id)
      setBots(rest)
      if (selectedId === id) {
        if (rest[0]) select(rest[0].bot_id)
        else {
          setSelectedId(null)
          setPane('messages')
          setConnectOpen(true)
        }
      }
      loadBots()
      toast.ok(t('settingsBitrix.botSaved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settingsBitrix.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  function focusedField() {
    const active = document.activeElement
    for (const field of kindRef.current.fields) {
      if (fieldRefs.current[field] === active) return field
    }
    return kindRef.current.fields[0]
  }

  function insertAt(field: PhraseKey, token: string) {
    const current = String(phrases[field] || '')
    const el = fieldRefs.current[field]
    const start = el?.selectionStart ?? current.length
    const end = el?.selectionEnd ?? current.length
    const limit = field === 'greeting_note' ? 400 : 800
    const next = `${current.slice(0, start)}${token}${current.slice(end)}`.slice(0, limit)
    edit({ ...phrases, [field]: next })
    window.requestAnimationFrame(() => {
      const node = fieldRefs.current[field]
      if (!node) return
      const caret = Math.min(start + token.length, limit)
      node.focus()
      node.setSelectionRange(caret, caret)
    })
  }

  function wrap(field: PhraseKey, open: string, close: string) {
    const current = String(phrases[field] || '')
    const el = fieldRefs.current[field]
    const start = el?.selectionStart ?? current.length
    const end = el?.selectionEnd ?? current.length
    const limit = field === 'greeting_note' ? 400 : 800
    const next = `${current.slice(0, start)}${open}${current.slice(start, end)}${close}${current.slice(end)}`.slice(0, limit)
    edit({ ...phrases, [field]: next })
  }

  function pickAvatar(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      setAvatarPreview(text)
      setAvatar(text.includes(',') ? text.split(',')[1] : text)
    }
    reader.readAsDataURL(file)
  }

  async function copyHandler() {
    const url = bot?.handler_url
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      toast.ok(t('settingsBitrix.botCopied'))
    } catch {
      toast.error(t('settingsBitrix.copyWebhookFailed'))
    }
  }

  function roleLabel(kindName: string) {
    if (kindName === 'supervisor') return t('settingsBitrix.botTypeSupervisor')
    if (kindName === 'personal') return t('settingsBitrix.botTypePersonal')
    return kindName ? t('settingsBitrix.botTypeBot') : ''
  }

  const needle = query.trim().toLowerCase()
  const visible = bots.filter((item) => matches(item, needle))
  const pickNeedle = pickQuery.trim().toLowerCase()
  const suggestions = bots.filter((item) => matches(item, pickNeedle))
  const typedId = Number(pickQuery.trim())
  const typedKnown = Number.isInteger(typedId) && typedId > 0 && bots.some((item) => item.bot_id === typedId)
  const circle = COLOR_HEX[color as (typeof COLORS)[number]] ?? COLOR_HEX.GREEN
  const currentKind = KINDS.find((item) => item.id === kind) ?? KINDS[0]
  kindRef.current = currentKind
  const preview = previewOf(currentKind.id, phrases)
  const selected = bots.find((item) => item.bot_id === selectedId) ?? null
  const bound = Boolean(selectedId && bot?.bot_id === selectedId)
  const displayName = name.trim() || selected?.name || (bound ? bot?.name : '') || t('settingsBitrix.botCreateNew')

  const phraseBody = useMemo(() => preview, [preview])

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      {dialog}
      <aside className="app-card flex max-h-[32rem] flex-col overflow-hidden !rounded-xl">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsBitrix.botListTitle')}</h2>
          <button
            type="button"
            aria-label={t('settingsBitrix.botCreateNew')}
            title={t('settingsBitrix.botCreateNew')}
            className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--color-border)] text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)]"
            onClick={() => {
              setConnectOpen(true)
              setPickQuery('')
              setBotId('')
            }}
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden>
              <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="relative px-3 py-2">
          <IconSearch className="pointer-events-none absolute left-6 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
          <input
            className="app-input pl-9"
            value={query}
            placeholder={t('settingsBitrix.botSearch')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {!bot?.webhook_set || !bot.token_set ? (
            <p className="px-2 py-6 text-sm leading-relaxed text-[var(--color-fg-subtle)]">{t('settingsBitrix.botListNeedToken')}</p>
          ) : visible.length === 0 ? (
            <p className="px-2 py-6 text-sm text-[var(--color-fg-subtle)]">{needle ? t('settingsBitrix.botNoMatch') : t('settingsBitrix.botListEmpty')}</p>
          ) : (
            visible.map((item) => {
              const active = item.bot_id === selectedId
              const current = item.bot_id === bot.bot_id
              const dot = COLOR_HEX[item.color as (typeof COLORS)[number]] ?? COLOR_HEX.GRAY
              const title = (current && bot.name.trim()) || item.name || item.code || `#${item.bot_id}`
              return (
                <div key={item.bot_id} className={`flex items-center gap-0.5 rounded-xl ${active ? 'bg-[var(--color-bg-muted)]' : 'hover:bg-[var(--color-bg-muted)]'}`}>
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left" onClick={() => select(item.bot_id)}>
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-white ${active ? 'ring-2 ring-[var(--color-primary)] ring-offset-2 ring-offset-[var(--color-bg-muted)]' : ''}`} style={{ background: dot }}>
                      {(title.trim().slice(0, 1) || 'Б').toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-baseline gap-1.5">
                        <span className="truncate text-sm font-medium text-[var(--color-fg)]">{title}</span>
                        <span className="shrink-0 font-mono text-[11px] text-[var(--color-fg-subtle)]">#{item.bot_id}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-[var(--color-fg-subtle)]">
                        {roleLabel(item.bot_type)}
                        {current ? ` · ${t('settingsBitrix.botCurrent')}` : ''}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="mr-1 self-center rounded-lg p-2 text-[var(--color-fg-subtle)] hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error-fg)] disabled:opacity-50"
                    aria-label={t('settingsBitrix.botDelete')}
                    disabled={busy}
                    onClick={() => void removeBot(item.bot_id)}
                  >
                    <IconTrash className="h-4 w-4" />
                  </button>
                </div>
              )
            })
          )}
        </div>
      </aside>

      <section className="app-card min-w-0 overflow-hidden !rounded-xl">
        <header className="flex flex-col gap-3 border-b border-[var(--color-border)] px-4 py-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-[var(--color-fg)]">{displayName}</h2>
              {selectedId ? <span className="font-mono text-xs text-[var(--color-fg-subtle)]">#{selectedId}</span> : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <StatusPill tone="neutral">
                {eventMode === 'webhook' ? t('settingsBitrix.botEventWebhook') : t('settingsBitrix.botEventFetch')}
              </StatusPill>
              <StatusPill tone={bot?.webhook_host ? 'success' : 'warning'}>
                {bot?.webhook_host ? t('settingsBitrix.botStatusOn', { host: bot.webhook_host }) : t('settingsBitrix.botStatusOff')}
              </StatusPill>
            </div>
          </div>
          <div className="flex w-full flex-col gap-3 sm:w-auto">
            <Toggle
              on={Boolean(bot?.bot_enabled && bound)}
              disabled={busy || !bound || !bot?.bot_id || !bot.webhook_set}
              label={t('settingsBitrix.botIntakeLabel')}
              hint={bound ? t('settingsBitrix.botIntakeHint') : t('settingsBitrix.botIdlePhrases')}
              onChange={(next) => void run(next ? 'enable' : 'disable')}
            />
            <div className="flex items-center gap-2">
              <Toggle
                on={incomingEnabled}
                disabled={incomingBusy}
                label={t('settingsBitrix.incomingLabel')}
                hint={t('settingsBitrix.incomingHint')}
                onChange={onIncomingChange}
              />
              <button type="button" className={`${btn} shrink-0 self-center`} onClick={onIncomingSettings}>
                {t('settingsBitrix.incomingMore')}
              </button>
            </div>
            {!bound && selectedId ? (
              <button type="button" className={btnPrimary} disabled={busy} onClick={() => void run('register', selectedId)}>
                {t('settingsBitrix.botUseThis')}
              </button>
            ) : null}
          </div>
        </header>

        <div className="flex gap-1 border-b border-[var(--color-border)] px-3 py-2">
          {(['messages', 'look', 'extra'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${pane === item ? 'bg-[var(--color-bg-muted)] text-[var(--color-fg)]' : 'text-[var(--color-fg-subtle)] hover:bg-[var(--color-bg-muted)]'}`}
              onClick={() => setPane(item)}
            >
              {item === 'messages' ? t('settingsBitrix.botMessages') : item === 'look' ? t('settingsBitrix.botLook') : t('settingsBitrix.botExtraTab')}
            </button>
          ))}
        </div>

        {pane === 'messages' ? (
          <div className="p-4">
            {!selectedId ? (
              <p className="text-sm text-[var(--color-fg-subtle)]">{t('settingsBitrix.botSelectHint')}</p>
            ) : (
              <>
                <p className="mb-1 text-sm text-[var(--color-fg-subtle)]">{bound ? t('settingsBitrix.botActivePhrases') : t('settingsBitrix.botIdlePhrases')}</p>
                <p className="mb-3 text-[12px] leading-relaxed text-[var(--color-fg-subtle)]">{t('settingsBitrix.botMsgPlaceholders')}</p>
                <div className="grid gap-4 md:grid-cols-[210px_minmax(0,1fr)]">
                  <div className="flex gap-1 overflow-x-auto md:flex-col">
                    {KINDS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`shrink-0 rounded-lg px-3 py-2 text-left text-sm ${kind === item.id ? 'bg-[var(--color-bg-muted)] font-medium text-[var(--color-fg)] ring-1 ring-[var(--color-border)]' : 'text-[var(--color-fg-subtle)] hover:bg-[var(--color-bg-muted)]'}`}
                        onClick={() => setKind(item.id)}
                      >
                        {t(item.label)}
                      </button>
                    ))}
                  </div>
                  <div className="space-y-3">
                    <div className="rounded-2xl bg-[var(--color-bg-muted)]/70 px-3 py-3">
                      <div className="mb-2 text-[12px] font-medium text-[var(--color-fg-subtle)]">{t('settingsBitrix.botPreviewCaption')}</div>
                      <div className="flex items-end gap-2">
                        <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full text-xs font-semibold text-white" style={{ background: circle }}>
                          {avatarPreview ? <img src={avatarPreview} alt="" className="h-full w-full object-cover" /> : (displayName.trim().slice(0, 1) || 'Б').toUpperCase()}
                        </span>
                        <div className="min-w-0 max-w-[28rem]">
                          <div className="mb-1 truncate px-1 text-[12px] font-medium" style={{ color: circle }}>{displayName}</div>
                          <div className="whitespace-pre-wrap rounded-2xl rounded-bl-md bg-[var(--color-surface)] px-3 py-2 text-sm leading-relaxed text-[var(--color-fg)] shadow-sm">{renderBb(phraseBody)}</div>
                          {currentKind.id === 'ask' ? (
                            <div className="mt-1.5 px-1 text-[12px] text-[var(--color-fg-subtle)]">Отмена</div>
                          ) : currentKind.id === 'off' ? null : (
                            <div className="mt-1.5 flex flex-wrap gap-1.5 px-1">
                              <span className="rounded-lg bg-[var(--color-primary)] px-2.5 py-1 text-xs font-medium text-white">Оставить заявку</span>
                              <span className="rounded-lg bg-[var(--color-bg)] px-2.5 py-1 text-xs font-medium text-[var(--color-fg)]">Мои заявки</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    {currentKind.id === 'greet' ? (
                      <label className="flex items-start gap-2 text-sm">
                        <input className="mt-1" type="checkbox" checked={phrases.greet_daypart !== false} onChange={(event) => edit({ ...phrases, greet_daypart: event.target.checked })} />
                        <span>
                          <span className="font-medium">{t('settingsBitrix.botGreetDaypart')}</span>
                          <span className="mt-0.5 block text-[12px] leading-relaxed text-[var(--color-fg-subtle)]">{t('settingsBitrix.botGreetDaypartHint')}</span>
                        </span>
                      </label>
                    ) : null}
                    {currentKind.id === 'closed' ? (
                      <label className="flex items-start gap-2 text-sm">
                        <input className="mt-1" type="checkbox" checked={phrases.close_notice !== false} onChange={(event) => edit({ ...phrases, close_notice: event.target.checked })} />
                        <span>
                          <span className="font-medium">{t('settingsBitrix.botCloseNotice')}</span>
                          <span className="mt-0.5 block text-[12px] leading-relaxed text-[var(--color-fg-subtle)]">{t('settingsBitrix.botCloseNoticeHint')}</span>
                        </span>
                      </label>
                    ) : null}
                    {(TOKENS[currentKind.id] || []).length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {(TOKENS[currentKind.id] || []).map((token) => (
                          <button
                            key={token}
                            type="button"
                            className="rounded-full bg-[var(--color-bg-muted)] px-2.5 py-1 font-mono text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-border)]"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => insertAt(focusedField(), token)}
                          >
                            {token}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-1.5">
                      <button type="button" className={btn} onMouseDown={(event) => event.preventDefault()} onClick={() => wrap(focusedField(), '[b]', '[/b]')}>{t('settingsBitrix.botFormatBold')}</button>
                      <button type="button" className={btn} onMouseDown={(event) => event.preventDefault()} onClick={() => wrap(focusedField(), '[i]', '[/i]')}>{t('settingsBitrix.botFormatItalic')}</button>
                      <button type="button" className={btn} onMouseDown={(event) => event.preventDefault()} onClick={() => wrap(focusedField(), '[u]', '[/u]')}>{t('settingsBitrix.botFormatUnderline')}</button>
                      <button type="button" className={btn} onMouseDown={(event) => event.preventDefault()} onClick={() => wrap(focusedField(), `[color=${circle}]`, '[/color]')}>{t('settingsBitrix.botFormatColor')}</button>
                    </div>
                    {currentKind.fields.map((field) => (
                      <Field key={field} label={t(FIELD_LABEL[field])} hint={field === 'greeting_note' ? t('settingsBitrix.botGreetingNoteHint') : undefined}>
                        <textarea
                          ref={(node) => { fieldRefs.current[field] = node }}
                          className="app-input min-h-28 leading-relaxed"
                          maxLength={field === 'greeting_note' ? 400 : 800}
                          value={String(phrases[field] || '')}
                          placeholder={field === 'greeting_note' ? t('settingsBitrix.botGreetingNotePlaceholder') : PLACEHOLDER[field]}
                          onChange={(event) => edit({ ...phrases, [field]: event.target.value })}
                        />
                      </Field>
                    ))}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        className={btn}
                        onClick={() => {
                          const next = { ...phrases }
                          for (const field of currentKind.fields) next[field] = PLACEHOLDER[field] || ''
                          edit(next)
                        }}
                      >
                        {t('settingsBitrix.botResetPhrase')}
                      </button>
                      <div className="flex items-center gap-3">
                        <span className="text-[12px] text-[var(--color-fg-subtle)]">
                          {phraseStatus === 'restarting'
                            ? t('settingsBitrix.botRestarting')
                            : phraseStatus === 'saving'
                              ? t('settingsBitrix.botPhraseSaving')
                              : phraseStatus === 'saved'
                                ? t('settingsBitrix.botPhraseSaved')
                                : ''}
                        </span>
                        <button type="button" className={btnPrimary} disabled={busy || !selectedId} onClick={() => void applyMessages()}>
                          {t('settingsBitrix.botApplyMessages')}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : null}

        {pane === 'look' ? (
          <div className="space-y-4 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('settingsBitrix.botName')}>
                <input className="app-input" value={name} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field label={t('settingsBitrix.botLast')}>
                <input className="app-input" value={lastName} onChange={(event) => setLastName(event.target.value)} />
              </Field>
              <Field label={t('settingsBitrix.botPosition')}>
                <input className="app-input" value={position} onChange={(event) => setPosition(event.target.value)} />
              </Field>
              <Field label={t('settingsBitrix.botEmail')} hint={t('settingsBitrix.botEmailHint')}>
                <input className="app-input" type="email" autoComplete="off" value={email} placeholder="bot@example.com" onChange={(event) => setEmail(event.target.value)} />
              </Field>
              <Field label={t('settingsBitrix.botType')}>
                <select className="app-input app-select" value={botType} onChange={(event) => setBotType(event.target.value)}>
                  <option value="bot">{t('settingsBitrix.botTypeBot')}</option>
                  <option value="supervisor">{t('settingsBitrix.botTypeSupervisor')}</option>
                  <option value="personal">{t('settingsBitrix.botTypePersonal')}</option>
                </select>
              </Field>
              <Field label={t('settingsBitrix.botGender')}>
                <select className="app-input app-select" value={gender} onChange={(event) => setGender(event.target.value)}>
                  <option value="">{t('settingsBitrix.botGenderEmpty')}</option>
                  <option value="M">{t('settingsBitrix.botGenderM')}</option>
                  <option value="F">{t('settingsBitrix.botGenderF')}</option>
                </select>
              </Field>
              <Field label={t('settingsBitrix.botBackground')}>
                <select className="app-input app-select" value={background} onChange={(event) => setBackground(event.target.value)}>
                  {BACKGROUNDS.map((item) => (
                    <option key={item.id} value={item.id}>{t(item.label)}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full text-sm font-semibold text-white" style={{ background: circle }}>
                {avatarPreview ? <img src={avatarPreview} alt="" className="h-full w-full object-cover" /> : (name.trim().slice(0, 1) || 'Б').toUpperCase()}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {COLORS.map((item) => (
                  <button key={item} type="button" aria-label={item} title={item} className={`h-6 w-6 rounded-full border-2 ${color === item ? 'border-[var(--color-fg)]' : 'border-transparent'}`} style={{ background: COLOR_HEX[item] }} onClick={() => setColor(item)} />
                ))}
              </div>
            </div>
            <Field label={t('settingsBitrix.botAvatar')} hint={t('settingsBitrix.botAvatarHint')}>
              <input className="block text-sm" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => pickAvatar(event.target.files?.[0])} />
            </Field>
            {selected ? (
              <p className="text-[12px] text-[var(--color-fg-subtle)]">
                {t('settingsBitrix.botCounts', { messages: selected.count_message, chats: selected.count_chat, users: selected.count_user })}
              </p>
            ) : null}
            <div className="flex justify-end">
              <button
                type="button"
                className={btnPrimary}
                disabled={busy || !selectedId}
                onClick={() => void run(bound ? 'profile' : 'register', selectedId ?? undefined)}
              >
                {bound ? t('settingsBitrix.botProfile') : t('settingsBitrix.botUseThis')}
              </button>
            </div>
          </div>
        ) : null}

        {pane === 'extra' ? (
          <div className="space-y-4 p-4">
            <Field label={t('settingsBitrix.botEventMode')} hint={eventMode === 'webhook' ? t('settingsBitrix.botEventWebhookHint') : t('settingsBitrix.botEventFetchHint')}>
              <select
                className="app-input app-select"
                value={eventMode}
                disabled={busy}
                onChange={(event) => {
                  const next = event.target.value === 'webhook' ? 'webhook' : 'fetch'
                  setEventMode(next)
                  if (bot?.bot_id && bot.bot_id === selectedId && bot.webhook_set && bot.token_set) void pushMode(next)
                }}
              >
                <option value="fetch">{t('settingsBitrix.botEventFetch')}</option>
                <option value="webhook">{t('settingsBitrix.botEventWebhook')}</option>
              </select>
            </Field>
            <div className="space-y-2 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />{t('settingsBitrix.botHidden')}</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={reactions} onChange={(event) => setReactions(event.target.checked)} />{t('settingsBitrix.botReactions')}</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={openline} onChange={(event) => setOpenline(event.target.checked)} />{t('settingsBitrix.botOpenline')}</label>
            </div>
            {bot?.handler_url ? (
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-muted)]/50 px-3 py-2">
                <div className="text-[12px] font-medium text-[var(--color-fg-subtle)]">{t('settingsBitrix.botHandler')}</div>
                <p className="mt-1 break-all font-mono text-[12px] text-[var(--color-fg)]">{bot.handler_url}</p>
                <button type="button" className={`${btn} mt-2`} onClick={() => void copyHandler()}>{t('settingsBitrix.botHandlerCopy')}</button>
              </div>
            ) : null}
            <div className="flex justify-end">
              <button type="button" className={btnPrimary} disabled={busy || !selectedId} onClick={() => void run(bound ? 'profile' : 'register', selectedId ?? undefined)}>
                {bound ? t('settingsBitrix.botProfile') : t('settingsBitrix.botUseThis')}
              </button>
            </div>
          </div>
        ) : null}

        <AppModal
          open={connectOpen}
          onClose={() => setConnectOpen(false)}
          size="lg"
          title={t('settingsBitrix.botConnectTab')}
        >
          <div className="space-y-4">
            <Field label={t('settingsBitrix.botWebhook')} hint={t('settingsBitrix.botWebhookHint')}>
              <input className="app-input font-mono" type="password" autoComplete="off" value={webhook} placeholder={bot?.webhook_host || 'https://portal/rest/1/…'} onChange={(event) => setWebhook(event.target.value)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('settingsBitrix.botToken')} hint={t('settingsBitrix.botTokenHint')}>
                <input className="app-input font-mono" type="password" autoComplete="new-password" value={token} placeholder={bot?.token_set ? t('settingsBitrix.botTokenSet') : ''} onChange={(event) => setToken(event.target.value)} />
              </Field>
              <Field label={t('settingsBitrix.botCode')} hint={t('settingsBitrix.botCodeHint')}>
                <input className="app-input font-mono" value={code} placeholder="support_bot" onChange={(event) => setCode(event.target.value)} />
              </Field>
            </div>
            <Field label={t('settingsBitrix.botEventMode')} hint={eventMode === 'webhook' ? t('settingsBitrix.botEventWebhookHint') : t('settingsBitrix.botEventFetchHint')}>
              <select
                className="app-input app-select"
                value={eventMode}
                disabled={busy}
                onChange={(event) => {
                  const next = event.target.value === 'webhook' ? 'webhook' : 'fetch'
                  setEventMode(next)
                  if (bot?.bot_id && bot.bot_id === selectedId && bot.webhook_set && bot.token_set) void pushMode(next)
                }}
              >
                <option value="fetch">{t('settingsBitrix.botEventFetch')}</option>
                <option value="webhook">{t('settingsBitrix.botEventWebhook')}</option>
              </select>
            </Field>
            <div>
              <div className="mb-1 text-[13px] font-semibold text-[var(--color-fg-muted)]">{t('settingsBitrix.botPick')}</div>
              <p className="mb-2 text-[12px] leading-relaxed text-[var(--color-fg-subtle)]">{t('settingsBitrix.botPickHint')}</p>
              <div className="relative mb-2">
                <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
                <input className="app-input pl-9" value={pickQuery} placeholder={t('settingsBitrix.botSearch')} onChange={(event) => setPickQuery(event.target.value)} />
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-[var(--color-border)] p-1">
                <button
                  type="button"
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${botId === '' ? 'bg-[var(--color-bg-muted)] font-medium' : 'hover:bg-[var(--color-bg-muted)]'}`}
                  onClick={() => {
                    setBotId('')
                    setCode('')
                    setName('Бот заявок')
                    setLastName('')
                    setPosition('Приём заявок')
                    setEmail('')
                    setBotType('bot')
                  }}
                >
                  <span>{t('settingsBitrix.botCreateNew')}</span>
                </button>
                {suggestions.map((item) => {
                  const dot = COLOR_HEX[item.color as (typeof COLORS)[number]] ?? COLOR_HEX.GRAY
                  const title = item.name || item.code || `#${item.bot_id}`
                  const picked = botId === String(item.bot_id)
                  return (
                    <button
                      key={item.bot_id}
                      type="button"
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${picked ? 'bg-[var(--color-bg-muted)] font-medium' : 'hover:bg-[var(--color-bg-muted)]'}`}
                      onClick={() => {
                        setPickQuery('')
                        select(item.bot_id)
                      }}
                    >
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: dot }} />
                      <span className="min-w-0 flex-1 truncate">{title}</span>
                      <span className="font-mono text-[11px] text-[var(--color-fg-subtle)]">#{item.bot_id}</span>
                      <span className="hidden text-[11px] text-[var(--color-fg-subtle)] sm:inline">{roleLabel(item.bot_type)}</span>
                    </button>
                  )
                })}
                {!typedKnown && Number.isInteger(typedId) && typedId > 0 ? (
                  <button type="button" className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--color-bg-muted)]" onClick={() => setBotId(String(typedId))}>
                    <span>{t('settingsBitrix.botBind')}</span>
                    <span className="font-mono text-[11px]">#{typedId}</span>
                  </button>
                ) : null}
                {suggestions.length === 0 && !(Number.isInteger(typedId) && typedId > 0) ? (
                  <p className="px-3 py-4 text-sm text-[var(--color-fg-subtle)]">{listed ? t('settingsBitrix.botNoMatch') : t('settingsBitrix.botListNeedToken')}</p>
                ) : null}
              </div>
            </div>
            {bot?.handler_url ? (
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-muted)]/50 px-3 py-2">
                <div className="text-[12px] font-medium text-[var(--color-fg-subtle)]">{t('settingsBitrix.botHandler')}</div>
                <p className="mt-1 break-all font-mono text-[12px] text-[var(--color-fg)]">{bot.handler_url}</p>
                <button type="button" className={`${btn} mt-2`} onClick={() => void copyHandler()}>{t('settingsBitrix.botHandlerCopy')}</button>
              </div>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={btn} disabled={busy || !bot?.webhook_set} onClick={() => loadBots()}>{t('settingsBitrix.botReload')}</button>
              <button type="button" className={btn} disabled={busy} onClick={() => void run('save')}>{t('common.save')}</button>
              <button type="button" className={btnPrimary} disabled={busy} onClick={() => void run('register', botId ? Number(botId) : null)}>
                {botId ? t('settingsBitrix.botUseThis') : t('settingsBitrix.botCreate')}
              </button>
            </div>
          </div>
        </AppModal>
      </section>
    </div>
  )
}
