/** Display plan dates for notes list rows. */
export function formatNotePlanRange(
  planStart?: string | null,
  planEnd?: string | null,
): string | null {
  if (!planStart && !planEnd) return null
  if (planStart && planEnd && planStart === planEnd) return planStart
  if (planStart && planEnd) return `${planStart} → ${planEnd}`
  return planStart || planEnd || null
}
