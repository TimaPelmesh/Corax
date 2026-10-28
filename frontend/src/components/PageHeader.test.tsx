import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PageHeader } from './PageHeader'

afterEach(() => {
  cleanup()
})

describe('PageHeader', () => {
  it('exposes the title only to assistive tech', () => {
    render(<PageHeader title="Computers" />)
    const heading = screen.getByRole('heading', { name: 'Computers', level: 1 })
    expect(heading).toHaveClass('sr-only')
  })

  it('renders actions when provided', () => {
    render(<PageHeader title="Warehouse" actions={<button type="button">Add</button>} />)
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })

  it('omits the actions row when there are none', () => {
    const { container } = render(<PageHeader title="Empty" />)
    expect(container.querySelector('.flex.flex-wrap')).toBeNull()
  })
})
