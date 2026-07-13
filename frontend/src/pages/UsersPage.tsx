import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { api, type User } from '../api'
import { useAuth } from '../AuthContext'
import { IconUsers } from '../components/icons'
import { useT } from '../i18n/LocaleContext'

function isDirectoryUser(u: User) {
  return u.is_ldap || u.role === 'directory'
}

function isServiceAccount(u: User) {
  return u.is_active && !isDirectoryUser(u)
}

export function UsersPage() {
  const t = useT()
  const { user, refresh, logout } = useAuth()
  const nav = useNavigate()
  const [rows, setRows] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [isSuper, setIsSuper] = useState(false)
  const [role, setRole] = useState<'observer' | 'editor'>('observer')

  const [myUsername, setMyUsername] = useState('')
  const [myFullName, setMyFullName] = useState('')
  const [myEmail, setMyEmail] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')

  const [editId, setEditId] = useState<number | null>(null)
  const [editUsername, setEditUsername] = useState('')
  const [editFullName, setEditFullName] = useState('')
  const [editEmail, setEditEmail] = useState('')
  const [editPassword, setEditPassword] = useState('')

  const load = useCallback(async () => {
    setErr(null)
    setLoading(true)
    try {
      const data = await api.users()
      setRows(data)
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!user) return
    setMyUsername(user.username)
    setMyFullName(user.full_name ?? '')
    setMyEmail(user.email ?? '')
  }, [user])

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  const serviceRows = useMemo(
    () => rows.filter(isServiceAccount).sort((a, b) => a.username.localeCompare(b.username)),
    [rows],
  )
  const directoryRows = useMemo(
    () => rows.filter((u) => u.is_active && isDirectoryUser(u)).sort((a, b) => a.username.localeCompare(b.username)),
    [rows],
  )

  function openEdit(u: User) {
    setEditId(u.id)
    setEditUsername(u.username)
    setEditFullName(u.full_name ?? '')
    setEditEmail(u.email ?? '')
    setEditPassword('')
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    setOk(null)
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
      setOk(t('users.createdOk'))
      void load()
    } catch (err) {
      setErr(err instanceof Error ? err.message : t('common.error'))
    }
  }

  async function onUpdateMyProfile(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    setOk(null)
    try {
      const updated = await api.updateMyProfile({
        username: myUsername.trim(),
        full_name: myFullName.trim() || null,
        email: myEmail.trim() || null,
      })
      if (updated.username !== user?.username) {
        setOk(t('users.loginChanged'))
        await logout()
        nav('/login', { replace: true })
        return
      }
      await refresh()
      setOk(t('users.profileSaved'))
    } catch (error) {
      setErr(error instanceof Error ? error.message : t('common.error'))
    }
  }

  async function onChangeMyPassword(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    setOk(null)
    try {
      await api.changeMyPassword({ current_password: currentPassword, new_password: newPassword })
      setCurrentPassword('')
      setNewPassword('')
      setOk(t('users.passwordChanged'))
    } catch (error) {
      setErr(error instanceof Error ? error.message : t('users.passwordChangeFailed'))
    }
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault()
    if (editId == null) return
    setErr(null)
    setOk(null)
    try {
      await api.updateUser(editId, {
        username: editUsername.trim(),
        full_name: editFullName.trim() || null,
        email: editEmail.trim() || null,
        password: editPassword.trim() || undefined,
      })
      setEditId(null)
      setOk(t('users.accountUpdated'))
      void load()
    } catch (error) {
      setErr(error instanceof Error ? error.message : t('common.error'))
    }
  }

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconUsers className="h-6 w-6" />
        </div>
        <div>
          <h1 className="page-title">{t('titles.users')}</h1>
          <p className="mt-1 text-slate-600">{t('pages.usersSubtitle')}</p>
        </div>
      </div>

      {err ? (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{err}</div>
      ) : null}
      {ok ? (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
          {ok}
        </div>
      ) : null}

      <div className="mt-2 grid gap-4 xl:grid-cols-2">
        <form onSubmit={onUpdateMyProfile} className="app-card space-y-4 p-6 sm:p-7">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">{t('users.myProfile')}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-slate-600">{t('users.username')}</label>
              <input className="app-input" value={myUsername} onChange={(e) => setMyUsername(e.target.value)} required />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-600">{t('users.email')}</label>
              <input
                type="email"
                className="app-input"
                value={myEmail}
                onChange={(e) => setMyEmail(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-600">{t('users.fullName')}</label>
            <input className="app-input" value={myFullName} onChange={(e) => setMyFullName(e.target.value)} />
          </div>
          <button type="submit" className="app-btn app-btn-secondary">
            {t('users.saveProfile')}
          </button>
        </form>

        <form onSubmit={onChangeMyPassword} className="app-card space-y-4 p-6 sm:p-7">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">{t('users.changeMyPassword')}</h2>
          <div>
            <label className="mb-1 block text-xs text-slate-600">{t('users.currentPassword')}</label>
            <input
              type="password"
              className="app-input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-600">{t('users.newPassword')}</label>
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
            {t('users.changePassword')}
          </button>
        </form>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <form onSubmit={onCreate} className="app-card space-y-4 p-6 sm:p-7">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">{t('users.newAccount')}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-slate-600">{t('users.username')}</label>
              <input className="app-input" value={username} onChange={(e) => setUsername(e.target.value)} required />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-600">{t('users.password')}</label>
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
            <label className="mb-1 block text-xs text-slate-600">{t('users.fullNameOptional')}</label>
            <input className="app-input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={isSuper} onChange={(e) => setIsSuper(e.target.checked)} />
            {t('users.administrator')}
          </label>
          <div>
            <label className="mb-1 block text-xs text-slate-600">{t('users.roleForNonAdmin')}</label>
            <select
              className="app-input"
              value={role}
              onChange={(e) => setRole(e.target.value as 'observer' | 'editor')}
              disabled={isSuper}
            >
              <option value="observer">{t('roles.viewer')}</option>
              <option value="editor">{t('roles.editor')}</option>
            </select>
          </div>
          <button type="submit" className="app-btn app-btn-primary">
            {t('users.create')}
          </button>
        </form>

        {editId != null ? (
          <form onSubmit={onSaveEdit} className="app-card space-y-4 p-6 sm:p-7">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">{t('users.editAccount')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs text-slate-600">{t('users.username')}</label>
                <input
                  className="app-input"
                  value={editUsername}
                  onChange={(e) => setEditUsername(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-600">{t('users.newPasswordOptional')}</label>
                <input
                  type="password"
                  className="app-input"
                  value={editPassword}
                  onChange={(e) => setEditPassword(e.target.value)}
                  minLength={6}
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-600">{t('users.fullName')}</label>
              <input className="app-input" value={editFullName} onChange={(e) => setEditFullName(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-600">{t('users.email')}</label>
              <input
                type="email"
                className="app-input"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <button type="submit" className="app-btn app-btn-primary">
                {t('common.save')}
              </button>
              <button type="button" className="app-btn app-btn-secondary" onClick={() => setEditId(null)}>
                {t('common.cancel')}
              </button>
            </div>
          </form>
        ) : (
          <div className="app-card flex items-center justify-center p-6 text-sm text-slate-500">
            {t('users.pickEditHint')}
          </div>
        )}
      </div>

      <div className="app-card mt-6 overflow-hidden p-0">
        <div className="border-b border-neutral-200 px-4 py-3">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">{t('users.coraxAccounts')}</h2>
          <p className="mt-1 text-xs text-slate-500">{t('users.coraxAccountsHint')}</p>
        </div>
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="min-w-[760px] w-full text-left text-sm">
            <thead className="app-table-head">
              <tr>
                <th className="px-4 py-3">{t('users.username')}</th>
                <th className="px-4 py-3">{t('users.fullName')}</th>
                <th className="px-4 py-3">{t('users.role')}</th>
                <th className="px-4 py-3">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                    {t('common.loading')}
                  </td>
                </tr>
              ) : serviceRows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                    {t('users.noLocalAccounts')}
                  </td>
                </tr>
              ) : (
                serviceRows.map((u) => (
                  <tr key={u.id} className="app-table-row">
                    <td className="px-4 py-3 font-medium text-slate-900">{u.username}</td>
                    <td className="px-4 py-3 text-slate-600">{u.full_name ?? '—'}</td>
                    <td className="px-4 py-3">
                      {u.is_superuser ? (
                        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-neutral-900">
                          admin
                        </span>
                      ) : (
                        <select
                          className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs text-slate-700"
                          value={u.role === 'directory' ? 'observer' : u.role}
                          onChange={(e) => {
                            const nextRole = e.target.value as 'observer' | 'editor'
                            void (async () => {
                              await api.setUserRole(u.id, nextRole)
                              void load()
                            })().catch((error) => setErr(error instanceof Error ? error.message : t('common.error')))
                          }}
                        >
                          <option value="observer">observer</option>
                          <option value="editor">editor</option>
                        </select>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                          onClick={() => openEdit(u)}
                        >
                          {t('common.edit')}
                        </button>
                        {!u.is_superuser ? (
                          <button
                            type="button"
                            className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                            onClick={() => {
                              void (async () => {
                                await api.setUserAdmin(u.id, true)
                                void load()
                              })().catch((error) => setErr(error instanceof Error ? error.message : t('common.error')))
                            }}
                          >
                            {t('users.makeAdmin')}
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
                              })().catch((error) => setErr(error instanceof Error ? error.message : t('common.error')))
                            }}
                          >
                            {t('users.revokeAdmin')}
                          </button>
                        ) : null}
                        {u.id !== user.id ? (
                          <button
                            type="button"
                            className="rounded-lg border border-blue-200 bg-white px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50"
                            onClick={() => {
                              void (async () => {
                                await api.deleteUser(u.id)
                                void load()
                              })().catch((error) => setErr(error instanceof Error ? error.message : t('common.error')))
                            }}
                          >
                            {t('common.delete')}
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

      <div className="app-card mt-6 overflow-hidden p-0">
        <div className="border-b border-neutral-200 px-4 py-3">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">{t('users.directoryTitle')}</h2>
          <p className="mt-1 text-xs text-slate-500">{t('users.directoryHint')}</p>
        </div>
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="min-w-[640px] w-full text-left text-sm">
            <thead className="app-table-head">
              <tr>
                <th className="px-4 py-3">{t('users.username')}</th>
                <th className="px-4 py-3">{t('users.source')}</th>
                <th className="px-4 py-3">{t('users.fullName')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {loading ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-slate-500">
                    {t('common.loading')}
                  </td>
                </tr>
              ) : directoryRows.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-slate-500">
                    {t('users.directoryEmpty')}
                  </td>
                </tr>
              ) : (
                directoryRows.map((u) => (
                  <tr key={u.id} className="app-table-row">
                    <td className="px-4 py-3 font-medium text-slate-900">{u.username}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {u.is_ldap ? (
                        <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-900">LDAP</span>
                      ) : (
                        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-900">
                          {t('users.importBadge')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{u.full_name ?? '—'}</td>
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
