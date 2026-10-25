import type { PublicCatalog, PublicProduct } from "@millhiore/contracts"
import { formatMoney, perUnit } from "../lib/format"

type Variant = PublicProduct["variants"][number]

/** El precio como lo pide el negocio: en las dos monedas, solo en $ o solo en Bs. */
export function priceText(
  v: Variant,
  catalog: Pick<PublicCatalog, "currencies" | "referenceCurrency" | "legalCurrency">,
  unit: PublicProduct["unit"],
): { main: string; other: string | null } {
  const suffix = perUnit(unit)
  const ref =
    v.referenceMinor === null
      ? null
      : `${formatMoney(v.referenceMinor, catalog.referenceCurrency)}${suffix}`
  const legal =
    v.legalMinor === null ? null : `${formatMoney(v.legalMinor, catalog.legalCurrency)}${suffix}`
  if (catalog.currencies === "legal") return { main: legal ?? ref ?? "", other: null }
  if (catalog.currencies === "reference") return { main: ref ?? legal ?? "", other: null }
  return ref ? { main: ref, other: legal } : { main: legal ?? "", other: null }
}

const amount = (v: Variant) => v.referenceMinor ?? v.legalMinor ?? 0

/** La forma más barata que hay (o la más barata, si todo está agotado) y si las demás cuestan más. */
export function cheapest(p: PublicProduct): { variant: Variant; from: boolean } {
  const pool = p.variants.some((v) => v.available)
    ? p.variants.filter((v) => v.available)
    : p.variants
  const variant = pool.reduce((min, v) => (amount(v) < amount(min) ? v : min))
  return { variant, from: p.variants.some((v) => amount(v) !== amount(variant)) }
}

/** «cafe» encuentra «Café»: sin mayúsculas ni tildes. */
export const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()

export function matches(p: PublicProduct, term: string): boolean {
  const words = fold(term).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = fold(
    `${p.name} ${p.description ?? ""} ${p.options?.flatMap((o) => o.values).join(" ") ?? ""}`,
  )
  return words.every((w) => text.includes(w))
}

/** Nada agotado: todas sus formas se acabaron. */
export const soldOut = (p: PublicProduct) => p.variants.every((v) => !v.available)

/** La forma con esos valores (M, Azul), si existe. */
export function variantFor(p: PublicProduct, values: readonly string[]): Variant | undefined {
  if (!p.options) return p.variants[0]
  return p.variants.find((v) => v.optionValues?.every((x, i) => x === values[i]))
}

/** Con lo ya elegido en las demás características, ¿existe alguna forma con este valor? */
export function valueExists(
  p: PublicProduct,
  index: number,
  value: string,
  selected: readonly string[],
): boolean {
  return p.variants.some(
    (v) =>
      v.optionValues?.[index] === value &&
      v.optionValues.every((x, i) => i === index || selected[i] === undefined || selected[i] === x),
  )
}

/** Lo elegido al abrir un producto: la forma más barata que hay. */
export function initialValues(p: PublicProduct): string[] {
  return cheapest(p).variant.optionValues ?? []
}

/** Elegir un valor: si con los demás no existe, se toma la primera forma que lo tenga. */
export function chooseValue(
  p: PublicProduct,
  selected: readonly string[],
  index: number,
  value: string,
): string[] {
  const next = [...selected]
  next[index] = value
  if (variantFor(p, next)) return next
  const fallback = p.variants.find((v) => v.optionValues?.[index] === value)
  return fallback?.optionValues ? [...fallback.optionValues] : next
}
