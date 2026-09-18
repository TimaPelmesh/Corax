import { describe, expect, it } from 'vitest'
import {
  helpFormDocumentTitle,
  helpTicketAssigneesLine,
  helpTicketNo,
  helpTicketPhase,
  helpTicketPhaseChanges,
  helpTicketPhaseSnaps,
} from './helpTickets'

describe('helpTickets', () => {
  it('treats a new ticket without an assignee as waiting', () => {
    expect(helpTicketPhase('open', [])).toBe('waiting')
    expect(helpTicketPhase('new', [])).toBe('waiting')
  })

  it('marks a ticket taken when IT assigns someone or sets in_progress', () => {
    expect(helpTicketPhase('open', ['Иван Петров'])).toBe('taken')
    expect(helpTicketPhase('in_progress', [])).toBe('taken')
  })

  it('recognizes done and cancelled', () => {
    expect(helpTicketPhase('done', ['Иван'])).toBe('done')
    expect(helpTicketPhase('closed', [])).toBe('done')
    expect(helpTicketPhase('cancelled', [])).toBe('cancelled')
  })

  it('summarizes many assignees', () => {
    expect(helpTicketAssigneesLine(['Анна', 'Борис', 'Виктор'])).toBe('IT-поддержка')
    expect(helpTicketAssigneesLine(['Анна', 'Борис'])).toBe('Анна, Борис')
  })

  it('prefers the public ticket number', () => {
    expect(helpTicketNo(12, 90)).toBe('№12')
    expect(helpTicketNo(null, 90)).toBe('№90')
  })

  it('does not notify on the first snapshot', () => {
    const next = helpTicketPhaseSnaps([{ id: 1, ticket_no: 8, status: 'open', assignees: ['Анна'] }])
    expect(helpTicketPhaseChanges(null, next)).toEqual([])
  })

  it('notifies when a ticket is taken or finished', () => {
    const prev = helpTicketPhaseSnaps([{ id: 1, ticket_no: 8, status: 'open', assignees: [] }])
    const taken = helpTicketPhaseSnaps([{ id: 1, ticket_no: 8, status: 'open', assignees: ['Анна'] }])
    expect(helpTicketPhaseChanges(prev, taken)).toEqual([
      { id: 1, ticketNo: '№8', from: 'waiting', to: 'taken' },
    ])
    const done = helpTicketPhaseSnaps([{ id: 1, ticket_no: 8, status: 'done', assignees: ['Анна'] }])
    expect(helpTicketPhaseChanges(taken, done)[0].to).toBe('done')
  })

  it('puts unread count in the tab title', () => {
    expect(helpFormDocumentTitle('Оставить заявку', null, 0)).toBe('Оставить заявку')
    expect(helpFormDocumentTitle('Оставить заявку', null, 2)).toBe('(2) Оставить заявку')
    expect(helpFormDocumentTitle('Оставить заявку', '№8 взята в работу', 1)).toBe('№8 взята в работу')
  })
})
