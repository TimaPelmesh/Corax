export type ThemeMode = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'corax.theme'

export function readStoredTheme(): ThemeMode | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // ignore storage failures
  }
  return null
}

export function resolveInitialTheme(): ThemeMode {
  const stored = readStoredTheme()
  if (stored) return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
