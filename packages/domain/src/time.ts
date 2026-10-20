// Días y horas en la zona horaria del negocio, no en la del servidor (que puede estar en UTC).

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    formatters.set(timeZone, f)
  }
  return f
}

/** Fecha y hora de pared en `timeZone` para el instante `at` (ms). */
function wallClock(at: number, timeZone: string) {
  const parts: Record<string, number> = {}
  for (const p of formatter(timeZone).formatToParts(new Date(at))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value)
  }
  return {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  }
}

/** Desfase de `timeZone` respecto de UTC en el instante `at`, en ms (Caracas: −4 h). */
export function zoneOffset(at: number, timeZone: string): number {
  const w = wallClock(at, timeZone)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return asUtc - Math.floor(at / 1000) * 1000
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0")

/** Fecha local "AAAA-MM-DD" del instante `at` en `timeZone`. */
export function localDate(at: number, timeZone: string): string {
  const w = wallClock(at, timeZone)
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`
}

/** Hora local (0–23) del instante `at` en `timeZone`. */
export function localHour(at: number, timeZone: string): number {
  return wallClock(at, timeZone).hour
}

function parseDate(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new RangeError(`Fecha inválida: ${date}`)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const check = new Date(Date.UTC(y, mo - 1, d))
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new RangeError(`Fecha inválida: ${date}`)
  }
  return [y, mo, d]
}

export function isValidDate(date: string): boolean {
  try {
    parseDate(date)
    return true
  } catch {
    return false
  }
}

/** Suma (o resta) días a una fecha "AAAA-MM-DD". */
export function addDays(date: string, days: number): string {
  const [y, m, d] = parseDate(date)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** Instante en que empieza la medianoche local de una fecha de calendario (en UTC). */
function startOfDay(y: number, m: number, d: number, timeZone: string): number {
  const midnightUtc = Date.UTC(y, m - 1, d)
  // Dos pasadas: la segunda corrige si el desfase cambia ese día (horario de verano).
  const first = midnightUtc - zoneOffset(midnightUtc, timeZone)
  return midnightUtc - zoneOffset(first, timeZone)
}

/** Rango [from, to) en ms que ocupa el día local `date` en `timeZone`. */
export function dayRange(date: string, timeZone: string): { from: number; to: number } {
  const [y, m, d] = parseDate(date)
  return { from: startOfDay(y, m, d, timeZone), to: startOfDay(y, m, d + 1, timeZone) }
}
