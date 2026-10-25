import { describe, expect, test } from "bun:test"
import type { CatalogItem, ScaleSettings } from "@millhiore/contracts"
import { formatQtyUnit, perUnit } from "./format"
import { matchCode } from "./scanner"

const item = (over: Partial<CatalogItem>) =>
  ({
    variantId: "v",
    name: "Pan",
    sku: "PAN",
    barcode: null,
    plu: null,
    unit: "unit",
    ...over,
  }) as CatalogItem

const queso = item({ variantId: "q", name: "Queso blanco", sku: "P00002", unit: "kg", plu: 12 })
const propio = item({ variantId: "c", name: "Combo", sku: "COMBO", barcode: "2000012003509" })
const scale: ScaleSettings = {
  prefixes: ["20", "21"],
  pluDigits: 5,
  value: "weight",
  priceCurrency: "VES",
}

describe("códigos en la caja", () => {
  test("la etiqueta de la balanza trae el producto con su peso", () => {
    expect(matchCode([queso], "2000012003509", scale)).toEqual({ item: queso, weightMilli: 350 })
    expect(matchCode([queso], "2000012003509", { ...scale, value: "price" })).toEqual({
      item: queso,
      priceMinor: 350,
    })
  })

  test("un código propio igual gana; sin la función o sin el PLU no hay producto", () => {
    expect(matchCode([queso, propio], "2000012003509", scale)).toEqual({ item: propio })
    expect(matchCode([queso], "2000012003509", null)).toBeUndefined()
    expect(matchCode([queso], "2000013003508", scale)).toBeUndefined()
    // El SKU sigue funcionando.
    expect(matchCode([queso], "p00002", scale)).toEqual({ item: queso })
  })

  test("cantidades con su unidad", () => {
    expect(formatQtyUnit(350, "kg")).toBe("0,350 kg")
    expect(formatQtyUnit(1500, "l")).toBe("1,5 l")
    expect(formatQtyUnit(2000, "unit")).toBe("2")
    expect(formatQtyUnit(2000, undefined)).toBe("2")
    expect(perUnit("kg")).toBe("/kg")
    expect(perUnit("unit")).toBe("")
  })
})
