import { RECURRENCE_FREQUENCIES, type RecurrenceFrequency } from "@millhiore/domain"

export const FREQUENCY_LABEL: Record<RecurrenceFrequency, string> = {
  weekly: "Cada semana",
  biweekly: "Cada 2 semanas",
  monthly: "Cada mes",
  yearly: "Cada año",
}

export const FREQUENCIES = RECURRENCE_FREQUENCIES.map((id) => ({ id, label: FREQUENCY_LABEL[id] }))

/** "2026-11-01" → "01/11/2026". */
export function formatDueDay(day: string): string {
  const [y, m, d] = day.split("-")
  return `${d}/${m}/${y}`
}
