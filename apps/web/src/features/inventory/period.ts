import { daysBefore } from "../../lib/days"

/** Períodos rápidos de Inventario y Traslados. */
export const PRESETS = [
  { id: "today", label: "Hoy" },
  { id: "week", label: "7 días" },
  { id: "month", label: "Este mes" },
] as const

export function presetRange(id: (typeof PRESETS)[number]["id"], today: string) {
  if (id === "today") return { from: today, to: today }
  if (id === "week") return { from: daysBefore(today, 6), to: today }
  return { from: `${today.slice(0, 7)}-01`, to: today }
}
