import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ru, type MessageTree } from './ru'
import {
  canonicalNavPath,
  detectInitialLocale,
  HIDDEN_NAV_STORAGE_KEY,
  interpolate,
  loadHiddenNav,
  LOCALE_STORAGE_KEY,
  type Locale,
} from './types'

type NestedKeyOf<T, Prefix extends string = ''> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends object
        ? NestedKeyOf<T[K], Prefix extends '' ? K : `${Prefix}.${K}`>
        : Prefix extends ''
          ? K
          : `${Prefix}.${K}`
    }[keyof T & string]
  : never

export type MessageKey = NestedKeyOf<MessageTree>

const catalogs: { ru: MessageTree; en?: MessageTree } = { ru }
let englishLoad: Promise<MessageTree> | null = null

/** Vitest registers the English tree before render. Production loads it on demand. */
export function registerEnglishCatalog(tree: MessageTree) {
  catalogs.en = tree
}

function loadEnglishCatalog(): Promise<MessageTree> {
  if (catalogs.en) return Promise.resolve(catalogs.en)
  if (!englishLoad) {
    englishLoad = import('./en').then((mod) => {
      catalogs.en = mod.en
      return mod.en
    })
  }
  return englishLoad
}

if (typeof window !== 'undefined' && detectInitialLocale() === 'en') {
  void loadEnglishCatalog()
}

function getByPath(tree: MessageTree, path: string): string | undefined {
  const parts = path.split('.')
  let cur: unknown = tree
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return typeof cur === 'string' ? cur : undefined
}

type LocaleContextValue = {
  locale: Locale
  catalogEpoch: number
  setLocale: (locale: Locale) => void
  t: (key: MessageKey, params?: Record<string, string | number>) => string
  hiddenNav: string[]
  isNavHidden: (path: string) => boolean
  setNavHidden: (path: string, hidden: boolean) => void
  showAllNav: () => void
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectInitialLocale())
  const [catalogEpoch, setCatalogEpoch] = useState(0)
  const [hiddenNav, setHiddenNav] = useState<string[]>(() => loadHiddenNav())

  useEffect(() => {
    document.documentElement.lang = locale === 'en' ? 'en' : 'ru'
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale)
    } catch {
      /* ignore */
    }
  }, [locale])

  useEffect(() => {
    try {
      localStorage.setItem(HIDDEN_NAV_STORAGE_KEY, JSON.stringify(hiddenNav))
    } catch {
      /* ignore */
    }
  }, [hiddenNav])

  useEffect(() => {
    if (locale !== 'en') return
    let cancelled = false
    void loadEnglishCatalog().then(() => {
      if (!cancelled) setCatalogEpoch((n) => n + 1)
    })
    return () => {
      cancelled = true
    }
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    document.documentElement.lang = next === 'en' ? 'en' : 'ru'
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
    if (next === 'en') void loadEnglishCatalog().then(() => setCatalogEpoch((n) => n + 1))
    setLocaleState(next)
  }, [])

  const t = useCallback(
    (key: MessageKey, params?: Record<string, string | number>) => {
      const catalog = locale === 'en' ? catalogs.en : catalogs.ru
      const raw = (catalog && getByPath(catalog, key)) ?? getByPath(catalogs.ru, key) ?? key
      return interpolate(raw, params)
    },
    [locale, catalogEpoch],
  )

  const isNavHidden = useCallback(
    (path: string) => hiddenNav.includes(canonicalNavPath(path)),
    [hiddenNav],
  )

  const setNavHidden = useCallback((path: string, hidden: boolean) => {
    const key = canonicalNavPath(path)
    setHiddenNav((prev) => {
      const has = prev.includes(key)
      if (hidden && !has) return [...prev, key]
      if (!hidden && has) return prev.filter((p) => p !== key)
      return prev
    })
  }, [])

  const showAllNav = useCallback(() => setHiddenNav([]), [])

  const value = useMemo(
    () => ({ locale, catalogEpoch, setLocale, t, hiddenNav, isNavHidden, setNavHidden, showAllNav }),
    [locale, catalogEpoch, setLocale, t, hiddenNav, isNavHidden, setNavHidden, showAllNav],
  )

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale() {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used within LocaleProvider')
  return ctx
}

export function useT() {
  return useLocale().t
}

/** Non-React helpers — prefers live `document.documentElement.lang`, then storage. */
export function translateStatic(key: MessageKey, locale?: Locale, params?: Record<string, string | number>) {
  const fromDom =
    typeof document !== 'undefined'
      ? document.documentElement.getAttribute('lang') === 'en'
        ? 'en'
        : document.documentElement.getAttribute('lang') === 'ru'
          ? 'ru'
          : null
      : null
  const loc = locale ?? fromDom ?? detectInitialLocale()
  if (loc === 'en' && !catalogs.en) void loadEnglishCatalog()
  const catalog = loc === 'en' ? catalogs.en : catalogs.ru
  const raw = (catalog && getByPath(catalog, key)) ?? getByPath(catalogs.ru, key) ?? key
  return interpolate(raw, params)
}
