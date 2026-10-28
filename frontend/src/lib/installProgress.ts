/** How far the bar may travel before the install request actually returns. */
export function installProgressCap(elapsedMs: number): number {
  if (elapsedMs < 4000) return 28
  if (elapsedMs < 14000) return 60
  return 92
}

/** Ease toward the cap for the current moment. Never reaches 100 on its own. */
export function nextInstallProgress(current: number, elapsedMs: number): number {
  const cap = installProgressCap(elapsedMs)
  if (current >= cap) return current
  const gap = cap - current
  return Math.min(cap, current + Math.max(0.6, gap * 0.18))
}

/** 0-based step while the request is still running. */
export function installStepIndex(value: number, count: number): number {
  if (count <= 1) return 0
  if (value < 30) return 0
  if (value < 64) return Math.min(1, count - 1)
  return Math.min(2, count - 1)
}
