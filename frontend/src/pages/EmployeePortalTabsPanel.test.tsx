import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../i18n/LocaleContext'

const apiMock = vi.hoisted(() => ({
  ticketHandlerConfig: vi.fn(),
  updateTicketHandlerConfig: vi.fn(),
}))

vi.mock('../api', () => ({
  api: apiMock,
}))

vi.mock('../ToastContext', () => ({
  useToast: () => ({
    ok: vi.fn(),
    error: vi.fn(),
  }),
}))

import { EmployeePortalTabsPanel } from './EmployeePortalTabsPanel'

describe('EmployeePortalTabsPanel', () => {
  beforeEach(() => {
    localStorage.setItem('corax-locale', 'en')
    apiMock.ticketHandlerConfig.mockResolvedValue({ employee_tabs: [] })
    apiMock.updateTicketHandlerConfig.mockResolvedValue({ employee_tabs: [] })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows empty state and can add a tab', async () => {
    render(
      <LocaleProvider>
        <EmployeePortalTabsPanel />
      </LocaleProvider>,
    )

    expect(await screen.findByText(/No tabs yet/i)).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /Add tab/i })[0])

    expect(await screen.findByDisplayValue('New tab')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/For example: Phones/i)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Visible')
  })

  it('loads existing tabs into collapsible editors', async () => {
    apiMock.ticketHandlerConfig.mockResolvedValue({
      employee_tabs: [
        {
          id: 'tab-1',
          title: 'Phones',
          kind: 'text',
          body: '101',
          columns: ['Name', 'Value'],
          rows: [['', '']],
          enabled: true,
        },
      ],
    })

    render(
      <LocaleProvider>
        <EmployeePortalTabsPanel />
      </LocaleProvider>,
    )

    expect(await screen.findByDisplayValue('Phones')).toBeInTheDocument()
    expect(screen.getByDisplayValue('101')).toBeInTheDocument()
    expect(screen.queryByText(/No tabs yet/i)).not.toBeInTheDocument()
  })

  it('saves tabs via API', async () => {
    apiMock.updateTicketHandlerConfig.mockResolvedValue({
      employee_tabs: [
        {
          id: 'saved',
          title: 'New tab',
          kind: 'text',
          body: '',
          columns: ['Имя', 'Значение'],
          rows: [['', '']],
          enabled: true,
        },
      ],
    })

    render(
      <LocaleProvider>
        <EmployeePortalTabsPanel />
      </LocaleProvider>,
    )

    await screen.findByText(/No tabs yet/i)
    fireEvent.click(screen.getAllByRole('button', { name: /Add tab/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))

    await waitFor(() => {
      expect(apiMock.updateTicketHandlerConfig).toHaveBeenCalled()
    })
    const payload = apiMock.updateTicketHandlerConfig.mock.calls[0][0]
    expect(payload.employee_tabs).toHaveLength(1)
    expect(payload.employee_tabs[0].title).toBe('New tab')
  })
})
