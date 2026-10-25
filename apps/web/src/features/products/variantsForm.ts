import type { ProductDetail, VariantInput } from "@millhiore/contracts"
import { comboKey, MAX_OPTIONS, optionsProblem } from "@millhiore/domain"
import { parseAmount, toInputAmount } from "../../lib/format"

/**
 * Borrador de las tallas y colores en el formulario del producto. Cada característica y cada
 * valor llevan una clave propia: así, al cambiar «Azul» por «Azul marino», la combinación sigue
 * siendo la misma variante (con su existencia y su código).
 */
export interface OptionDraft {
  key: string
  name: string
  values: { key: string; text: string }[]
}

export interface ComboDraft {
  /** La variante que ya existe; sin id, se crea. */
  id?: string
  sku: string
  barcode: string
  /** null = el precio del producto. */
  price: string | null
  active: boolean
  stockMilli: number
}

export interface VariantsDraft {
  options: OptionDraft[]
  /** Por la clave de la combinación (las claves de sus valores); las que faltan van por defecto. */
  combos: Record<string, ComboDraft>
  next: number
}

export interface Combo {
  key: string
  values: string[]
}

/** Nombres que se sugieren para la primera, segunda y tercera característica. */
export const SUGGESTED_NAMES = ["Talla", "Color", "Material"]

export const emptyCombo = (): ComboDraft => ({
  sku: "",
  barcode: "",
  price: null,
  active: true,
  stockMilli: 0,
})

export function emptyDraft(): VariantsDraft {
  return { options: [], combos: {}, next: 0 }
}

/** Una característica nueva, con el nombre sugerido según cuántas hay. */
export function addOption(draft: VariantsDraft): VariantsDraft {
  if (draft.options.length >= MAX_OPTIONS) return draft
  return {
    ...draft,
    options: [
      ...draft.options,
      { key: `o${draft.next}`, name: SUGGESTED_NAMES[draft.options.length] ?? "", values: [] },
    ],
    next: draft.next + 1,
  }
}

/** Agrega valores («S, M, L» agrega tres); los repetidos no se agregan. */
export function addValues(draft: VariantsDraft, optionKey: string, text: string): VariantsDraft {
  let next = draft.next
  const options = draft.options.map((o) => {
    if (o.key !== optionKey) return o
    const values = [...o.values]
    for (const part of text.split(",")) {
      const value = part.trim()
      if (!value || values.some((v) => comboKey([v.text]) === comboKey([value]))) continue
      values.push({ key: `v${next++}`, text: value })
    }
    return { ...o, values }
  })
  return { ...draft, options, next }
}

/** Todas las combinaciones, en el orden de la cuadrícula. */
export function combosOf(options: readonly OptionDraft[]): Combo[] {
  if (options.length === 0) return []
  return options.reduce<Combo[]>(
    (acc, o) =>
      acc.flatMap((c) =>
        o.values.map((v) => ({
          key: c.key ? `${c.key}|${v.key}` : v.key,
          values: [...c.values, v.text],
        })),
      ),
    [{ key: "", values: [] }],
  )
}

/** El borrador de un producto que ya tiene tallas y colores. */
export function draftFromDetail(detail: ProductDetail): VariantsDraft {
  let next = 0
  const options: OptionDraft[] = (detail.options ?? []).map((o) => ({
    key: `o${next++}`,
    name: o.name,
    values: o.values.map((text) => ({ key: `v${next++}`, text })),
  }))
  const combos: Record<string, ComboDraft> = {}
  for (const v of detail.variants) {
    if (!v.optionValues || v.optionValues.length !== options.length) continue
    const keys = v.optionValues.map(
      (text, i) => options[i]?.values.find((x) => comboKey([x.text]) === comboKey([text]))?.key,
    )
    if (keys.some((k) => k === undefined)) continue
    const key = keys.join("|")
    // Si hubiera dos con los mismos valores, queda la que se vende.
    if (combos[key]?.active) continue
    combos[key] = {
      id: v.variantId,
      sku: v.sku,
      barcode: v.barcode ?? "",
      price: toInputAmount(v.priceMinor),
      active: v.variantActive,
      stockMilli: v.stockMilli,
    }
  }
  return { options, combos, next }
}

/** Lo que pasa a tener tallas y colores: su única variante va en una de las combinaciones. */
export interface Assigned {
  key: string
  variantId: string
  sku: string
  barcode: string | null
  priceMinor: number
  stockMilli: number
}

/** Cómo se ve una combinación: lo que se escribió o, si no, lo que trae por defecto. */
export function comboState(
  draft: VariantsDraft,
  key: string,
  assigned: Assigned | null,
): ComboDraft {
  const own = draft.combos[key]
  if (own) return own
  if (assigned?.key === key) {
    return {
      id: assigned.variantId,
      sku: assigned.sku,
      barcode: assigned.barcode ?? "",
      price: toInputAmount(assigned.priceMinor),
      active: true,
      stockMilli: assigned.stockMilli,
    }
  }
  return emptyCombo()
}

export type PayloadResult =
  | { ok: true; options: { name: string; values: string[] }[]; variants: VariantInput[] }
  | { ok: false; error: string; comboKey?: string }

/** Lo que se manda al servidor, o el primer problema que hay que corregir. */
export function variantsPayload(
  draft: VariantsDraft,
  basePriceMinor: number | null,
  assigned: Assigned | null,
): PayloadResult {
  const options = draft.options.map((o) => ({
    name: o.name.trim(),
    values: o.values.map((v) => v.text.trim()),
  }))
  const problem = optionsProblem(options)
  if (problem) return { ok: false, error: problem }
  const combos = combosOf(draft.options)
  if (combos.length === 0) return { ok: false, error: "Agrega al menos una talla, color…" }
  const variants: VariantInput[] = []
  for (const c of combos) {
    const s = comboState(draft, c.key, assigned)
    const priceMinor = s.price === null || !s.price.trim() ? basePriceMinor : parseAmount(s.price)
    if (priceMinor === null) {
      return {
        ok: false,
        error: `El precio de ${c.values.join(", ")} no es válido`,
        comboKey: c.key,
      }
    }
    variants.push({
      ...(s.id ? { id: s.id } : {}),
      values: c.values.map((v) => v.trim()),
      ...(s.sku.trim() ? { sku: s.sku.trim() } : {}),
      barcode: s.barcode.trim() || null,
      priceMinor,
      active: s.active,
    })
  }
  if (!variants.some((v) => v.active)) {
    return { ok: false, error: "Deja al menos una combinación a la venta" }
  }
  return { ok: true, options, variants }
}
