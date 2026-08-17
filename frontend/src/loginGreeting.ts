const SS_KEY_LOGIN_TOAST = 'inventory.login_toast_username'

let pendingLoginUsername: string | null = null

/** Вызывать сразу после успешного login (до refresh/navigate). */
export function markLoginGreeting(username: string) {
  const u = username.trim() || username
  pendingLoginUsername = u
  try {
    window.sessionStorage.setItem(SS_KEY_LOGIN_TOAST, u)
  } catch {
    // privacy mode / blocked storage
  }
}

/** Прочитать флаг приветствия, не удаляя (удаление — после показа тоста). */
export function peekLoginGreeting(): string | null {
  if (pendingLoginUsername) return pendingLoginUsername
  try {
    return window.sessionStorage.getItem(SS_KEY_LOGIN_TOAST)
  } catch {
    return null
  }
}

export function clearLoginGreeting() {
  pendingLoginUsername = null
  try {
    window.sessionStorage.removeItem(SS_KEY_LOGIN_TOAST)
  } catch {
    // ignore
  }
}
