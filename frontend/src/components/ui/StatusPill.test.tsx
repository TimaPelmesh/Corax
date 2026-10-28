import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StatusPill } from './StatusPill'

afterEach(() => {
  cleanup()
})

describe('StatusPill', () => {
  it('exposes a status role and default neutral tone class', () => {
    render(<StatusPill>Idle</StatusPill>)
    const pill = screen.getByRole('status')
    expect(pill).toHaveTextContent('Idle')
    expect(pill.className).toContain('app-status-pill--neutral')
  })

  it.each(['success', 'warning', 'error', 'info'] as const)('applies the %s tone class', (tone) => {
    render(<StatusPill tone={tone}>{tone}</StatusPill>)
    expect(screen.getByRole('status').className).toContain(`app-status-pill--${tone}`)
  })
})
