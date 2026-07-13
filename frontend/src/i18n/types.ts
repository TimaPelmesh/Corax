export type Locale = 'ru' | 'en'

export const LOCALE_STORAGE_KEY = 'corax-locale'
export const HIDDEN_NAV_STORAGE_KEY = 'corax-hidden-nav'

export function detectInitialLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (saved === 'en' || saved === 'ru') return saved
  } catch {
    /* ignore */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : 'ru'
  return nav.startsWith('en') ? 'en' : 'ru'
}

export function loadHiddenNav(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_NAV_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    params[key] != null ? String(params[key]) : `{${key}}`,
  )
}
