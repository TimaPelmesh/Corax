import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AppFold } from './AppFold'

afterEach(() => {
  cleanup()
})

describe('AppFold', () => {
  it('starts collapsed and toggles aria-expanded with the body region', () => {
    render(
      <AppFold title="Advanced">
        <p>Hidden body</p>
      </AppFold>,
    )
    const trigger = screen.getByRole('button', { name: 'Advanced' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('region', { hidden: true })).toHaveAttribute('hidden')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Hidden body')).toBeVisible()
    expect(screen.getByRole('region')).not.toHaveAttribute('hidden')
  })

  it('honors defaultOpen and keeps summaryExtra outside the trigger', () => {
    render(
      <AppFold title="Open fold" defaultOpen summaryExtra={<span>Extra</span>}>
        <span>Content</span>
      </AppFold>,
    )
    expect(screen.getByRole('button', { name: 'Open fold' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Extra')).toBeInTheDocument()
    expect(screen.getByText('Content')).toBeVisible()
  })

  it('supports controlled open via open/onOpenChange', () => {
    let latest = false
    const { rerender } = render(
      <AppFold title="Ctrl" open={false} onOpenChange={(next) => { latest = next }}>
        <span>Body</span>
      </AppFold>,
    )
    const trigger = screen.getByRole('button', { name: 'Ctrl' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(latest).toBe(true)
    rerender(
      <AppFold title="Ctrl" open onOpenChange={(next) => { latest = next }}>
        <span>Body</span>
      </AppFold>,
    )
    expect(screen.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Body')).toBeVisible()
  })
})
