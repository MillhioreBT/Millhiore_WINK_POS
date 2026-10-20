/** Venezuela no tiene horario de verano desde 2016: Caracas es UTC−4 todo el año. */
const CARACAS_OFFSET_MS = 4 * 3_600_000

/** La fecha de hoy en Caracas, como `YYYY-MM-DD`. */
export function todayInCaracas(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(now)
}

/** Desde las 00:00 de ese día en Caracas hasta las 00:00 del siguiente (en ms UTC). */
export function dayRange(day: string): { from: number; to: number } {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number)
  const from = Date.UTC(y, m - 1, d) + CARACAS_OFFSET_MS
  return { from, to: from + 86_400_000 }
}

/** El último instante de ese día en Caracas: «vence el 20» no está vencido todavía el 20. */
export function endOfDay(day: string): number {
  return dayRange(day).to - 1
}

/** El día `n` días antes de `day` (`YYYY-MM-DD`). */
export function daysBefore(day: string, n: number): string {
  const { from } = dayRange(day)
  return todayInCaracas(from - n * 86_400_000 + 12 * 3_600_000)
}
