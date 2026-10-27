import { cloneScene } from './inventory'
import type { NetworkMapScene } from './types'

export function createUndoStack(limit = 40) {
  const past: NetworkMapScene[] = []
  const future: NetworkMapScene[] = []
  return {
    push(scene: NetworkMapScene) {
      past.push(cloneScene(scene))
      if (past.length > limit) past.shift()
      future.length = 0
    },
    undo(current: NetworkMapScene): NetworkMapScene | null {
      const prev = past.pop()
      if (!prev) return null
      future.push(cloneScene(current))
      return prev
    },
    redo(current: NetworkMapScene): NetworkMapScene | null {
      const next = future.pop()
      if (!next) return null
      past.push(cloneScene(current))
      return next
    },
    get canUndo() {
      return past.length > 0
    },
    get canRedo() {
      return future.length > 0
    },
    clear() {
      past.length = 0
      future.length = 0
    },
  }
}
