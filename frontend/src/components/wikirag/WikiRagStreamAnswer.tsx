import { useEffect, useRef, useState } from 'react'
import { nextTypewriterChunk, typewriterDelayMs } from '../../lib/wikiragTypewriter'
import { WikiRagMarkdown } from './WikiRagMarkdown'

export function StreamCaret() {
  return <span className="wikirag-caret" aria-hidden />
}

function prefersStillText(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Words keep landing after the socket closes. The finished answer must not pop in. */
function useLiveTyped(text: string, streaming: boolean) {
  const targetRef = useRef(text)
  targetRef.current = text
  const shownRef = useRef(streaming ? '' : text)
  const [shown, setShown] = useState(streaming ? '' : text)

  useEffect(() => {
    let timer = 0
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      const target = targetRef.current
      if (prefersStillText()) {
        if (shownRef.current !== target) {
          shownRef.current = target
          setShown(target)
        }
        return
      }
      const next = nextTypewriterChunk(shownRef.current, target)
      if (next !== shownRef.current) {
        shownRef.current = next
        setShown(next)
      }
      if (next !== target) {
        timer = window.setTimeout(tick, typewriterDelayMs(target.length - next.length))
      }
    }
    tick()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [text, streaming])

  return shown
}

export function WikiRagStreamAnswer({ text, streaming }: { text: string; streaming: boolean }) {
  const visible = useLiveTyped(text, streaming)
  const caughtUp = visible === text
  const [paintWords, setPaintWords] = useState(streaming)

  useEffect(() => {
    if (streaming || !caughtUp) {
      setPaintWords(true)
      return
    }
    const timer = window.setTimeout(() => setPaintWords(false), 240)
    return () => window.clearTimeout(timer)
  }, [streaming, caughtUp])

  if (!visible.trim()) return paintWords ? <StreamCaret /> : null
  return <WikiRagMarkdown text={visible} streaming={paintWords} />
}
