/** Format sidebar nav count badges (999+ cap). */
export function formatNavBadge(n: number): string {
  if (n > 999) return '999+'
  return String(n)
}
