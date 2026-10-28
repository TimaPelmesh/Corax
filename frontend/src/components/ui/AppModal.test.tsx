import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../../i18n/LocaleContext'
import { AppModal } from './AppModal'

afterEach(() => {
  cleanup()
})

function renderModal(props: Partial<ComponentProps<typeof AppModal>> = {}) {
  const onClose = props.onClose ?? vi.fn()
  const view = render(
    <LocaleProvider>
      <AppModal open title="Server list" onClose={onClose} {...props}>
        <p>Modal body</p>
      </AppModal>
    </LocaleProvider>,
  )
  return { onClose, ...view }
}

describe('AppModal', () => {
  it('exposes dialog semantics when open', () => {
    renderModal()
    const dialog = screen.getByRole('dialog', { name: 'Server list' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByText('Modal body')).toBeInTheDocument()
  })

  it('closes on Escape and restores focus', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <LocaleProvider>
        <button type="button">Opener</button>
        <AppModal open title="Prompt" onClose={onClose}>
          <p>Content</p>
        </AppModal>
      </LocaleProvider>,
    )

    const opener = screen.getByRole('button', { name: 'Opener' })
    opener.focus()
    expect(opener).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when the backdrop is clicked', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { container } = render(
      <LocaleProvider>
        <AppModal open title="Setup" onClose={onClose}>
          <p>Body</p>
        </AppModal>
      </LocaleProvider>,
    )

    const layer = container.ownerDocument.body.querySelector('.app-modal-layer')
    expect(layer).toBeTruthy()
    await user.click(layer as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when closed', () => {
    render(
      <LocaleProvider>
        <AppModal open={false} title="Hidden" onClose={() => undefined}>
          <p>Secret</p>
        </AppModal>
      </LocaleProvider>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
