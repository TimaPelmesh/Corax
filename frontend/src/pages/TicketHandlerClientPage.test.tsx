import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../i18n/LocaleContext'

const apiMock = vi.hoisted(() => ({
  ticketHandlerPublicContext: vi.fn(),
  ticketHandlerPublicTickets: vi.fn(),
  ticketHandlerIntake: vi.fn(),
}))

vi.mock('../api', () => ({
  api: apiMock,
}))

import { TicketHandlerClientPage } from './TicketHandlerClientPage'

describe('TicketHandlerClientPage', () => {
  beforeEach(() => {
    localStorage.setItem('corax-locale', 'ru')
    window.location.hash = '#pc=pc-lab-01'
    apiMock.ticketHandlerPublicContext.mockResolvedValue({
      enabled: true,
      hostname: 'pc-lab-01',
      computer_id: 4,
      location: '214',
      requester_hint: 'Иван Петров (ivanov)',
    })
    apiMock.ticketHandlerPublicTickets.mockResolvedValue({
      items: [
        {
          id: 8,
          ticket_no: 8,
          title: 'Не печатает',
          status: 'open',
          assignees: [],
          opened_at: '2026-09-18T10:00:00Z',
          updated_at: '2026-09-18T10:00:00Z',
          closed_at: null,
        },
      ],
    })
    apiMock.ticketHandlerIntake.mockResolvedValue({
      ok: true,
      request_id: 9,
      ticket_no: 9,
    })
  })

  afterEach(() => {
    cleanup()
    window.location.hash = ''
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('shows existing tickets and their waiting status', async () => {
    render(
      <LocaleProvider>
        <TicketHandlerClientPage />
      </LocaleProvider>,
    )
    expect(await screen.findByText('Ваши заявки')).toBeInTheDocument()
    expect(screen.getByText('Не печатает')).toBeInTheDocument()
    expect(screen.getByText('Ожидает')).toBeInTheDocument()
    expect(screen.queryByText('Ещё не взята в работу')).not.toBeInTheDocument()
  })

  it('opens a ticket modal on click with submitted and closed dates', async () => {
    render(
      <LocaleProvider>
        <TicketHandlerClientPage />
      </LocaleProvider>,
    )
    const row = await screen.findByRole('button', { name: /Статус заявки №8/ })
    fireEvent.mouseEnter(row)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Оставлена')).not.toBeInTheDocument()
    fireEvent.click(row)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Оставлена')
    expect(dialog).toHaveTextContent('Закрыта')
    expect(dialog).toHaveTextContent('Ещё не закрыта')
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the closed date in the ticket modal', async () => {
    apiMock.ticketHandlerPublicTickets.mockResolvedValue({
      items: [
        {
          id: 8,
          ticket_no: 8,
          title: 'Не печатает',
          status: 'done',
          assignees: ['Анна'],
          opened_at: '2026-09-18T10:00:00Z',
          updated_at: '2026-09-18T12:00:00Z',
          closed_at: '2026-09-18T12:00:00Z',
        },
      ],
    })
    render(
      <LocaleProvider>
        <TicketHandlerClientPage />
      </LocaleProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /Статус заявки №8/ }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Сделана')
    expect(dialog).toHaveTextContent('Закрыта')
    expect(dialog).not.toHaveTextContent('Ещё не закрыта')
  })

  it('updates the tab title when a ticket is taken, without opening the accordion', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] })
    const waiting = {
      id: 8,
      ticket_no: 8,
      title: 'Не печатает',
      status: 'open',
      assignees: [] as string[],
      opened_at: '2026-09-18T10:00:00Z',
      updated_at: '2026-09-18T10:00:00Z',
      closed_at: null,
    }
    let items = [waiting]
    apiMock.ticketHandlerPublicTickets.mockImplementation(async () => ({ items }))

    render(
      <LocaleProvider>
        <TicketHandlerClientPage />
      </LocaleProvider>,
    )
    expect(await screen.findByText('Ожидает')).toBeInTheDocument()
    expect(screen.queryByText('Ещё не взята в работу')).not.toBeInTheDocument()

    items = [{ ...waiting, assignees: ['Анна'], updated_at: '2026-09-18T10:05:00Z' }]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000)
    })

    expect(await screen.findByText('В работе')).toBeInTheDocument()
    expect(document.title).toMatch(/№8 взята в работу/)
    expect(screen.getByText(/IT взяли заявку в работу/)).toBeInTheDocument()
    expect(screen.queryByText('Взяли: Анна')).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('shows a form notice when a ticket is completed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] })
    const waiting = {
      id: 8,
      ticket_no: 8,
      title: 'Не печатает',
      status: 'open',
      assignees: [] as string[],
      opened_at: '2026-09-18T10:00:00Z',
      updated_at: '2026-09-18T10:00:00Z',
      closed_at: null,
    }
    let items: Array<Record<string, unknown>> = [waiting]
    apiMock.ticketHandlerPublicTickets.mockImplementation(async () => ({ items }))

    render(
      <LocaleProvider>
        <TicketHandlerClientPage />
      </LocaleProvider>,
    )
    expect(await screen.findByText('Ожидает')).toBeInTheDocument()

    items = [
      {
        ...waiting,
        status: 'done',
        assignees: ['Анна'],
        updated_at: '2026-09-18T12:00:00Z',
        closed_at: '2026-09-18T12:00:00Z',
      },
    ]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000)
    })

    expect(await screen.findByText('№8 выполнена')).toBeInTheDocument()
    expect(screen.getByText(/IT отметили заявку как выполненную/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('№8 выполнена'))
    expect(await screen.findByRole('dialog')).toHaveTextContent('Сделана')
    vi.useRealTimers()
  })

  it('lists the new ticket after submit', async () => {
    let items: Array<Record<string, unknown>> = []
    apiMock.ticketHandlerPublicTickets.mockImplementation(async () => ({ items }))
    apiMock.ticketHandlerIntake.mockImplementation(async () => {
      items = [
        {
          id: 9,
          ticket_no: 9,
          title: 'Замена картриджа',
          status: 'open',
          assignees: [],
          opened_at: '2026-09-18T11:00:00Z',
          updated_at: '2026-09-18T11:00:00Z',
          closed_at: null,
        },
      ]
      return { ok: true, request_id: 9, ticket_no: 9 }
    })

    render(
      <LocaleProvider>
        <TicketHandlerClientPage />
      </LocaleProvider>,
    )
    const title = await screen.findByPlaceholderText(/поменять картридж/i)
    fireEvent.change(title, { target: { value: 'Замена картриджа' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отправить заявку' }))

    expect(await screen.findByText(/Заявка принята, №9/)).toBeInTheDocument()
    expect(await screen.findByText('Замена картриджа')).toBeInTheDocument()
  })
})
