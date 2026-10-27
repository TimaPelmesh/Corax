/** Follow the stream. A short token appears at once. A long burst eases in by characters, not words. */
export function nextTypewriterChunk(shown: string, target: string): string {
  if (!target) return ''
  if (shown === target) return shown
  if (!target.startsWith(shown)) {
    let i = 0
    const max = Math.min(shown.length, target.length)
    while (i < max && shown[i] === target[i]) i++
    shown = target.slice(0, i)
  }
  const rest = target.length - shown.length
  if (rest <= 0) return shown
  if (rest <= 12) return target
  const take = Math.min(rest, Math.max(4, Math.ceil(rest / 2)))
  return target.slice(0, shown.length + take)
}

/** A few milliseconds. The caret should stay with the model, not a word behind it. */
export function typewriterDelayMs(backlogChars: number): number {
  if (backlogChars > 80) return 8
  if (backlogChars > 16) return 12
  return 16
}
