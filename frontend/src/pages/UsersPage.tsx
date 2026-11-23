import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { api, type RemoteAssistMode, type TagBrief, type User } from '../api'
import { useAuth } from '../AuthContext'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

type PcPick = { id: number; hostname: string }

function assistSummary(
  u: User,
  tagsById: Map<number, string>,
  hostsById: Map<number, string>,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (u.is_superuser) return t('users.assistFullAccess')
  if (u.role !== 'editor') return t('users.assistNoRole')
  const mode = (u.remote_assist_mode || 'all') as RemoteAssistMode
  if (mode === 'all') return t('users.assistSummaryAll')
  const tagNames = (u.remote_assist_tag_ids || [])
    .map((id) => tagsById.get(id) || `#${id}`)
    .filter(Boolean)
  const hosts = (u.remote_assist_computer_ids || [])
    .map((id) => hostsById.get(id) || `id:${id}`)
    .filter(Boolean)
  const parts = [...tagNames, ...hosts]
  if (!parts.length) return t('users.assistSummaryEmpty')
  const joined = parts.slice(0, 4).join(', ') + (parts.length > 4 ? ` +${parts.length - 4}` : '')
  return mode === 'allow'
    ? t('users.assistSummaryAllow', { parts: joined })
    : t('users.assistSummaryDeny', { parts: joined })
}

function isDirectoryUser(u: User) {
  return u.is_ldap || u.role === 'directory'
}

function isServiceAccount(u: User) {
  return u.is_active && !isDirectoryUser(u)
}

function personSortKey(u: User): string {
  return `${(u.full_name || '').trim()} ${u.username}`.trim().toLocaleLowerCase('ru')
}

function directoryLabel(u: User) {
  return u.full_name ? `${u.full_name} (${u.username})` : u.username
}

function sortPeople(a: User, b: User) {
  return personSortKey(a).localeCompare(personSortKey(b), 'ru', { sensitivity: 'base' })
}

/** Поиск AD/LDAP-учётки по ФИО/логину, список по алфавиту. */
function AdAccountPicker({
  people,
  value,
  onChange,
  label,
  hint,
  noneLabel,
  placeholder,
}: {
  people: User[]
  value: number | null
  onChange: (id: number | null) => void
  label: string
  hint: string
  noneLabel: string
  placeholder: string
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const selected = useMemo(() => people.find((p) => p.id === value) ?? null, [people, value])

  useEffect(() => {
    if (!open) setQuery(selected ? directoryLabel(selected) : '')
  }, [selected, open, value])

  const filtered = useMemo(() => {
    const sorted = [...people].sort(sortPeople)
    const q = query.trim().toLowerCase()
    if (!q || (selected && directoryLabel(selected).toLowerCase() === q)) return sorted
    return sorted.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        (u.full_name ?? '').toLowerCase().includes(q) ||
        directoryLabel(u).toLowerCase().includes(q),
    )
  }, [people, query, selected])

  return (
    <div>
      <label className="app-label">{label}</label>
      <div className="relative">
        <input
          className="app-input"
          value={query}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => {
            setOpen(true)
            setQuery('')
          }}
          onBlur={() => {
            window.setTimeout(() => {
              setOpen(false)
              setQuery(selected ? directoryLabel(selected) : '')
            }, 160)
          }}
        />
        {open ? (
          <ul
            className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
            role="listbox"
          >
            <li>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(null)
                  setQuery('')
                  setOpen(false)
                }}
              >
                {noneLabel}
              </button>
            </li>
            {filtered.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  className={`w-full px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-muted)] ${
                    value === u.id ? 'bg-[var(--color-primary-muted)] font-medium text-[var(--color-fg)]' : 'text-[var(--color-fg)]'
                  }`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(u.id)
                    setQuery(directoryLabel(u))
                    setOpen(false)
                  }}
                >
                  <span className="block truncate">{u.full_name?.trim() || u.username}</span>
                  {u.full_name?.trim() ? (
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-[var(--color-fg-subtle)]">
                      {u.username}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-[var(--color-fg-subtle)]">{t('common.nothingFound')}</li>
            ) : null}
          </ul>
        ) : null}
      </div>
      <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">{hint}</p>
    </div>
  )
}

export function UsersPage() {
  const t = useT()
  const toast = useToast()
  const { user, refresh, logout } = useAuth()
  const nav = useNavigate()
  const [rows, setRows] = useState<User[]>([])
  const [loading, setLoading] = useState(true)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [isSuper, setIsSuper] = useState(false)
  const [role, setRole] = useState<'observer' | 'editor' | 'llm-operator'>('observer')

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
  const [editLinkedId, setEditLinkedId] = useState<number | null>(null)
  const [editAssistMode, setEditAssistMode] = useState<RemoteAssistMode>('all')
  const [editAssistTagIds, setEditAssistTagIds] = useState<number[]>([])
  const [editAssistPcs, setEditAssistPcs] = useState<PcPick[]>([])
  const [pcQuery, setPcQuery] = useState('')
  const [pcHits, setPcHits] = useState<PcPick[]>([])
  const [allTags, setAllTags] = useState<TagBrief[]>([])
  const [hostLabels, setHostLabels] = useState<Map<number, string>>(() => new Map())
  const [linkedDirectoryId, setLinkedDirectoryId] = useState<number | null>(null)
  const [section, setSection] = useState<'profile' | 'accounts' | 'directory'>('accounts')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [data, tags] = await Promise.all([api.users(), api.tags().catch(() => [] as TagBrief[])])
      setRows(data)
      setAllTags(tags)
      const needIds = new Set<number>()
      for (const u of data) {
        for (const id of u.remote_assist_computer_ids || []) needIds.add(id)
      }
      if (needIds.size) {
        const labels = new Map<number, string>()
        await Promise.all(
          [...needIds].slice(0, 80).map(async (id) => {
            try {
              const c = await api.computer(id, { includeSoftware: false })
              labels.set(id, c.hostname)
            } catch {
              labels.set(id, `id:${id}`)
            }
          }),
        )
        setHostLabels(labels)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const q = pcQuery.trim()
    if (q.length < 2) {
      setPcHits([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void api
        .computers({ q, limit: 12, view: 'list' })
        .then((res) => {
          if (cancelled) return
          const items = (res.items || []).map((c) => ({ id: c.id, hostname: c.hostname }))
          setPcHits(items)
        })
        .catch(() => {
          if (!cancelled) setPcHits([])
        })
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [pcQuery])

  useEffect(() => {
    if (!user) return
    setMyUsername(user.username)
    setMyFullName(user.full_name ?? '')
    setMyEmail(user.email ?? '')
  }, [user])

  const serviceRows = useMemo(
    () => rows.filter(isServiceAccount).sort((a, b) => a.username.localeCompare(b.username)),
    [rows],
  )
  const directoryRows = useMemo(
    () => rows.filter((u) => u.is_active && isDirectoryUser(u)).sort(sortPeople),
    [rows],
  )
  const linkTakenBy = useMemo(() => {
    const map = new Map<number, string>()
    for (const u of serviceRows) {
      if (u.linked_directory_user_id) map.set(u.linked_directory_user_id, u.username)
    }
    return map
  }, [serviceRows])

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  const tagsById = useMemo(() => {
    const m = new Map<number, string>()
    for (const tag of allTags) m.set(tag.id, tag.name)
    return m
  }, [allTags])

  function openEdit(u: User) {
    setEditId(u.id)
    setEditUsername(u.username)
    setEditFullName(u.full_name ?? '')
    setEditEmail(u.email ?? '')
    setEditPassword('')
    setEditLinkedId(u.linked_directory_user_id ?? null)
    setEditAssistMode((u.remote_assist_mode || 'all') as RemoteAssistMode)
    setEditAssistTagIds([...(u.remote_assist_tag_ids || [])])
    const pcs: PcPick[] = (u.remote_assist_computer_ids || []).map((id) => ({
      id,
      hostname: hostLabels.get(id) || `id:${id}`,
    }))
    setEditAssistPcs(pcs)
    setPcQuery('')
    setPcHits([])
    setSection('accounts')
  }

  function startGrantAccess(dir: User) {
    const base = dir.username.trim()
    const exists = rows.some((u) => u.is_active && u.username.toLowerCase() === base.toLowerCase())
    setUsername(exists ? `${base}.corax` : base)
    setFullName(dir.full_name ?? '')
    setPassword('')
    setIsSuper(false)
    setRole('observer')
    setLinkedDirectoryId(dir.id)
    setEditId(null)
    setSection('accounts')
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    try {
      await api.createUser({
        username,
        password,
        full_name: fullName || null,
        is_superuser: isSuper,
        role,
        linked_directory_user_id: linkedDirectoryId,
      })
      setUsername('')
      setPassword('')
      setFullName('')
      setIsSuper(false)
      setRole('observer')
      setLinkedDirectoryId(null)
      toast.ok(t('users.createdOk'))
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'))
    }
  }

  async function onUpdateMyProfile(e: FormEvent) {
    e.preventDefault()
    try {
      const updated = await api.updateMyProfile({
        username: myUsername.trim(),
        full_name: myFullName.trim() || null,
        email: myEmail.trim() || null,
      })
      if (updated.username !== user?.username) {
        toast.ok(t('users.loginChanged'))
        await logout()
        nav('/login', { replace: true })
        return
      }
      await refresh()
      toast.ok(t('users.profileSaved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'))
    }
  }

  async function onChangeMyPassword(e: FormEvent) {
    e.preventDefault()
    try {
      await api.changeMyPassword({ current_password: currentPassword, new_password: newPassword })
      setCurrentPassword('')
      setNewPassword('')
      toast.ok(t('users.passwordChanged'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('users.passwordChangeFailed'))
    }
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault()
    if (editId == null) return
    const editing = serviceRows.find((u) => u.id === editId)
    try {
      await api.updateUser(editId, {
        username: editUsername.trim(),
        full_name: editFullName.trim() || null,
        email: editEmail.trim() || null,
        password: editPassword.trim() || undefined,
        linked_directory_user_id: editLinkedId,
        ...(editing && !editing.is_superuser && editing.role === 'editor'
          ? {
              remote_assist_mode: editAssistMode,
              remote_assist_tag_ids: editAssistTagIds,
              remote_assist_computer_ids: editAssistPcs.map((p) => p.id),
            }
          : {}),
      })
      setEditId(null)
      toast.ok(t('users.accountUpdated'))
      void load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'))
    }
  }

  const editUser = editId != null ? serviceRows.find((u) => u.id === editId) : null
  const showAssistEditor = Boolean(editUser && !editUser.is_superuser && editUser.role === 'editor')
  const showAssistLists = showAssistEditor && editAssistMode !== 'all'

  function availableAdPeople(currentLinkedId: number | null) {
    return directoryRows.filter((d) => {
      const taken = linkTakenBy.get(d.id)
      return !taken || d.id === currentLinkedId
    })
  }

  return (
    <div className="settings-page settings-page--wide">
      <div className="mb-4 flex flex-wrap gap-1.5">
        {(
          [
            ['profile', 'users.tabProfile'],
            ['accounts', 'users.tabAccounts'],
            ['directory', 'users.tabDirectory'],
          ] as const
        ).map(([id, key]) => (
          <button
            key={id}
            type="button"
            onClick={() => setSection(id)}
            className={`app-chip ${section === id ? 'app-chip--active' : ''}`}
          >
            {t(key)}
          </button>
        ))}
      </div>

      {section === 'profile' ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <form onSubmit={onUpdateMyProfile} className="app-card space-y-4 p-6 sm:p-7">
            <h2 className="text-[13px] font-semibold text-[var(--color-fg-subtle)]">
              {t('users.myProfile')}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="app-label">{t('users.username')}</label>
                <input className="app-input" value={myUsername} onChange={(e) => setMyUsername(e.target.value)} required />
              </div>
              <div>
                <label className="app-label">{t('users.email')}</label>
                <input
                  type="email"
                  className="app-input"
                  value={myEmail}
                  onChange={(e) => setMyEmail(e.target.value)}
                />
              </div>
            </div>
            <div>
              <label className="app-label">{t('users.fullName')}</label>
              <input className="app-input" value={myFullName} onChange={(e) => setMyFullName(e.target.value)} />
            </div>
            <button type="submit" className="app-btn app-btn-secondary">
              {t('users.saveProfile')}
            </button>
          </form>

          <form onSubmit={onChangeMyPassword} className="app-card space-y-4 p-6 sm:p-7">
            <h2 className="text-[13px] font-semibold text-[var(--color-fg-subtle)]">
              {t('users.changeMyPassword')}
            </h2>
            <div>
              <label className="app-label">{t('users.currentPassword')}</label>
              <input
                type="password"
                className="app-input"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="app-label">{t('users.newPassword')}</label>
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
      ) : null}

      {section === 'accounts' ? (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <form onSubmit={onCreate} className="app-card space-y-4 p-6 sm:p-7">
              <h2 className="text-[13px] font-semibold text-[var(--color-fg-subtle)]">
                {t('users.newAccount')}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="app-label">{t('users.username')}</label>
                  <input className="app-input" value={username} onChange={(e) => setUsername(e.target.value)} required />
                </div>
                <div>
                  <label className="app-label">{t('users.password')}</label>
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
                <label className="app-label">{t('users.fullNameOptional')}</label>
                <input className="app-input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
              </div>
              <AdAccountPicker
                people={availableAdPeople(linkedDirectoryId)}
                value={linkedDirectoryId}
                onChange={setLinkedDirectoryId}
                label={t('users.linkDirectory')}
                hint={t('users.linkDirectoryHint')}
                noneLabel={t('users.linkNone')}
                placeholder={t('users.linkSearchPlaceholder')}
              />
              <label className="flex items-center gap-2 text-sm text-[var(--color-fg)]">
                <input type="checkbox" checked={isSuper} onChange={(e) => setIsSuper(e.target.checked)} />
                {t('users.administrator')}
              </label>
              <div>
                <label className="app-label">{t('users.roleForNonAdmin')}</label>
                <select
                  className="app-input"
                  value={role}
                  onChange={(e) => setRole(e.target.value as 'observer' | 'editor' | 'llm-operator')}
                  disabled={isSuper}
                >
                  <option value="observer">{t('roles.viewer')}</option>
                  <option value="editor">{t('roles.editor')}</option>
                  <option value="llm-operator">{t('roles.llmOperator')}</option>
                </select>
              </div>
              <button type="submit" className="app-btn app-btn-primary">
                {t('users.create')}
              </button>
            </form>

            {editId != null ? (
              <form onSubmit={onSaveEdit} className="app-card space-y-4 p-6 sm:p-7">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[13px] font-semibold text-[var(--color-fg-subtle)]">
                    {t('users.editAccount')}
                  </h2>
                  <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg)]">
                    {t('users.coraxAccountBadge')}
                  </span>
                  {editUser?.is_superuser ? (
                    <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] font-medium">
                      admin
                    </span>
                  ) : (
                    <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] font-medium">
                      {editUser?.role || 'observer'}
                    </span>
                  )}
                </div>
                <p className="text-sm text-[var(--color-fg)]">
                  <span className="font-semibold">{editUsername}</span>
                  {editFullName ? (
                    <span className="text-[var(--color-fg-muted)]"> · {editFullName}</span>
                  ) : null}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="app-label">{t('users.username')}</label>
                    <input
                      className="app-input"
                      value={editUsername}
                      onChange={(e) => setEditUsername(e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label className="app-label">{t('users.newPasswordOptional')}</label>
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
                  <label className="app-label">{t('users.fullName')}</label>
                  <input className="app-input" value={editFullName} onChange={(e) => setEditFullName(e.target.value)} />
                </div>
                <div>
                  <label className="app-label">{t('users.email')}</label>
                  <input
                    type="email"
                    className="app-input"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                  />
                </div>
                <AdAccountPicker
                  people={availableAdPeople(editLinkedId)}
                  value={editLinkedId}
                  onChange={setEditLinkedId}
                  label={t('users.linkDirectory')}
                  hint={t('users.linkDirectoryHint')}
                  noneLabel={t('users.linkNone')}
                  placeholder={t('users.linkSearchPlaceholder')}
                />

                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]/40 p-4 space-y-3">
                  <div>
                    <h3 className="text-[13px] font-semibold text-[var(--color-fg)]">{t('users.assistRights')}</h3>
                    <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('users.assistRightsHint')}</p>
                  </div>
                  {editUser?.is_superuser ? (
                    <p className="text-sm font-medium text-[var(--color-fg)]">{t('users.assistFullAccess')}</p>
                  ) : editUser?.role !== 'editor' ? (
                    <p className="text-sm text-[var(--color-fg-muted)]">{t('users.assistNoRole')}</p>
                  ) : (
                    <>
                      <div>
                        <label className="app-label">{t('users.assistMode')}</label>
                        <select
                          className="app-input"
                          value={editAssistMode}
                          onChange={(e) => setEditAssistMode(e.target.value as RemoteAssistMode)}
                        >
                          <option value="all">{t('users.assistModeAll')}</option>
                          <option value="allow">{t('users.assistModeAllow')}</option>
                          <option value="deny">{t('users.assistModeDeny')}</option>
                        </select>
                      </div>
                      {showAssistLists ? (
                        <>
                          <div>
                            <label className="app-label">{t('users.assistTags')}</label>
                            <div className="mt-1 flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
                              {allTags.length === 0 ? (
                                <span className="text-xs text-[var(--color-fg-muted)]">—</span>
                              ) : (
                                allTags.map((tag) => {
                                  const on = editAssistTagIds.includes(tag.id)
                                  return (
                                    <button
                                      key={tag.id}
                                      type="button"
                                      className={`rounded-full border px-2.5 py-1 text-xs ${
                                        on
                                          ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-fg)]'
                                          : 'border-[var(--color-border)] text-[var(--color-fg-muted)]'
                                      }`}
                                      onClick={() =>
                                        setEditAssistTagIds((prev) =>
                                          on ? prev.filter((x) => x !== tag.id) : [...prev, tag.id],
                                        )
                                      }
                                    >
                                      {tag.name}
                                    </button>
                                  )
                                })
                              )}
                            </div>
                          </div>
                          <div>
                            <label className="app-label">{t('users.assistComputers')}</label>
                            <div className="mt-1 flex gap-2">
                              <input
                                className="app-input"
                                value={pcQuery}
                                onChange={(e) => setPcQuery(e.target.value)}
                                placeholder={t('users.assistPcSearch')}
                              />
                            </div>
                            {pcHits.length ? (
                              <ul className="mt-1 max-h-32 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
                                {pcHits.map((hit) => (
                                  <li key={hit.id}>
                                    <button
                                      type="button"
                                      className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-[var(--color-bg-muted)]"
                                      onClick={() => {
                                        setEditAssistPcs((prev) =>
                                          prev.some((p) => p.id === hit.id) ? prev : [...prev, hit],
                                        )
                                        setHostLabels((prev) => new Map(prev).set(hit.id, hit.hostname))
                                        setPcQuery('')
                                        setPcHits([])
                                      }}
                                    >
                                      <span>{hit.hostname}</span>
                                      <span className="text-xs text-[var(--color-fg-muted)]">{t('users.assistPcAdd')}</span>
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {editAssistPcs.length === 0 ? (
                                <span className="text-xs text-[var(--color-fg-muted)]">{t('users.assistPcNone')}</span>
                              ) : (
                                editAssistPcs.map((pc) => (
                                  <button
                                    key={pc.id}
                                    type="button"
                                    className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-fg)]"
                                    onClick={() => setEditAssistPcs((prev) => prev.filter((x) => x.id !== pc.id))}
                                  >
                                    {pc.hostname} ×
                                  </button>
                                ))
                              )}
                            </div>
                          </div>
                        </>
                      ) : null}
                    </>
                  )}
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
              <div className="app-card flex items-center justify-center p-6 text-sm text-[var(--color-fg-muted)]">
                {t('users.pickEditHint')}
              </div>
            )}
          </div>

          <div className="app-card app-table-shell mt-4 overflow-hidden p-0">
            <div className="border-b border-[var(--color-border)] px-4 py-3">
              <h2 className="text-[13px] font-semibold text-[var(--color-fg-subtle)]">
                {t('users.coraxAccounts')}
              </h2>
              <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('users.coraxAccountsHint')}</p>
            </div>
            <div className="overflow-x-auto overscroll-x-contain">
              <table className="app-table min-w-[980px] w-full text-left text-sm">
                <thead className="app-table-head">
                  <tr>
                    <th className="app-table-sticky-col px-4 py-3">{t('users.username')}</th>
                    <th className="px-4 py-3">{t('users.fullName')}</th>
                    <th className="app-hide-xs px-4 py-3">{t('users.linkColumn')}</th>
                    <th className="app-hide-xs px-4 py-3">{t('users.role')}</th>
                    <th className="app-hide-sm px-4 py-3">{t('users.assistColumn')}</th>
                    <th className="px-4 py-3">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {loading ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                        {t('common.loading')}
                      </td>
                    </tr>
                  ) : serviceRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                        {t('users.noLocalAccounts')}
                      </td>
                    </tr>
                  ) : (
                    serviceRows.map((u) => (
                      <tr key={u.id} className="app-table-row">
                        <td className="app-table-sticky-col px-4 py-3 font-medium text-[var(--color-fg)]">{u.username}</td>
                        <td className="px-4 py-3 text-[var(--color-fg-muted)]">{u.full_name ?? '—'}</td>
                        <td className="app-hide-xs px-4 py-3 text-[var(--color-fg-muted)]">
                          {u.linked_directory_username ? (
                            <span className="text-[var(--color-fg)]">
                              {u.linked_directory_full_name
                                ? `${u.linked_directory_full_name} (${u.linked_directory_username})`
                                : u.linked_directory_username}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="app-hide-xs px-4 py-3">
                          {u.is_superuser ? (
                            <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-xs font-medium text-[var(--color-fg)]">
                              admin
                            </span>
                          ) : (
                            <select
                              className="app-input !min-h-0 !w-auto !px-2 !py-1 !text-xs"
                              value={u.role === 'directory' ? 'observer' : u.role}
                              onChange={(e) => {
                                const nextRole = e.target.value as 'observer' | 'editor' | 'llm-operator'
                                void (async () => {
                                  await api.setUserRole(u.id, nextRole)
                                  void load()
                                })().catch((error) => toast.error(error instanceof Error ? error.message : t('common.error')))
                              }}
                            >
                              <option value="observer">observer</option>
                              <option value="editor">editor</option>
                              <option value="llm-operator">llm-operator</option>
                            </select>
                          )}
                        </td>
                        <td className="app-hide-sm max-w-[220px] px-4 py-3 text-xs text-[var(--color-fg-muted)]">
                          {assistSummary(u, tagsById, hostLabels, t)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-2 !py-1 !text-xs" onClick={() => openEdit(u)}>
                              {t('common.edit')}
                            </button>
                            {!u.is_superuser ? (
                              <button
                                type="button"
                                className="app-btn app-btn-secondary !min-h-0 !px-2 !py-1 !text-xs"
                                onClick={() => {
                                  void (async () => {
                                    await api.setUserAdmin(u.id, true)
                                    void load()
                                  })().catch((error) => toast.error(error instanceof Error ? error.message : t('common.error')))
                                }}
                              >
                                {t('users.makeAdmin')}
                              </button>
                            ) : null}
                            {u.is_superuser && u.id !== user.id ? (
                              <button
                                type="button"
                                className="app-btn app-btn-secondary !min-h-0 !px-2 !py-1 !text-xs"
                                onClick={() => {
                                  void (async () => {
                                    await api.setUserAdmin(u.id, false)
                                    void load()
                                  })().catch((error) => toast.error(error instanceof Error ? error.message : t('common.error')))
                                }}
                              >
                                {t('users.revokeAdmin')}
                              </button>
                            ) : null}
                            {u.id !== user.id ? (
                              <button
                                type="button"
                                className="app-btn app-btn-danger !min-h-0 !px-2 !py-1 !text-xs"
                                onClick={() => {
                                  void (async () => {
                                    await api.deleteUser(u.id)
                                    void load()
                                  })().catch((error) => toast.error(error instanceof Error ? error.message : t('common.error')))
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
        </>
      ) : null}

      {section === 'directory' ? (
        <div className="app-card app-table-shell overflow-hidden p-0">
          <div className="border-b border-[var(--color-border)] px-4 py-3">
            <h2 className="text-[13px] font-semibold text-[var(--color-fg-subtle)]">
              {t('users.directoryTitle')}
            </h2>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('users.directoryHint')}</p>
          </div>
          <div className="overflow-x-auto overscroll-x-contain">
            <table className="app-table min-w-[720px] w-full text-left text-sm">
              <thead className="app-table-head">
                <tr>
                  <th className="app-table-sticky-col px-4 py-3">{t('users.username')}</th>
                  <th className="px-4 py-3">{t('users.source')}</th>
                  <th className="px-4 py-3">{t('users.fullName')}</th>
                  <th className="px-4 py-3">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {loading ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                      {t('common.loading')}
                    </td>
                  </tr>
                ) : directoryRows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                      {t('users.directoryEmpty')}
                    </td>
                  </tr>
                ) : (
                  directoryRows.map((u) => {
                    const linkedLogin = linkTakenBy.get(u.id)
                    return (
                      <tr key={u.id} className="app-table-row">
                        <td className="app-table-sticky-col px-4 py-3 font-medium text-[var(--color-fg)]">{u.username}</td>
                        <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                          {u.is_ldap ? (
                            <span className="rounded-full bg-[var(--color-info-bg)] px-2 py-0.5 text-xs font-medium text-[var(--color-info-fg)]">
                              LDAP
                            </span>
                          ) : (
                            <span className="rounded-full bg-[var(--color-primary-muted)] px-2 py-0.5 text-xs font-medium text-[var(--color-primary)]">
                              {t('users.importBadge')}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-[var(--color-fg-muted)]">{u.full_name ?? '—'}</td>
                        <td className="px-4 py-3">
                          {linkedLogin ? (
                            <span className="text-xs text-[var(--color-fg-subtle)]">
                              {t('users.alreadyLinked')}: {linkedLogin}
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="app-btn app-btn-secondary !min-h-0 !px-2 !py-1 !text-xs"
                              title={t('users.grantAccessHint')}
                              onClick={() => startGrantAccess(u)}
                            >
                              {t('users.grantAccess')}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  )
}
