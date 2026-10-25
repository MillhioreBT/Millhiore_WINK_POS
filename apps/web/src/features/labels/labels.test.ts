import { describe, expect, test } from "bun:test"
import type { CatalogItem, LabelSettings } from "@millhiore/contracts"
import { exchangeRate } from "@millhiore/domain"
import type { PosContext } from "../pos/compute"
import { codeOf, expandLabels, labelSize, paginate, priceText, SHEETS } from "./labels"

const item = (over: Partial<CatalogItem> = {}) =>
  ({
    variantId: "v",
    sku: "P00002-1",
    barcode: null,
    priceMinor: 1500,
    priceCurrency: "USD",
    ...over,
  }) as CatalogItem

const ctx = {
  refCurrency: "USD",
  docCurrency: "VES",
  rate: exchangeRate("USD", "VES", "36.5"),
  book: {
    USD: { code: "USD", decimals: 2 },
    VES: { code: "VES", decimals: 2 },
  },
} as unknown as PosContext

const settings: LabelSettings = {
  paper: "roll",
  widthMm: 50,
  heightMm: 25,
  price: "reference",
  showBusiness: false,
  showSku: false,
}

describe("etiquetas", () => {
  test("el tamaño: el del rollo o el de la hoja", () => {
    expect(labelSize(settings)).toEqual({ width: 50, height: 25 })
    expect(labelSize({ ...settings, paper: "letter-3x10" })).toEqual({ width: 66.7, height: 25.4 })
    // Las hojas caben en su página.
    for (const s of Object.values(SHEETS)) {
      expect(s.left + (s.cols - 1) * s.pitchX + s.labelWidth).toBeLessThanOrEqual(s.pageWidth)
      expect(s.top + (s.rows - 1) * s.pitchY + s.labelHeight).toBeLessThanOrEqual(s.pageHeight)
    }
  })

  test("el código: el de barras si se puede dibujar; si no, el SKU", () => {
    expect(codeOf(item({ barcode: "7591234567894" }))).toMatchObject({
      format: "EAN13",
      text: "7591234567894",
    })
    expect(codeOf(item())).toMatchObject({ format: "CODE128", text: "P00002-1" })
    expect(codeOf(item({ barcode: "código ñ" }))?.text).toBe("P00002-1")
    expect(codeOf(item({ sku: "ÑAME" }))).toBeNull()
  })

  test("el precio según los ajustes", () => {
    const pan = item({ priceMinor: 1500, priceCurrency: "USD" })
    expect(priceText(ctx, pan, "reference")).toBe("$ 15,00")
    expect(priceText(ctx, pan, "legal")).toBe("Bs 547,50")
    expect(priceText(ctx, pan, "both")).toBe("$ 15,00 · Bs 547,50")
    expect(priceText(ctx, item({ priceMinor: 3650, priceCurrency: "VES" }), "own")).toBe("Bs 36,50")
    expect(priceText(ctx, pan, "none")).toBeNull()
    expect(priceText({ ...ctx, rate: null }, pan, "legal")).toBeNull()
    // Lo que se vende por kilo lleva el precio por kilo.
    const queso = item({ priceMinor: 1200, priceCurrency: "USD", unit: "kg" })
    expect(priceText(ctx, queso, "both")).toBe("$ 12,00/kg · Bs 438,00/kg")
  })

  test("cada producto tantas veces como se pidió, después de los huecos de la hoja", () => {
    const a = item({ variantId: "a" })
    const b = item({ variantId: "b" })
    const labels = expandLabels(
      [
        { item: a, qty: 2 },
        { item: b, qty: 1 },
      ],
      2,
    )
    expect(labels.map((l) => l?.variantId ?? null)).toEqual([null, null, "a", "a", "b"])
    expect(paginate(labels, 2).map((p) => p.length)).toEqual([2, 2, 1])
  })
})
