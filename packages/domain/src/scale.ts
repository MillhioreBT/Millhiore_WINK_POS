import Big from "big.js"
import { roundToInteger } from "./money"

/**
 * Cómo se vende un producto: por unidad, o por kilo, litro o metro (con decimales). La cantidad
 * va siempre en milésimas: 350 de un producto por kilo son 0,350 kg (350 g).
 */
export const PRODUCT_UNITS = ["unit", "kg", "l", "m"] as const
export type ProductUnit = (typeof PRODUCT_UNITS)[number]

/** Dígito de control de EAN y UPC: pesos 3 y 1 alternados desde la derecha. */
export function eanCheckDigit(digits: string): number {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    const d = Number(digits[digits.length - 1 - i])
    sum += i % 2 === 0 ? d * 3 : d
  }
  return (10 - (sum % 10)) % 10
}

/** Cómo arma sus códigos la balanza que imprime etiquetas (EAN-13 de uso interno, 20 a 29). */
export interface WeightBarcodeFormat {
  /** Los dos primeros dígitos que distinguen sus etiquetas. */
  prefixes: readonly string[]
  /** Cuántos dígitos lleva el código del producto en la balanza (PLU): 4, 5 o 6. */
  pluDigits: number
  /** Lo que trae el resto del código: el peso en gramos o el precio en céntimos. */
  value: "weight" | "price"
}

export type WeightBarcode =
  | { plu: number; weightMilli: number; priceMinor?: never }
  | { plu: number; priceMinor: number; weightMilli?: never }

/**
 * Lee la etiqueta de una balanza: prefijo, PLU, peso (o precio) y dígito de control. Con 5
 * dígitos de PLU, «2000012003506» es el producto 12 con 0,350 kg. null si no es de la balanza.
 */
export function parseWeightBarcode(
  code: string,
  format: WeightBarcodeFormat,
): WeightBarcode | null {
  const c = code.trim()
  if (!/^\d{13}$/.test(c)) return null
  if (!format.prefixes.includes(c.slice(0, 2))) return null
  if (eanCheckDigit(c.slice(0, 12)) !== Number(c[12])) return null
  const plu = Number(c.slice(2, 2 + format.pluDigits))
  const value = Number(c.slice(2 + format.pluDigits, 12))
  if (value <= 0) return null
  return format.value === "weight" ? { plu, weightMilli: value } : { plu, priceMinor: value }
}

/**
 * Cuánto lleva un monto a un precio por unidad, en milésimas: 5 $ de queso a 12 $ el kilo son
 * 0,417 kg. null si el precio es cero.
 */
export function qtyForAmount(amountMinor: number, unitPriceMinor: number): number | null {
  if (unitPriceMinor <= 0 || amountMinor <= 0) return null
  return roundToInteger(new Big(amountMinor).times(1000).div(unitPriceMinor), "half-up")
}

export interface ScaleReading {
  /** En gramos (milésimas de kilo). */
  weightMilli: number
  /** La balanza dice que el peso no se mueve; si no dice nada, se toma como estable. */
  stable: boolean
}

const GRAMS: Record<string, number> = { kg: 1000, g: 1, lb: 453.592_37, oz: 28.349_523_125 }

/**
 * Lo que manda una balanza por el puerto serie, en sus formatos más comunes: «ST,GS,+  0.350kg»,
 * «   0,350 kg», «\x0200350\r» (sin punto: gramos), «US,GS,+ 0.352kg» (todavía se mueve). Se toma
 * la última lectura completa; null si no hay un peso (sobrecarga, negativo o nada legible).
 */
export function parseScaleReading(text: string): ScaleReading | null {
  // STX y ETX (inicio y fin de trama) separan lecturas, igual que los saltos de línea.
  const lines = text
    .replaceAll(String.fromCharCode(2), "\n")
    .replaceAll(String.fromCharCode(3), "\n")
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ""
    if (/^(OL|ERR|E\d)/i.test(line)) return null
    const matches = [...line.matchAll(/([-+]?)\s*(\d+(?:[.,]\d+)?)\s*(kg|g|lb|oz)?(?![a-z])/gi)]
    if (matches.length === 0) continue
    // El número que va con su unidad; si ninguno la lleva, el último.
    const m = matches.find((x) => x[3]) ?? matches[matches.length - 1]
    if (!m) continue
    if (m[1] === "-") return null
    const raw = (m[2] ?? "").replace(",", ".")
    const unit = (m[3] ?? (raw.includes(".") ? "kg" : "g")).toLowerCase()
    const weightMilli = roundToInteger(new Big(raw).times(GRAMS[unit] ?? 1), "half-up")
    const stable = !/\b(US|MOTION)\b|\?/i.test(line) && !/\bM\b/.test(line)
    return { weightMilli, stable }
  }
  return null
}
