/** Tramos de la antigüedad de saldos: cuánto lleva vencida una deuda. */
export const AGING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90plus"] as const
export type AgingBucket = (typeof AGING_BUCKETS)[number]

const DAY_MS = 86_400_000

/**
 * En qué tramo cae una deuda: «sin vencer» si no tiene plazo o todavía no llega, y si no, según los
 * días completos que lleva vencida (1–30, 31–60, 61–90 o más de 90).
 */
export function agingBucket(dueAt: number | null, now: number): AgingBucket {
  if (dueAt === null || dueAt >= now) return "current"
  const days = Math.floor((now - dueAt) / DAY_MS)
  if (days < 1) return "current"
  if (days <= 30) return "d1_30"
  if (days <= 60) return "d31_60"
  if (days <= 90) return "d61_90"
  return "d90plus"
}

export type AgingTotals = Record<AgingBucket, number>

export const emptyAging = (): AgingTotals => ({
  current: 0,
  d1_30: 0,
  d31_60: 0,
  d61_90: 0,
  d90plus: 0,
})
