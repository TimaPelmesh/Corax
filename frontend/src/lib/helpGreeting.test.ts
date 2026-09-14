import { describe, expect, it } from 'vitest'
import { dayPartGreetingKey, helpGreeting } from './helpGreeting'

describe('dayPartGreetingKey', () => {
  it('maps office hours', () => {
    expect(dayPartGreetingKey(new Date(2026, 0, 1, 8))).toBe('ticketHandler.helpForm.greetMorning')
    expect(dayPartGreetingKey(new Date(2026, 0, 1, 14))).toBe('ticketHandler.helpForm.greetAfternoon')
    expect(dayPartGreetingKey(new Date(2026, 0, 1, 19))).toBe('ticketHandler.helpForm.greetEvening')
    expect(dayPartGreetingKey(new Date(2026, 0, 1, 1))).toBe('ticketHandler.helpForm.greetNight')
  })
})

describe('helpGreeting', () => {
  it('appends the AD display name', () => {
    expect(helpGreeting('Иван Иванов', 'Доброго дня')).toBe('Доброго дня, Иван Иванов')
  })

  it('works without a name', () => {
    expect(helpGreeting('  ', 'Доброго утра')).toBe('Доброго утра')
  })
})
