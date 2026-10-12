import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

const CHUNK_RELOAD = 'corax-chunk-reload'

function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /dynamically imported module|importing a module script failed|Failed to fetch|error loading/i.test(
    message,
  )
}

/** Route chunks are separate files. After a deploy the open tab can still point at the previous hash. */
export function lazyPage<T extends ComponentType<object>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch((error: unknown) => {
      if (isChunkLoadError(error) && sessionStorage.getItem(CHUNK_RELOAD) !== '1') {
        sessionStorage.setItem(CHUNK_RELOAD, '1')
        window.location.reload()
        return new Promise<{ default: T }>(() => {})
      }
      throw error
    }),
  )
}
