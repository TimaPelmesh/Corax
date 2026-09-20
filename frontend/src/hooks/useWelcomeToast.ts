import { useEffect, useState } from 'react'
import { useLocale, type MessageKey } from '../i18n/LocaleContext'
import { clearLoginGreeting, peekLoginGreeting } from '../loginGreeting'

function dayGreetingKey(date = new Date()): MessageKey {
  const hour = date.getHours()
  if (hour >= 5 && hour < 12) return 'greet.morning'
  if (hour >= 12 && hour < 18) return 'greet.afternoon'
  if (hour >= 18 && hour < 23) return 'greet.evening'
  return 'greet.night'
}

export function useWelcomeToast(user: { full_name?: string | null; username?: string } | null) {
  const { t } = useLocale()
  const [welcomeToast, setWelcomeToast] = useState<string | null>(null)
  const [welcomeToastLeaving, setWelcomeToastLeaving] = useState(false)

  useEffect(() => {
    if (!user) return
    const stored = peekLoginGreeting()
    if (!stored) return
    const accountName = user.full_name?.trim() || user.username || stored
    setWelcomeToastLeaving(false)
    setWelcomeToast(`${t(dayGreetingKey())}, ${accountName}`)
  }, [user, t])

  useEffect(() => {
    if (!welcomeToast) return
    const exitTimer = window.setTimeout(() => setWelcomeToastLeaving(true), 4600)
    const removeTimer = window.setTimeout(() => {
      setWelcomeToast(null)
      setWelcomeToastLeaving(false)
      clearLoginGreeting()
    }, 5000)
    return () => {
      window.clearTimeout(exitTimer)
      window.clearTimeout(removeTimer)
    }
  }, [welcomeToast])

  return { welcomeToast, welcomeToastLeaving }
}
