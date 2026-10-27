import { useEffect, useState } from 'react'
import { useT } from '../../i18n/LocaleContext'
import { formatTokenRate, ollamaTokenRate } from '../../lib/wikiragTokenRate'

export function WikiRagTokenRate({
  provider,
  streaming,
  streamTokens,
  streamChars,
  streamStartedAt,
  tokensPerSecond,
}: {
  provider?: string | null
  streaming: boolean
  streamTokens?: number
  streamChars?: number
  streamStartedAt?: number
  tokensPerSecond?: number | null
}) {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!streaming || provider !== 'ollama') return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [streaming, provider])

  const rate = ollamaTokenRate({
    provider,
    streaming,
    streamTokens,
    streamChars,
    streamStartedAt,
    tokensPerSecond,
    now,
  })
  if (rate == null) return null
  const label = formatTokenRate(rate)
  if (!label) return null

  return (
    <p className="wikirag-tps mt-1.5 text-[11px] tabular-nums tracking-wide text-[var(--color-fg-subtle)]">
      {label} {t('wikirag.chat.tokensPerSec')}
    </p>
  )
}
