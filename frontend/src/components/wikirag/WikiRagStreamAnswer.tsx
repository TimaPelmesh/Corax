import { useEffect, useRef, useState } from 'react'
import { nextTypewriterChunk, typewriterDelayMs } from '../../lib/wikiragTypewriter'
import { WikiRagMarkdown } from './WikiRagMarkdown'

export function StreamCaret() {
  return <span className="wikirag-caret" aria-hidden />
}

/** Keep the bubble on the stream. Short tokens show at once; only a long burst eases in. */
function useLiveTyped(text: string, streaming: boolean) {
  const shownRef = useRef(text)
  const [shown, setShown] = useState(text)

  useEffect(() => {
    if (!streaming) {
      shownRef.current = text
      setShown(text)
      return
    }
    let timer = 0
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      const next = nextTypewriterChunk(shownRef.current, text)
      if (next !== shownRef.current) {
        shownRef.current = next
        setShown(next)
      }
      if (next !== text) {
        timer = window.setTimeout(tick, typewriterDelayMs(text.length - next.length))
      }
    }
    tick()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [text, streaming])

  return streaming ? shown : text
}

export function WikiRagStreamAnswer({ text, streaming }: { text: string; streaming: boolean }) {
  const visible = useLiveTyped(text, streaming)
  if (!visible.trim()) return streaming ? <StreamCaret /> : null
  return <WikiRagMarkdown text={visible} streaming={streaming} />
}
