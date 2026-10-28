import { describe, expect, it } from 'vitest'
import { installProgressCap, installStepIndex, nextInstallProgress } from './installProgress'

describe('install progress', () => {
  it('holds the early steps before the request can have finished', () => {
    expect(installProgressCap(1000)).toBe(28)
    expect(installProgressCap(8000)).toBe(60)
    expect(installProgressCap(20000)).toBe(92)
  })

  it('eases forward and never paints 100 before the result', () => {
    let value = 8
    for (let elapsed = 0; elapsed < 30000; elapsed += 280) {
      value = nextInstallProgress(value, elapsed)
    }
    expect(value).toBeLessThanOrEqual(92)
    expect(value).toBeGreaterThan(80)
  })

  it('maps the bar onto three steps', () => {
    expect(installStepIndex(10, 3)).toBe(0)
    expect(installStepIndex(40, 3)).toBe(1)
    expect(installStepIndex(80, 3)).toBe(2)
    expect(installStepIndex(80, 1)).toBe(0)
  })
})
