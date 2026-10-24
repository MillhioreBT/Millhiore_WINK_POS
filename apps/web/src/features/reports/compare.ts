import { dayRange, daysBefore } from "../../lib/days"

const DAY_MS = 86_400_000
const pad = (n: number) => String(n).padStart(2, "0")

/** Último día del mes de `day` (`YYYY-MM-DD`). */
function lastDayOfMonth(day: string): string {
  const [y = 0, m = 1] = day.split("-").map(Number)
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`
}

/** Días del rango, contando el primero y el último. */
function span(from: string, to: string): number {
  return Math.round((dayRange(to).from - dayRange(from).from) / DAY_MS) + 1
}

export interface PreviousRange {
  from: string
  to: string
  /** Contra qué se compara: «el mes anterior», «los 7 días anteriores»… */
  label: string
}

/**
 * El período con el que se compara: un mes (entero o hasta hoy) contra el mes anterior hasta el
 * mismo día; lo que va del año contra lo mismo del año pasado; cualquier otro rango contra los
 * mismos días justo antes.
 */
export function previousRange(range: { from: string; to: string }): PreviousRange {
  const [fy = "", fm = "", fd = ""] = range.from.split("-")
  const [ty = "", tm = "", td = ""] = range.to.split("-")
  if (fd === "01" && fy === ty && fm === tm) {
    const prevEnd = daysBefore(range.from, 1)
    const prevMonth = prevEnd.slice(0, 7)
    const to =
      range.to === lastDayOfMonth(range.from)
        ? prevEnd
        : `${prevMonth}-${pad(Math.min(Number(td), Number(prevEnd.slice(8))))}`
    return { from: `${prevMonth}-01`, to, label: "el mes anterior" }
  }
  if (fm === "01" && fd === "01" && fy === ty && tm !== "01") {
    const year = Number(fy) - 1
    const end = `${year}-${tm}-01`
    const to = `${year}-${tm}-${pad(Math.min(Number(td), Number(lastDayOfMonth(end).slice(8))))}`
    return { from: `${year}-01-01`, to, label: "el año anterior" }
  }
  const n = span(range.from, range.to)
  return {
    from: daysBefore(range.from, n),
    to: daysBefore(range.from, 1),
    label: n === 1 ? "el día anterior" : `los ${n} días anteriores`,
  }
}

/** Cuánto cambió, en centésimas de punto (1250 = +12,5 %); null si antes era cero. */
export function changeBp(current: number, previous: number): number | null {
  if (previous === 0) return null
  return Math.round(((current - previous) * 10_000) / Math.abs(previous))
}
