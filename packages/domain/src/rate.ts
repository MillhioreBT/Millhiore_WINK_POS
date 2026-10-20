import Big from "big.js"
import type { Currency, CurrencyCode } from "./currency"
import { type Money, money, type RoundingMode, roundToInteger } from "./money"

/** Cifras decimales con las que se guardan las tasas (como las publica el BCV). */
export const RATE_DECIMALS = 8

/**
 * Tasa de cambio: 1 `base` = `value` `quote`.
 * Ejemplo: { base: "USD", quote: "VES", value: "36.50000000" } → 1 USD = 36,5 Bs.
 */
export interface ExchangeRate {
  readonly base: CurrencyCode
  readonly quote: CurrencyCode
  /** Decimal en texto con hasta RATE_DECIMALS cifras; nunca un float. */
  readonly value: string
}

/** Valida y normaliza una tasa a RATE_DECIMALS cifras. Lanza si no es positiva o excede la precisión. */
export function normalizeRate(value: string): string {
  const big = new Big(value.trim())
  if (big.lte(0)) throw new RangeError("La tasa debe ser mayor que cero")
  if (big.round(RATE_DECIMALS, 0).cmp(big) !== 0) {
    throw new RangeError(`La tasa admite como máximo ${RATE_DECIMALS} decimales`)
  }
  return big.toFixed(RATE_DECIMALS)
}

export function exchangeRate(base: CurrencyCode, quote: CurrencyCode, value: string): ExchangeRate {
  if (base === quote) throw new TypeError("base y quote deben ser distintas")
  return { base, quote, value: normalizeRate(value) }
}

/**
 * Convierte un monto entre las dos monedas de la tasa (en cualquier sentido) sin redondear:
 * devuelve el valor exacto en unidades menores de la moneda destino.
 * `currencies` aporta los decimales de cada moneda.
 */
export function convertExact(
  amount: Money,
  rate: ExchangeRate,
  currencies: { base: Currency; quote: Currency },
): { amountMinor: Big; currency: CurrencyCode } {
  const { base, quote } = currencies
  if (base.code !== rate.base || quote.code !== rate.quote) {
    throw new TypeError("Las monedas no coinciden con la tasa")
  }
  const scale = new Big(10).pow(quote.decimals - base.decimals)
  if (amount.currency === rate.base) {
    return {
      amountMinor: new Big(amount.amountMinor).times(rate.value).times(scale),
      currency: rate.quote,
    }
  }
  if (amount.currency === rate.quote) {
    return {
      amountMinor: new Big(amount.amountMinor).div(rate.value).div(scale),
      currency: rate.base,
    }
  }
  throw new TypeError(`${amount.currency} no pertenece a la tasa ${rate.base}/${rate.quote}`)
}

/** Como `convertExact`, con un único redondeo al final. */
export function convert(
  amount: Money,
  rate: ExchangeRate,
  currencies: { base: Currency; quote: Currency },
  mode: RoundingMode = "half-up",
): Money {
  const exact = convertExact(amount, rate, currencies)
  return money(roundToInteger(exact.amountMinor, mode), exact.currency)
}
