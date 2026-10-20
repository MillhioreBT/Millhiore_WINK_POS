/** Código ISO 4217 (o ticker, p. ej. USDT) en mayúsculas. */
export type CurrencyCode = string

export interface Currency {
  code: CurrencyCode
  /** Cifras decimales de la unidad menor (2 → céntimos). */
  decimals: number
}

export const USD: Currency = { code: "USD", decimals: 2 }
export const VES: Currency = { code: "VES", decimals: 2 }
export const EUR: Currency = { code: "EUR", decimals: 2 }
export const USDT: Currency = { code: "USDT", decimals: 2 }
