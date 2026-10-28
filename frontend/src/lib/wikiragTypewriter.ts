/** Reveal the answer by words. A long queue takes a few words per frame, never the whole paragraph. */

function wordsThisFrame(backlogChars: number): number {
  if (backlogChars > 700) return 4
  if (backlogChars > 280) return 3
  if (backlogChars > 80) return 2
  return 1
}

function nextWordEnd(text: string, from: number): number {
  let i = from
  while (i < text.length && /\s/.test(text[i])) i += 1
  while (i < text.length && !/\s/.test(text[i])) i += 1
  return i === from ? Math.min(text.length, from + 1) : i
}

export function nextTypewriterChunk(shown: string, target: string): string {
  if (!target) return ''
  if (shown === target) return shown
  if (!target.startsWith(shown)) {
    let i = 0
    const max = Math.min(shown.length, target.length)
    while (i < max && shown[i] === target[i]) i += 1
    shown = target.slice(0, i)
  }
  const rest = target.length - shown.length
  if (rest <= 0) return shown
  let end = shown.length
  const steps = wordsThisFrame(rest)
  for (let n = 0; n < steps && end < target.length; n += 1) {
    const next = nextWordEnd(target, end)
    if (next === end) break
    end = next
  }
  return target.slice(0, end)
}

/** Fast enough to feel like generation, slow enough that each word is visible. */
export function typewriterDelayMs(backlogChars: number): number {
  if (backlogChars > 700) return 16
  if (backlogChars > 280) return 20
  if (backlogChars > 80) return 26
  return 34
}
