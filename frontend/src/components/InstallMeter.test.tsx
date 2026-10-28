import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstallMeter } from './InstallMeter'

const steps = ['Build', 'Reach', 'Start'] as const

describe('InstallMeter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows the first step while the install is running', () => {
    render(<InstallMeter status="run" steps={steps} doneLabel="Done" failLabel="Failed" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Build')
    expect(screen.getByText('Reach')).toBeInTheDocument()
    expect(screen.getByText('Start')).toBeInTheDocument()
  })

  it('fills the bar when the install succeeds', () => {
    render(<InstallMeter status="ok" steps={steps} doneLabel="Done" failLabel="Failed" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByText('Done')).toBeInTheDocument()
  })

  it('keeps the bar and marks the stop when the install fails', () => {
    const view = render(<InstallMeter status="run" steps={steps} doneLabel="Done" failLabel="Failed" />)
    view.rerender(<InstallMeter status="fail" steps={steps} doneLabel="Done" failLabel="Failed" />)
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.queryByText('!')).not.toBeInTheDocument()
  })

  it('renders nothing before an install starts', () => {
    const { container } = render(<InstallMeter status="idle" steps={steps} doneLabel="Done" failLabel="Failed" />)
    expect(container).toBeEmptyDOMElement()
  })
})
