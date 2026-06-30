import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type User } from '../api'
import { useAuth } from '../AuthContext'
import { IconUsers } from '../components/icons'

export function UsersPage() {
  const { user } = useAuth()
  const [rows, setRows] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [isSuper, setIsSuper] = useState(false)
  const [role, setRole] = useState<'observer' | 'editor'>('observer')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')

  const load = useCallback(async () => {
    setErr(null)
    setLoading(true)
    try {
      const data = await api.users()
      setRows(data)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  /** Все активные учётки (локальные и LDAP). Раньше LDAP скрывали — из‑за этого логин «занят», а в таблице пусто. */
  const systemRows = useMemo(() => rows.filter((u) => u.is_active).sort((a, b) => a.username.localeCompare(b.username)), [rows])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    try {
      await api.createUser({
        username,
        password,
        full_name: fullName || null,
        is_superuser: isSuper,
        role,
      })
      setUsername('')
      setPassword('')
      setFullName('')
      setIsSuper(false)
      setRole('observer')
      void load()
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Ошибка')
    }
  }

  async function onChangeMyPassword(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    try {
      await api.changeMyPassword({ current_password: currentPassword, new_password: newPassword })
      setCurrentPassword('')
      setNewPassword('')
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Ошибка смены пароля')
    }
  }

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconUsers className="h-6 w-6" />
        </div>
        <div>
          <h1 className="page-title">Пользователи</h1>
          <p className="mt-1 text-slate-600">
            Администратор создаёт учётки вручную. Импорт из LDAP добавляет наблюдателей — роль «редактор» назначается
            отдельно.
          </p>
        </div>
      </div>

      {err && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          {err}
        </div>
      )}

      <div className="mt-2 grid gap-4 xl:grid-cols-2">
        <form onSubmit={onCreate} className="app-card space-y-4 p-6 sm:p-7">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Новый пользователь</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-slate-600">Логин</label>
              <input
                className="app-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-600">Пароль</label>
              <input
                type="password"
                className="app-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-600">ФИО (необязательно)</label>
            <input
              className="app-input"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={isSuper} onChange={(e) => setIsSuper(e.target.checked)} />
            Администратор
          </label>
          <div>
            <label className="mb-1 block text-xs text-slate-600">Роль (для не-админа)</label>
            <select
              className="app-input"
              value={role}
              onChange={(e) => setRole(e.target.value as 'observer' | 'editor')}
              disabled={isSuper}
            >
              <option value="observer">Наблюдатель</option>
              <option value="editor">Редактор</option>
            </select>
          </div>
          <button type="submit" className="app-btn app-btn-primary">
            Создать
          </button>
        </form>

        <form onSubmit={onChangeMyPassword} className="app-card space-y-4 p-6 sm:p-7">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Смена моего пароля</h2>
          <div>
            <label className="mb-1 block text-xs text-slate-600">Текущий пароль</label>
            <input
              type="password"
              className="app-input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-600">Новый пароль</label>
            <input
              type="password"
              className="app-input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={6}
              required
            />
          </div>
          <button type="submit" className="app-btn app-btn-secondary">
            Сменить пароль
          </button>
        </form>
      </div>

      <div className="app-card mt-6 overflow-hidden p-0">
        <div className="border-b border-neutral-200 px-4 py-3">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
            Активные учётные записи
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            LDAP-импорт: роль «наблюдатель» по умолчанию. Повысить до редактора или админа можно вручную.
          </p>
        </div>
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="min-w-[760px] w-full text-left text-sm">
            <thead className="app-table-head">
              <tr>
                <th className="px-4 py-3">Логин</th>
                <th className="px-4 py-3">Источник</th>
                <th className="px-4 py-3">ФИО</th>
                <th className="px-4 py-3">Статус</th>
                <th className="px-4 py-3">Роль</th>
                <th className="px-4 py-3">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    Загрузка…
                  </td>
                </tr>
              ) : (
                systemRows.map((u) => (
                  <tr key={u.id} className="app-table-row">
                    <td className="px-4 py-3 font-medium text-slate-900">{u.username}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {u.is_ldap ? (
                        <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-900">
                          LDAP
                        </span>
                      ) : (
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-800">
                          локально
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{u.full_name ?? '—'}</td>
                    <td className="px-4 py-3">
                      {u.is_active ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                          active
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                          inactive
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {u.is_superuser ? (
                        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-neutral-900">
                          admin
                        </span>
                      ) : (
                        <select
                          className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs text-slate-700"
                          value={u.role}
                          onChange={(e) => {
                            const nextRole = e.target.value as 'observer' | 'editor'
                            void (async () => {
                              await api.setUserRole(u.id, nextRole)
                              void load()
                            })().catch((error) => setErr(error instanceof Error ? error.message : 'Ошибка'))
                          }}
                        >
                          <option value="observer">observer</option>
                          <option value="editor">editor</option>
                        </select>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {!u.is_superuser ? (
                          <button
                            type="button"
                            className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                            onClick={() => {
                              void (async () => {
                                await api.setUserAdmin(u.id, true)
                                void load()
                              })().catch((error) => setErr(error instanceof Error ? error.message : 'Ошибка'))
                            }}
                          >
                            Сделать admin
                          </button>
                        ) : null}
                        {u.is_superuser && u.id !== user.id ? (
                          <button
                            type="button"
                            className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                            onClick={() => {
                              void (async () => {
                                await api.setUserAdmin(u.id, false)
                                void load()
                              })().catch((error) => setErr(error instanceof Error ? error.message : 'Ошибка'))
                            }}
                          >
                            Снять admin
                          </button>
                        ) : null}
                        {u.id !== user.id ? (
                          <button
                            type="button"
                            className="rounded-lg border border-red-200 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                            onClick={() => {
                              void (async () => {
                                await api.deleteUser(u.id)
                                void load()
                              })().catch((error) => setErr(error instanceof Error ? error.message : 'Ошибка'))
                            }}
                          >
                            Удалить
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
