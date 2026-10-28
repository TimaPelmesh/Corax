import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WikiRagStreamAnswer } from './WikiRagStreamAnswer'

const answer = 'Один два три четыре пять шесть семь восемь девять десять'

describe('WikiRagStreamAnswer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function renderAnswer(streaming: boolean) {
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia
    return render(<WikiRagStreamAnswer text={answer} streaming={streaming} />)
  }

  it('lands words one after another instead of the whole answer', () => {
    vi.useFakeTimers()
    const view = renderAnswer(true)
    expect(view.container.textContent).toContain('Один')
    expect(view.container.textContent).not.toContain('десять')

    act(() => {
      vi.advanceTimersByTime(80)
    })
    expect(view.container.textContent).toContain('два')
    expect(view.container.textContent).not.toContain('десять')
    expect(view.container.querySelectorAll('.wikirag-word-in').length).toBeGreaterThan(0)
  })

  it('keeps revealing after the stream closes', () => {
    vi.useFakeTimers()
    const view = renderAnswer(true)
    view.rerender(<WikiRagStreamAnswer text={answer} streaming={false} />)
    expect(view.container.textContent).not.toContain('десять')
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(view.container.textContent).toContain('десять')
  })
})
