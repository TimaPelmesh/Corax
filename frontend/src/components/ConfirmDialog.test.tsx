import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../i18n/LocaleContext'
import { ConfirmDialog, useConfirmDialog } from './ConfirmDialog'

afterEach(() => {
  cleanup()
})

function renderDialog(
  props: Partial<ComponentProps<typeof ConfirmDialog>> & {
    open?: boolean
  } = {},
) {
  const onClose = props.onClose ?? vi.fn()
  const onConfirm = props.onConfirm ?? vi.fn()
  return {
    onClose,
    onConfirm,
    ...render(
      <LocaleProvider>
        <ConfirmDialog
          open={props.open ?? true}
          title={props.title ?? 'Delete item'}
          body={props.body ?? 'This cannot be undone.'}
          confirmLabel={props.confirmLabel ?? 'Delete'}
          tone={props.tone}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      </LocaleProvider>,
    ),
  }
}

describe('ConfirmDialog', () => {
  it('renders dialog chrome with labelled title and body description', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby')
    expect(dialog).toHaveAttribute('aria-describedby')
    expect(screen.getByRole('heading', { name: 'Delete item' })).toBeInTheDocument()
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument()
  })

  it('calls onConfirm when the confirm button is clicked', () => {
    const { onConfirm, onClose } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose from cancel and backdrop', () => {
    const { onClose, onConfirm } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Отмена|Cancel/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()

    onClose.mockClear()
    fireEvent.click(screen.getByRole('dialog').parentElement!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', () => {
    const { onClose } = renderDialog()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('applies the danger tone class on the confirm button', () => {
    renderDialog({ tone: 'danger', confirmLabel: 'Remove' })
    expect(screen.getByRole('button', { name: 'Remove' }).className).toContain('app-btn-danger')
  })

  it('defaults to the primary tone class', () => {
    renderDialog({ confirmLabel: 'Save' })
    expect(screen.getByRole('button', { name: 'Save' }).className).toContain('app-btn-primary')
  })

  it('moves initial focus to the confirm button and restores on close', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'Open'
    document.body.appendChild(opener)
    opener.focus()

    const view = render(
      <LocaleProvider>
        <ConfirmDialog
          open
          title="Confirm"
          body="Body"
          confirmLabel="OK"
          onClose={vi.fn()}
          onConfirm={vi.fn()}
        />
      </LocaleProvider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'OK' })).toHaveFocus()
    })

    view.unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })

  it('returns null when closed', () => {
    renderDialog({ open: false })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('useConfirmDialog', () => {
  function Harness() {
    const { ask, dialog } = useConfirmDialog()
    return (
      <>
        <button type="button" onClick={() => void ask({ title: 'Sure?', body: 'Proceed', confirmLabel: 'Yes', tone: 'danger' })}>
          Ask
        </button>
        {dialog}
      </>
    )
  }

  it('resolves true on confirm and false on cancel', async () => {
    render(
      <LocaleProvider>
        <Harness />
      </LocaleProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Yes' }).className).toContain('app-btn-danger')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Отмена|Cancel/i }))
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Yes' }))
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })
})
