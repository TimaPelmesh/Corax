/** Word-level autocomplete for public /h — real IT terms, prefix of the last word. */

const HELP_TERMS = [
  'картридж',
  'принтер',
  'сканер',
  'МФУ',
  'тонер',
  'бумага',
  'Outlook',
  'почта',
  'Bitrix24',
  '1С',
  'Excel',
  'Word',
  'интернет',
  'Wi-Fi',
  'VPN',
  'монитор',
  'клавиатура',
  'мышь',
  'наушники',
  'пароль',
  'логин',
  'доступ',
  'Teams',
  'Zoom',
  'проектор',
  'телефон',
  'Windows',
  'компьютер',
  'RDP',
  'Citrix',
] as const

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/ё/g, 'е')
}

export function lastTitleToken(text: string): { before: string; token: string } {
  const m = text.match(/^(.*?)([^\s.,;:!?«»"']+)$/u)
  if (!m) return { before: text, token: '' }
  return { before: m[1], token: m[2] }
}

export function applyTitleCompletion(text: string, term: string): string {
  const { before, token } = lastTitleToken(text)
  if (!token) {
    const pad = text && !/\s$/.test(text) ? ' ' : ''
    return `${text}${pad}${term}`
  }
  return `${before}${term}`
}

export function matchTitleHints(text: string, opts?: { limit?: number }): string[] {
  const { token } = lastTitleToken(text)
  if (token.length < 2) return []
  const q = norm(token)
  const limit = opts?.limit ?? 6
  const prefix: string[] = []
  const rest: string[] = []
  for (const term of HELP_TERMS) {
    const n = norm(term)
    if (!n) continue
    if (n === q) continue
    if (q.startsWith(n) && q.length >= n.length) continue
    if (n.startsWith(q)) {
      prefix.push(term)
      continue
    }
    if (q.length >= 4 && n.includes(q)) rest.push(term)
  }
  return [...prefix, ...rest].slice(0, limit)
}
