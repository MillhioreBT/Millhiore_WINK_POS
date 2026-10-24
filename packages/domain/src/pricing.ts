import Big from "big.js"
import { roundToInteger } from "./money"
import { BASIS_POINTS } from "./tax"

/** A qué se redondea un precio nuevo: céntimo, 5 o 10 céntimos, o la unidad. */
export const PRICE_ROUNDINGS = ["none", "five", "ten", "unit"] as const
export type PriceRounding = (typeof PRICE_ROUNDINGS)[number]

/** El paso del redondeo en unidades menores de una moneda con `decimals` cifras. */
export function roundingStep(rounding: PriceRounding, decimals: number): number {
  const unit = 10 ** decimals
  switch (rounding) {
    case "none":
      return 1
    case "five":
      return Math.max(1, Math.round(unit / 20))
    case "ten":
      return Math.max(1, Math.round(unit / 10))
    case "unit":
      return unit
  }
}

/**
 * Lleva un precio exacto al múltiplo de `step` más cercano (mitad hacia arriba). Un precio que no
 * es cero nunca queda en cero por el redondeo: queda en un paso.
 */
export function roundPrice(exactMinor: Big, step: number): number {
  const rounded = roundToInteger(exactMinor.div(step), "half-up") * step
  return rounded === 0 && exactMinor.gt(0) ? step : rounded
}

/** Sube (o baja, con `valueBp` negativo) un precio en un porcentaje y lo redondea. */
export function percentPrice(priceMinor: number, valueBp: number, step: number): number {
  return roundPrice(new Big(priceMinor).times(BASIS_POINTS + valueBp).div(BASIS_POINTS), step)
}

/**
 * Precio a partir del costo: costo × (1 + ganancia) y, si el precio lleva el IVA, × (1 + IVA).
 * `costMinor` ya viene en la moneda del precio, sin redondear.
 */
export function markupPrice(
  costMinor: Big | number,
  markupBp: number,
  taxRateBp: number,
  step: number,
): number {
  const withMarkup = new Big(costMinor).times(BASIS_POINTS + markupBp).div(BASIS_POINTS)
  return roundPrice(withMarkup.times(BASIS_POINTS + taxRateBp).div(BASIS_POINTS), step)
}

/** Un precio en su moneda (unidades menores). */
export interface Price {
  priceMinor: number
  priceCurrency: string
}

/** Lista de precios tal como la usa la caja. */
export interface PriceListRule {
  /** % sobre el precio base para los productos sin precio propio. */
  adjustBp: number
  /** Precio propio de cada variante, en la moneda en que se fijó. */
  prices: ReadonlyMap<string, Price>
}

/**
 * Precio de un producto con una lista: el propio si lo tiene; si no, el base con el ajuste de la
 * lista (al céntimo). Sin lista, el precio base.
 */
export function priceInList(variantId: string, base: Price, list: PriceListRule | null): Price {
  if (!list) return base
  const own = list.prices.get(variantId)
  if (own) return own
  if (list.adjustBp === 0) return base
  return {
    priceMinor: percentPrice(base.priceMinor, list.adjustBp, 1),
    priceCurrency: base.priceCurrency,
  }
}
