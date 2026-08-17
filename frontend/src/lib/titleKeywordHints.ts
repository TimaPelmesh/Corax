/** Keyword → title hints for public /h (mirrors backend title_keyword_hints.py). */

const TITLE_KEYWORD_HINTS: Array<{ keywords: string[]; title: string }> = [
  { keywords: ['bitrix', 'битрикс', 'б24', 'b24'], title: 'Проблема с Bitrix24' },
  { keywords: ['outlook', 'аутлук'], title: 'Проблема с почтой Outlook' },
  { keywords: ['почт', 'email', 'e-mail', 'письмо'], title: 'Проблема с почтой' },
  { keywords: ['принтер', 'печать', 'мфу', 'сканер', 'картридж'], title: 'Проблема с принтером' },
  { keywords: ['интернет', 'wifi', 'wi-fi', 'сеть', 'vpn'], title: 'Проблема с интернетом / сетью' },
  { keywords: ['телефон', 'атс', 'voip'], title: 'Проблема с телефонией' },
  { keywords: ['монитор', 'клавиатур', 'мыш', 'наушник'], title: 'Проблема с периферией' },
  { keywords: ['windows', 'синий экран', 'bsod', 'не включа'], title: 'Проблема с компьютером' },
  { keywords: ['1с', '1c', 'office', 'excel', 'word'], title: 'Проблема с программой' },
  { keywords: ['rdp', 'удаленн', 'remote', 'citrix'], title: 'Удалённый рабочий стол' },
  { keywords: ['zoom', 'teams', 'trueconf', 'видеоконферен', 'проектор'], title: 'Проблема с видеоконференцией' },
  { keywords: ['парол', 'учетн', 'учётн', 'логин', 'доступ'], title: 'Проблема с доступом / учётной записью' },
]

export function matchTitleHints(text: string, limit = 5): string[] {
  const raw = text.trim().toLowerCase()
  if (raw.length < 2) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const { keywords, title } of TITLE_KEYWORD_HINTS) {
    if (keywords.some((k) => raw.includes(k))) {
      if (!seen.has(title)) {
        seen.add(title)
        out.push(title)
      }
      if (out.length >= limit) break
    }
  }
  return out
}
