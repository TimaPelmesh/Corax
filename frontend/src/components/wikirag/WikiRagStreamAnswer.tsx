import { useEffect, useState } from 'react'
import { nextTypewriterChunk, typewriterWordsForBacklog } from '../../lib/wikiragTypewriter'
import { WikiRagMarkdown } from './WikiRagMarkdown'

export function StreamCaret() {
  return (
    <span
      className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse rounded-sm bg-[var(--color-primary)] align-text-bottom"
      aria-hidden
    />
  )
}

export function WikiRagStreamAnswer({ text, streaming }: { text: string; streaming: boolean }) {
  const [shown, setShown] = useState(streaming ? '' : text)

  useEffect(() => {
    if (!streaming) {
      setShown(text)
      return
    }
    let frame = 0
    const tick = () => {
      setShown((prev) => {
        if (prev === text) return prev
        const words = typewriterWordsForBacklog(Math.max(0, text.length - prev.length))
        return nextTypewriterChunk(prev, text, words)
      })
      frame = window.setTimeout(tick, 26)
    }
    frame = window.setTimeout(tick, 26)
    return () => window.clearTimeout(frame)
  }, [text, streaming])

  return (
    <>
      {shown.trim() ? <WikiRagMarkdown text={shown} /> : null}
      {streaming ? <StreamCaret /> : null}
    </>
  )
}
