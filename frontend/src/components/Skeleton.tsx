type SkeletonProps = {
  className?: string
}

/** Soft shimmer block for loading placeholders. */
export function Skeleton({ className = '' }: SkeletonProps) {
  return <div className={`app-skeleton ${className}`} aria-hidden />
}

type TableSkeletonProps = {
  rows?: number
  cols?: number
}

export function TableSkeleton({ rows = 8, cols = 5 }: TableSkeletonProps) {
  return (
    <div className="space-y-2 p-3" role="status" aria-busy="true">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton
              key={c}
              className={`h-8 flex-1 rounded-lg ${c === 0 ? 'max-w-[9rem]' : ''} ${c === cols - 1 ? 'max-w-[6rem]' : ''}`}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

type StatRowSkeletonProps = {
  count?: number
}

export function StatRowSkeleton({ count = 4 }: StatRowSkeletonProps) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="status" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-24 rounded-[1rem] sm:h-[5.25rem]" />
      ))}
    </div>
  )
}
