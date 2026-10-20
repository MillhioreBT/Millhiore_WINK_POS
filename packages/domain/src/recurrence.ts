import { addDays, isValidDate } from "./time"

/** Cada cuánto se repite un gasto. */
export const RECURRENCE_FREQUENCIES = ["weekly", "biweekly", "monthly", "yearly"] as const
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number]

/** El día del mes (1–31) de una fecha "AAAA-MM-DD": la referencia de los gastos mensuales y anuales. */
export function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10))
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * La fecha del siguiente vencimiento tras `current`. Cada semana o cada dos semanas suma 7 o 14
 * días; cada mes o cada año conserva el día `anchorDay` del primer vencimiento, y si ese mes no lo
 * tiene (el 31 en febrero) cae en el último día, sin arrastrar el corrimiento a los meses siguientes.
 */
export function nextDueDay(
  frequency: RecurrenceFrequency,
  current: string,
  anchorDay: number,
): string {
  if (!isValidDate(current)) throw new RangeError(`Fecha inválida: ${current}`)
  if (frequency === "weekly") return addDays(current, 7)
  if (frequency === "biweekly") return addDays(current, 14)
  const year = Number(current.slice(0, 4))
  const month = Number(current.slice(5, 7))
  const [y, m] = frequency === "monthly" ? shiftMonth(year, month, 1) : [year + 1, month]
  const day = Math.min(anchorDay, daysInMonth(y, m))
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

function shiftMonth(year: number, month: number, by: number): [number, number] {
  const index = year * 12 + (month - 1) + by
  return [Math.floor(index / 12), (index % 12) + 1]
}
