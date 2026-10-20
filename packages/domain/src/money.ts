import Big from "big.js"
import type { Currency, CurrencyCode } from "./currency"

/** Cómo se redondea cuando el resultado no cae en una unidad menor exacta. */
export type RoundingMode = "half-up" | "half-even" | "down" | "up"

// Big.js: 0 = hacia cero, 1 = mitad hacia arriba (lejos de cero), 2 = mitad al par, 3 = lejos de cero.
const BIG_RM: Record<RoundingMode, 0 | 1 | 2 | 3> = {
  down: 0,
  "half-up": 1,
  "half-even": 2,
  up: 3,
}

/** Monto exacto: entero en la unidad menor de su moneda (céntimos). */
export interface Money {
  readonly amountMinor: number
  readonly currency: CurrencyCode
}

export function money(amountMinor: number, currency: CurrencyCode): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError(`amountMinor debe ser un entero seguro, recibió ${amountMinor}`)
  }
  return { amountMinor, currency }
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Monedas distintas: ${a.currency} y ${b.currency}`)
  }
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b)
  return money(a.amountMinor + b.amountMinor, a.currency)
}

export function sub(a: Money, b: Money): Money {
  sameCurrency(a, b)
  return money(a.amountMinor - b.amountMinor, a.currency)
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency)
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b)
  return a.amountMinor === b.amountMinor ? 0 : a.amountMinor < b.amountMinor ? -1 : 1
}

export function sum(items: readonly Money[], currency: CurrencyCode): Money {
  return items.reduce((acc, m) => add(acc, m), money(0, currency))
}

/** Redondea un decimal arbitrario a entero con el modo indicado. */
export function roundToInteger(value: Big, mode: RoundingMode): number {
  const rounded = value.round(0, BIG_RM[mode])
  const n = rounded.toNumber()
  if (!Number.isSafeInteger(n)) {
    throw new RangeError("El resultado excede el rango de enteros seguros")
  }
  // Big(-0).toNumber() puede dar -0; normalizar.
  return n === 0 ? 0 : n
}

/** Multiplica por un factor decimal (p. ej. un porcentaje) y redondea a la unidad menor. */
export function multiply(a: Money, factor: string | number, mode: RoundingMode = "half-up"): Money {
  return money(roundToInteger(new Big(a.amountMinor).times(factor), mode), a.currency)
}

/**
 * Redondea a un múltiplo de `multipleMinor` unidades menores
 * (p. ej. efectivo en Bs a múltiplos de 5 céntimos).
 */
export function roundToMultiple(
  a: Money,
  multipleMinor: number,
  mode: RoundingMode = "half-up",
): Money {
  if (!Number.isSafeInteger(multipleMinor) || multipleMinor <= 0) {
    throw new RangeError("multipleMinor debe ser un entero positivo")
  }
  const steps = roundToInteger(new Big(a.amountMinor).div(multipleMinor), mode)
  return money(steps * multipleMinor, a.currency)
}

/**
 * Reparte `total` en partes proporcionales a `weights` sin perder ni crear céntimos
 * (método del mayor resto). La suma de las partes es siempre igual a `total`.
 */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) throw new RangeError("weights no puede estar vacío")
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new RangeError("Los pesos deben ser enteros no negativos")
  }
  const weightSum = weights.reduce((acc, w) => acc + w, 0)
  if (weightSum === 0) throw new RangeError("La suma de pesos debe ser mayor que cero")

  const sign = total.amountMinor < 0 ? -1 : 1
  const abs = Math.abs(total.amountMinor)
  const exact = weights.map((w) => new Big(abs).times(w).div(weightSum))
  const floors = exact.map((x) => x.round(0, 0).toNumber())
  let leftover = abs - floors.reduce((acc, x) => acc + x, 0)

  const byRemainder = exact
    .map((x, i) => ({ i, rem: x.minus(floors[i] ?? 0) }))
    .sort((p, q) => q.rem.cmp(p.rem) || p.i - q.i)
  for (const { i } of byRemainder) {
    if (leftover === 0) break
    floors[i] = (floors[i] ?? 0) + 1
    leftover -= 1
  }
  return floors.map((x) => money(sign * x, total.currency))
}

/** Convierte "12.34" a unidades menores según los decimales de la moneda, sin pasar por floats. */
export function parseMajor(text: string, currency: Currency): Money {
  const value = new Big(text.trim())
  return money(
    roundToInteger(value.times(new Big(10).pow(currency.decimals)), "half-up"),
    currency.code,
  )
}
