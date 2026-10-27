/** Time-of-day greeting keys for the public /h form. */

import type { MessageKey } from '../i18n/LocaleContext'

export function dayPartGreetingKey(date: Date = new Date()): MessageKey {
  const h = date.getHours()
  if (h >= 5 && h < 12) return 'ticketHandler.helpForm.greetMorning'
  if (h >= 12 && h < 18) return 'ticketHandler.helpForm.greetAfternoon'
  if (h >= 18 && h < 23) return 'ticketHandler.helpForm.greetEvening'
  return 'ticketHandler.helpForm.greetNight'
}

/** «Good afternoon, Jane Doe» — display name only, no account in parentheses. */
export function helpGreeting(person: string, hi: string): string {
  const name = person.trim()
  return name ? `${hi}, ${name}` : hi
}
