import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../i18n/LocaleContext'

const apiMock = vi.hoisted(() => ({
  computers: vi.fn(),
  printers: vi.fn(),
  serviceRequests: vi.fn(),
}))

const toastApi = vi.hoisted(() => ({
  show: vi.fn(),
  info: vi.fn(),
  ok: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  busy: vi.fn(),
  dismiss: vi.fn(),
}))

const authValue = vi.hoisted(() => ({
  user: {
    id: 1,
    username: 'admin',
    full_name: 'Admin',
    is_superuser: true,
    is_active: true,
    role: 'editor',
    is_ldap: false,
  },
  loading: false,
  refresh: vi.fn(),
  logout: vi.fn(),
  setUser: vi.fn(),
}))

vi.mock('../api', () => ({
  api: apiMock,
}))

vi.mock('../AuthContext', () => ({
  useAuth: () => authValue,
}))

vi.mock('../ThemeContext', () => ({
  useTheme: () => ({
    theme: 'light',
    setTheme: vi.fn(),
    toggleTheme: vi.fn(),
  }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('../ToastContext', () => ({
  useToast: () => toastApi,
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}))

import { AppTopBar } from './AppTopBar'

describe('AppTopBar search', () => {
  beforeEach(() => {
    apiMock.computers.mockResolvedValue({
      items: [
        {
          id: 11,
          hostname: 'pc-lab-01',
          ip_address: '192.168.1.50',
          model: 'OptiPlex',
        },
      ],
      total: 1,
    })
    apiMock.printers.mockResolvedValue([])
    apiMock.serviceRequests.mockResolvedValue({ items: [], total: 0 })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows host/IP hits in a z-50 dropdown', async () => {
    const view = render(
      <MemoryRouter>
        <LocaleProvider>
          <AppTopBar />
        </LocaleProvider>
      </MemoryRouter>,
    )

    const input = screen.getByLabelText(/Глобальный поиск|Global search/i)
    fireEvent.change(input, { target: { value: '192.168' } })
    fireEvent.focus(input)

    await waitFor(
      () => {
        expect(screen.getByText('pc-lab-01')).toBeInTheDocument()
      },
      { timeout: 3000 },
    )

    const hit = screen.getByText('pc-lab-01')
    const panel = hit.closest('.absolute')
    expect(panel?.className ?? '').toMatch(/\bz-50\b/)
    expect(screen.getByText(/192\.168\.1\.50/)).toBeInTheDocument()

    view.unmount()
  })
})
