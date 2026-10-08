/** Advance shown text toward target by whole words so the bubble types instead of jumping. */
export function nextTypewriterChunk(shown: string, target: string, words = 1): string {
  if (shown === target) return shown
  if (!target) return ''
  if (!shown) {
    const first = target.match(/^(\s*\S+)/)
    return first ? first[1] : target.slice(0, Math.min(3, target.length))
  }
  if (!target.startsWith(shown)) {
    let i = 0
    const max = Math.min(shown.length, target.length)
    while (i < max && shown[i] === target[i]) i++
    if (i < 8) {
      const first = target.match(/^(\s*\S+)/)
      return first ? first[1] : target.slice(0, Math.min(12, target.length))
    }
    shown = target.slice(0, i)
  }
  const rest = target.slice(shown.length)
  if (!rest) return shown
  let take = ''
  let remain = rest
  for (let n = 0; n < Math.max(1, words); n++) {
    const m = remain.match(/^(\s+\S+|\S+|\s+)/)
    if (!m) break
    take += m[1]
    remain = remain.slice(m[1].length)
  }
  if (!take) take = rest.slice(0, Math.min(3, rest.length))
  return shown + take
}

export function typewriterWordsForBacklog(backlogChars: number): number {
  if (backlogChars > 280) return 5
  if (backlogChars > 120) return 3
  if (backlogChars > 48) return 2
  return 1
}
