import Big from "big.js"
import type { CurrencyBook } from "./document"
import { roundToInteger } from "./money"
import type { ExchangeRate } from "./rate"

/** Un ingrediente de la receta: cuánto lleva una unidad del producto y cuánto se pierde. */
export interface RecipeItem {
  ingredientId: string
  /** Por cada unidad del producto, en milésimas del ingrediente. */
  qtyMilli: number
  /** Merma en centésimas de punto (1000 = 10 %). */
  wasteBp: number
}

/**
 * Cuánto se gasta de un ingrediente al hacer `qtyMilli` del producto (en milésimas): lo que lleva
 * la receta más la merma, redondeado a la milésima.
 */
export function ingredientQty(qtyMilli: number, item: Pick<RecipeItem, "qtyMilli" | "wasteBp">) {
  return roundToInteger(
    new Big(qtyMilli)
      .times(item.qtyMilli)
      .div(1000)
      .times(10_000 + item.wasteBp)
      .div(10_000),
    "half-up",
  )
}

/**
 * Lo que cuesta una unidad del producto según su receta, en la moneda del primer ingrediente con
 * costo; null si a alguno le falta el costo o no se puede convertir (`convert` devuelve null).
 */
export function recipeCost(
  items: readonly (Pick<RecipeItem, "qtyMilli" | "wasteBp"> & {
    costMinor: number | null
    costCurrency: string | null
  })[],
  convert: (amount: Big, from: string, to: string) => Big | null,
): { costMinor: number; costCurrency: string } | null {
  const currency = items.find((i) => i.costCurrency)?.costCurrency
  if (!currency || items.length === 0) return null
  let total = new Big(0)
  for (const i of items) {
    if (i.costMinor === null || !i.costCurrency) return null
    // Costo por unidad del ingrediente × lo que se usa (con la merma), en milésimas.
    const used = new Big(i.qtyMilli)
      .times(10_000 + i.wasteBp)
      .div(10_000)
      .div(1000)
    const amount = convert(new Big(i.costMinor).times(used), i.costCurrency, currency)
    if (amount === null) return null
    total = total.plus(amount)
  }
  return { costMinor: roundToInteger(total, "half-up"), costCurrency: currency }
}

/**
 * Convierte montos exactos (unidades menores) entre las dos monedas de una tasa; null si la tasa
 * no las relaciona.
 */
export function rateConverter(
  rate: ExchangeRate | null,
  book: CurrencyBook,
): (amount: Big, from: string, to: string) => Big | null {
  return (amount, from, to) => {
    if (from === to) return amount
    const a = book[from]
    const b = book[to]
    if (!rate || !a || !b) return null
    const scale = new Big(10).pow(b.decimals - a.decimals)
    if (rate.base === from && rate.quote === to) return amount.times(rate.value).times(scale)
    if (rate.quote === from && rate.base === to) return amount.div(rate.value).times(scale)
    return null
  }
}
