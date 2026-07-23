import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { THEME_STORAGE_KEY, type ThemeMode } from './theme'

type ThemeContextValue = {
  theme: ThemeMode
  setTheme: (mode: ThemeMode, origin?: { x: number; y: number }) => void
  toggleTheme: (origin?: { x: number; y: number }) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function applyTheme(mode: ThemeMode) {
  document.documentElement.setAttribute('data-theme', mode)
  document.documentElement.style.colorScheme = mode
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(
    () => (document.documentElement.getAttribute('data-theme') as ThemeMode | null) ?? 'light',
  )

  useEffect(() => {
    applyTheme(theme)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // ignore storage failures
    }
  }, [theme])

  const setTheme = (mode: ThemeMode, origin?: { x: number; y: number }) => {
    if (mode === theme) return

    const root = document.documentElement
    const x = origin?.x ?? window.innerWidth / 2
    const y = origin?.y ?? window.innerHeight / 2
    root.style.setProperty('--theme-x', `${x}px`)
    root.style.setProperty('--theme-y', `${y}px`)

    const commit = () => {
      flushSync(() => {
        setThemeState(mode)
        applyTheme(mode)
      })
    }

    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { finished: Promise<void> }
    }

    if (typeof doc.startViewTransition === 'function') {
      root.classList.add('theme-animating')
      // Paint target theme bg immediately so the wipe never flashes a void
      root.style.backgroundColor = mode === 'dark' ? '#000000' : '#f0f2f5'
      const transition = doc.startViewTransition(commit)
      void transition.finished.finally(() => {
        root.classList.remove('theme-animating')
        root.style.removeProperty('background-color')
      })
      return
    }

    root.classList.add('theme-fade')
    window.setTimeout(() => {
      commit()
      window.setTimeout(() => root.classList.remove('theme-fade'), 360)
    }, 50)
  }

  const toggleTheme = (origin?: { x: number; y: number }) => {
    setTheme(theme === 'light' ? 'dark' : 'light', origin)
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
