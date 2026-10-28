import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../../i18n/LocaleContext'
import { CloseTicketDialog } from './CloseTicketDialog'

afterEach(() => {
  cleanup()
})

function renderDialog(props: Partial<Parameters<typeof CloseTicketDialog>[0]> = {}) {
  const base = {
    title: 'Ticket #42',
    heading: 'Close request',
    hint: 'Mark as done',
    cancelLabel: 'Cancel',
    confirmLabel: 'Close',
    confirmingLabel: 'Closing…',
    dialogAria: 'Close ticket dialog',
    saving: false,
    onCancel: () => undefined,
    onConfirm: () => undefined,
    ...props,
  }
  return render(
    <LocaleProvider>
      <CloseTicketDialog {...base} />
    </LocaleProvider>,
  )
}

describe('CloseTicketDialog', () => {
  it('renders heading and ticket title', () => {
    renderDialog()
    expect(screen.getByRole('dialog', { name: 'Close request' })).toBeTruthy()
    expect(screen.getByText('Close request')).toBeTruthy()
    expect(screen.getByText('Ticket #42')).toBeTruthy()
  })

  it('calls onCancel from cancel button and backdrop', () => {
    const onCancel = vi.fn()
    renderDialog({ onCancel })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    const layer = document.body.querySelector('.app-modal-layer')
    expect(layer).toBeTruthy()
    fireEvent.click(layer as HTMLElement)
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('calls onConfirm and shows busy label while saving', () => {
    const onConfirm = vi.fn()
    const { rerender } = renderDialog({
      onConfirm,
      confirmLabel: 'Confirm close',
      confirmingLabel: 'Closing…',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm close' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    rerender(
      <LocaleProvider>
        <CloseTicketDialog
          title="Ticket #42"
          heading="Close request"
          hint="Mark as done"
          cancelLabel="Cancel"
          confirmLabel="Confirm close"
          confirmingLabel="Closing…"
          dialogAria="Close ticket dialog"
          saving
          onCancel={() => undefined}
          onConfirm={onConfirm}
        />
      </LocaleProvider>,
    )
    expect(screen.getByRole('button', { name: 'Closing…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('does not cancel from backdrop while saving', () => {
    const onCancel = vi.fn()
    renderDialog({ saving: true, onCancel })
    const layer = document.body.querySelector('.app-modal-layer')
    fireEvent.click(layer as HTMLElement)
    expect(onCancel).not.toHaveBeenCalled()
  })
})
