import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloseTicketDialog } from './CloseTicketDialog'

afterEach(() => {
  cleanup()
})

describe('CloseTicketDialog', () => {
  const base = {
    title: 'Ticket #42',
    heading: 'Close request',
    hint: 'Mark as done',
    cancelLabel: 'Cancel',
    confirmLabel: 'Close',
    confirmingLabel: 'Closing…',
    dialogAria: 'Close ticket dialog',
    saving: false,
  }

  it('renders heading and ticket title', () => {
    render(<CloseTicketDialog {...base} onCancel={() => undefined} onConfirm={() => undefined} />)
    expect(screen.getByRole('dialog', { name: 'Close ticket dialog' })).toBeTruthy()
    expect(screen.getByText('Close request')).toBeTruthy()
    expect(screen.getByText('Ticket #42')).toBeTruthy()
  })

  it('calls onCancel from cancel button and backdrop', () => {
    const onCancel = vi.fn()
    render(<CloseTicketDialog {...base} onCancel={onCancel} onConfirm={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('dialog'))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('calls onConfirm and shows busy label while saving', () => {
    const onConfirm = vi.fn()
    const { rerender } = render(
      <CloseTicketDialog {...base} onCancel={() => undefined} onConfirm={onConfirm} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    rerender(<CloseTicketDialog {...base} saving onCancel={() => undefined} onConfirm={onConfirm} />)
    expect(screen.getByRole('button', { name: 'Closing…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })
})
