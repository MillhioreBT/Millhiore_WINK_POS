import type { ProductUnit } from "@millhiore/contracts"

const SYMBOLS: Record<string, string> = { USD: "$", VES: "Bs", EUR: "€", USDT: "USDT" }

const numberFormats = new Map<number, Intl.NumberFormat>()
function numberFormat(decimals: number): Intl.NumberFormat {
  let f = numberFormats.get(decimals)
  if (!f) {
    f = new Intl.NumberFormat("es-VE", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
    numberFormats.set(decimals, f)
  }
  return f
}

export function currencySymbol(code: string): string {
  return SYMBOLS[code] ?? code
}

/** Unidades menores → "Bs 1.018,37" o "$ 1,16". */
export function formatMoney(minor: number, currency: string, decimals = 2): string {
  return `${currencySymbol(currency)} ${numberFormat(decimals).format(minor / 10 ** decimals)}`
}

/** Solo el número, sin símbolo: "1.018,37". */
export function formatAmount(minor: number, decimals = 2): string {
  return numberFormat(decimals).format(minor / 10 ** decimals)
}

/** Milésimas → "2" o "1,25". */
export function formatQty(milli: number): string {
  return new Intl.NumberFormat("es-VE", { maximumFractionDigits: 3 }).format(milli / 1000)
}

const UNIT_SYMBOLS: Record<ProductUnit, string> = { unit: "", kg: "kg", l: "l", m: "m" }

/** Cómo se llama cada forma de vender, para elegirla en el producto. */
export const UNIT_NAMES: Record<ProductUnit, string> = {
  unit: "Unidad",
  kg: "Kilo (kg)",
  l: "Litro (l)",
  m: "Metro (m)",
}

/** Milésimas con su unidad: "0,350 kg" (el kilo, siempre con sus gramos), "1,5 l" o "2". */
export function formatQtyUnit(milli: number, unit: ProductUnit | null | undefined): string {
  if (!unit || unit === "unit") return formatQty(milli)
  const n = unit === "kg" ? numberFormat(3).format(milli / 1000) : formatQty(milli)
  return `${n} ${UNIT_SYMBOLS[unit]}`
}

/** "/kg" detrás de un precio por kilo, litro o metro; nada si es por unidad. */
export function perUnit(unit: ProductUnit | null | undefined): string {
  return !unit || unit === "unit" ? "" : `/${UNIT_SYMBOLS[unit]}`
}

/** "877.90230000" → "877,9023" */
export function formatRate(value: string): string {
  const [int = "0", dec = ""] = value.split(".")
  const trimmed = dec.replace(/0+$/, "")
  const intPart = numberFormat(0).format(Number(int))
  return trimmed ? `${intPart},${trimmed}` : intPart
}

/** "12,5 %" a partir de centésimas de punto (1250). */
export function formatPercent(bp: number): string {
  return `${new Intl.NumberFormat("es-VE", { maximumFractionDigits: 2 }).format(bp / 100)} %`
}

const dateTime = new Intl.DateTimeFormat("es-VE", {
  timeZone: "America/Caracas",
  dateStyle: "short",
  timeStyle: "short",
})
const dateOnly = new Intl.DateTimeFormat("es-VE", {
  timeZone: "America/Caracas",
  weekday: "long",
  day: "numeric",
  month: "long",
})

const timeOnly = new Intl.DateTimeFormat("es-VE", {
  timeZone: "America/Caracas",
  timeStyle: "short",
})

/** «hace un momento», «hace 5 min», «hace 3 h», «hace 2 días». */
export function timeAgo(ms: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - ms) / 60_000))
  if (min < 1) return "hace un momento"
  if (min < 60) return `hace ${min} min`
  if (min < 60 * 24) return `hace ${Math.round(min / 60)} h`
  const days = Math.round(min / (60 * 24))
  return `hace ${days} ${days === 1 ? "día" : "días"}`
}

export function formatDateTime(ms: number): string {
  return dateTime.format(ms)
}

export function formatTime(ms: number): string {
  return timeOnly.format(ms)
}

export function formatDay(ms: number): string {
  return dateOnly.format(ms)
}

/** Una fecha AAAA-MM-DD (un vencimiento) como 12/11/26. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-")
  return `${d}/${m}/${y?.slice(2)}`
}

/**
 * Lee un monto escrito por una persona y lo devuelve en unidades menores, o null si no es válido.
 * Acepta "1.018,37", "1018,37", "1018.37" y "1,5". Con solo puntos, "1.50" es decimal y "1.500"
 * son miles (en Venezuela el punto separa miles).
 */
export function parseAmount(text: string, decimals = 2): number | null {
  const s = text.trim().replace(/\s|\$|bs\.?|usd/gi, "")
  if (!s || !/^[\d.,]+$/.test(s)) return null
  let normalized: string
  const lastComma = s.lastIndexOf(",")
  const lastDot = s.lastIndexOf(".")
  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSep = lastComma > lastDot ? "," : "."
    const thousandSep = decimalSep === "," ? "." : ","
    normalized = s.split(thousandSep).join("").replace(decimalSep, ".")
  } else if (lastComma >= 0) {
    normalized = s
      .split(".")
      .join("")
      .replace(/,(?=[^,]*$)/, ".")
      .split(",")
      .join("")
  } else if (lastDot >= 0) {
    const decimalsAfter = s.length - lastDot - 1
    const dots = s.split(".").length - 1
    normalized = dots === 1 && decimalsAfter <= decimals ? s : s.split(".").join("")
  } else {
    normalized = s
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null
  const [int = "0", frac = ""] = normalized.split(".")
  if (frac.length > decimals) return null
  const minor = Number(int) * 10 ** decimals + Number(frac.padEnd(decimals, "0") || "0")
  return Number.isSafeInteger(minor) ? minor : null
}

/** Milésimas → cantidad editable sin ceros sobrantes ("5", "1,25"). */
export function toInputQty(milli: number): string {
  return toInputAmount(milli, 3).replace(/,?0+$/, "")
}

/** Unidades menores → texto editable ("1018,37"). */
export function toInputAmount(minor: number, decimals = 2): string {
  const sign = minor < 0 ? "-" : ""
  const abs = Math.abs(minor)
  const int = Math.floor(abs / 10 ** decimals)
  const frac = String(abs % 10 ** decimals).padStart(decimals, "0")
  return decimals ? `${sign}${int},${frac}` : `${sign}${int}`
}
