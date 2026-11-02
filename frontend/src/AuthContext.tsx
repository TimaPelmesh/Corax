/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { api, type User } from './api'
import { clearLoginGreeting } from './loginGreeting'
import { AUTH_USER_KEY, dropCache, peekCache, putCache } from './lib/viewCache'
import { prefetchShell } from './routePrefetch'

type AuthState = {
  user: User | null
  loading: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
  setUser: (u: User | null) => void
}

const Ctx = createContext<AuthState | null>(null)

function rememberUser(u: User | null) {
  if (!u) {
    dropCache(AUTH_USER_KEY)
    return
  }
  const { avatar_data: _avatar, ...rest } = u
  putCache(AUTH_USER_KEY, rest)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(() => peekCache<User>(AUTH_USER_KEY) ?? null)
  const [loading, setLoading] = useState(() => peekCache<User>(AUTH_USER_KEY) == null)

  const setUser = useCallback((u: User | null) => {
    rememberUser(u)
    setUserState(u)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const u = await api.me()
      setUser(u)
      setLoading(false)
      try {
        const avatar = await api.myAvatar()
        setUserState((cur) => (cur && cur.id === u.id ? { ...cur, avatar_data: avatar.avatar_data } : cur))
      } catch {
        /* initials are enough when the picture read is busy */
      }
    } catch (e) {
      const status = e instanceof Error ? (e as Error & { status?: number }).status : undefined
      if (status === 401 || status === 403 || peekCache<User>(AUTH_USER_KEY) == null) {
        setUser(null)
      }
      setLoading(false)
    }
  }, [setUser])

  useEffect(() => {
    prefetchShell()
    void refresh()
  }, [refresh])

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } catch {
      /* ignore */
    }
    clearLoginGreeting()
    setUser(null)
  }, [setUser])

  const value = useMemo(
    () => ({ user, loading, refresh, logout, setUser }),
    [user, loading, refresh, logout, setUser],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
