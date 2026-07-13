import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { en } from './en'
import { ru, type MessageTree } from './ru'
import {
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

const catalogs: Record<Locale, MessageTree> = { ru, en }

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

  const setLocale = useCallback((next: Locale) => {
    document.documentElement.lang = next === 'en' ? 'en' : 'ru'
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
    setLocaleState(next)
  }, [])

  const t = useCallback(
    (key: MessageKey, params?: Record<string, string | number>) => {
      const catalog = catalogs[locale]
      const fallback = catalogs.ru
      const raw = getByPath(catalog, key) ?? getByPath(fallback, key) ?? key
      return interpolate(raw, params)
    },
    [locale],
  )

  const isNavHidden = useCallback((path: string) => hiddenNav.includes(path), [hiddenNav])

  const setNavHidden = useCallback((path: string, hidden: boolean) => {
    setHiddenNav((prev) => {
      const has = prev.includes(path)
      if (hidden && !has) return [...prev, path]
      if (!hidden && has) return prev.filter((p) => p !== path)
      return prev
    })
  }, [])

  const showAllNav = useCallback(() => setHiddenNav([]), [])

  const value = useMemo(
    () => ({ locale, setLocale, t, hiddenNav, isNavHidden, setNavHidden, showAllNav }),
    [locale, setLocale, t, hiddenNav, isNavHidden, setNavHidden, showAllNav],
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
  const raw = getByPath(catalogs[loc], key) ?? getByPath(catalogs.ru, key) ?? key
  return interpolate(raw, params)
}
