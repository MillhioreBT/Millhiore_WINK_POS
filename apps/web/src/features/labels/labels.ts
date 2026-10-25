import type { CatalogItem, LabelSettings } from "@millhiore/contracts"
import { type Barcode, barcodeFor } from "../../lib/barcode"
import { formatMoney } from "../../lib/format"
import { convertMinor, type PosContext } from "../pos/compute"

/** Una hoja de etiquetas adhesivas: la página y dónde cae cada etiqueta, en milímetros. */
export interface SheetSpec {
  name: string
  pageWidth: number
  pageHeight: number
  cols: number
  rows: number
  labelWidth: number
  labelHeight: number
  left: number
  top: number
  /** De una etiqueta a la siguiente (ancho o alto más el espacio entre ellas). */
  pitchX: number
  pitchY: number
}

export const SHEETS: Record<Exclude<LabelSettings["paper"], "roll">, SheetSpec> = {
  "letter-3x10": {
    name: "Carta, 3 × 10 (Avery 5160)",
    pageWidth: 215.9,
    pageHeight: 279.4,
    cols: 3,
    rows: 10,
    labelWidth: 66.7,
    labelHeight: 25.4,
    left: 4.8,
    top: 12.7,
    pitchX: 69.85,
    pitchY: 25.4,
  },
  "letter-2x10": {
    name: "Carta, 2 × 10 (Avery 5161)",
    pageWidth: 215.9,
    pageHeight: 279.4,
    cols: 2,
    rows: 10,
    labelWidth: 101.6,
    labelHeight: 25.4,
    left: 4,
    top: 12.7,
    pitchX: 106.4,
    pitchY: 25.4,
  },
  "a4-3x8": {
    name: "A4, 3 × 8 (70 × 37 mm)",
    pageWidth: 210,
    pageHeight: 297,
    cols: 3,
    rows: 8,
    labelWidth: 70,
    labelHeight: 37,
    left: 0,
    top: 0.5,
    pitchX: 70,
    pitchY: 37,
  },
}

/** El tamaño de cada etiqueta: el del rollo o el de la hoja elegida. */
export function labelSize(s: LabelSettings): { width: number; height: number } {
  if (s.paper === "roll") return { width: s.widthMm, height: s.heightMm }
  const sheet = SHEETS[s.paper]
  return { width: sheet.labelWidth, height: sheet.labelHeight }
}

/**
 * El código que lleva la etiqueta: el código de barras del producto o, si no tiene, su SKU (el
 * buscador y la caja encuentran el producto por los dos). null si ninguno se puede dibujar.
 */
export function codeOf(item: CatalogItem): Barcode | null {
  return (item.barcode ? barcodeFor(item.barcode) : null) ?? barcodeFor(item.sku)
}

/** El precio que se imprime según los ajustes; null si no lleva o no se puede convertir. */
export function priceText(
  ctx: PosContext,
  item: Pick<CatalogItem, "priceMinor" | "priceCurrency">,
  mode: LabelSettings["price"],
): string | null {
  const as = (currency: string) => {
    const minor = convertMinor(ctx, item.priceMinor, item.priceCurrency, currency)
    return minor === null ? null : formatMoney(minor, currency)
  }
  switch (mode) {
    case "none":
      return null
    case "own":
      return formatMoney(item.priceMinor, item.priceCurrency)
    case "reference":
      return as(ctx.refCurrency)
    case "legal":
      return as(ctx.docCurrency)
    case "both": {
      const parts = [as(ctx.refCurrency), as(ctx.docCurrency)].filter((p) => p !== null)
      return parts.length ? parts.join(" · ") : null
    }
  }
}

/**
 * Las etiquetas en el orden en que salen: cada producto tantas veces como se pidió y, en hoja,
 * primero los huecos de las que ya se usaron (`skip`).
 */
export function expandLabels(
  entries: readonly { item: CatalogItem; qty: number }[],
  skip = 0,
): (CatalogItem | null)[] {
  const out: (CatalogItem | null)[] = Array.from({ length: Math.max(0, skip) }, () => null)
  for (const e of entries) {
    for (let i = 0; i < e.qty; i++) out.push(e.item)
  }
  return out
}

/** Reparte las etiquetas en páginas de `perPage`. */
export function paginate<T>(labels: readonly T[], perPage: number): T[][] {
  const pages: T[][] = []
  for (let i = 0; i < labels.length; i += perPage) pages.push(labels.slice(i, i + perPage))
  return pages
}
