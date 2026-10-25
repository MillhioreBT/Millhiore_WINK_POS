import { describe, expect, test } from "bun:test"
import type { ProductDetail } from "@millhiore/contracts"
import {
  addOption,
  addValues,
  combosOf,
  draftFromDetail,
  emptyDraft,
  variantsPayload,
} from "./variantsForm"

const variant = (
  id: string,
  optionValues: string[] | null,
  extra: Partial<ProductDetail["variants"][number]> = {},
): ProductDetail["variants"][number] => ({
  productId: "p",
  variantId: id,
  name: "Camisa",
  productName: "Camisa",
  optionValues,
  options: null,
  kind: "good",
  sku: `SKU-${id}`,
  barcode: null,
  priceMinor: 1500,
  priceCurrency: "USD",
  taxId: null,
  categoryId: null,
  tracksStock: true,
  tracksLots: false,
  modifierGroupIds: [],
  hasRecipe: false,
  active: true,
  variantActive: true,
  costMinor: null,
  costCurrency: null,
  stockMilli: 0,
  stockByLocation: {},
  minStockMilli: null,
  expiry: null,
  ...extra,
})

describe("formulario de tallas y colores", () => {
  test("agrega características con nombre sugerido y valores separados por coma", () => {
    let d = addOption(addOption(emptyDraft()))
    expect(d.options.map((o) => o.name)).toEqual(["Talla", "Color"])
    d = addValues(d, d.options[0]?.key ?? "", "S, M, s, , L")
    d = addValues(d, d.options[1]?.key ?? "", "Azul")
    expect(combosOf(d.options).map((c) => c.values.join(" "))).toEqual([
      "S Azul",
      "M Azul",
      "L Azul",
    ])
    expect(addOption(addOption(addOption(d))).options).toHaveLength(3)
  })

  test("al renombrar un valor la combinación conserva su variante", () => {
    const detail: ProductDetail = {
      productId: "p",
      name: "Camisa",
      kind: "good",
      taxId: null,
      categoryId: null,
      tracksStock: true,
      tracksLots: false,
      active: true,
      recipe: [],
      options: [
        { name: "Talla", values: ["S", "M"] },
        { name: "Color", values: ["Azul"] },
      ],
      variants: [
        variant("s", ["S", "Azul"], { barcode: "111" }),
        variant("m", ["m", "azul"], { priceMinor: 1800, stockMilli: 3000 }),
        variant("viejo", ["XL", "Azul"], { variantActive: false }),
      ],
    }
    const d = draftFromDetail(detail)
    const azul = d.options[1]?.values[0]
    if (azul) azul.text = "Azul marino"
    const result = variantsPayload(d, 1500, null)
    expect(result).toEqual({
      ok: true,
      options: [
        { name: "Talla", values: ["S", "M"] },
        { name: "Color", values: ["Azul marino"] },
      ],
      variants: [
        {
          id: "s",
          values: ["S", "Azul marino"],
          sku: "SKU-s",
          barcode: "111",
          priceMinor: 1500,
          active: true,
        },
        {
          id: "m",
          values: ["M", "Azul marino"],
          sku: "SKU-m",
          barcode: null,
          priceMinor: 1800,
          active: true,
        },
      ],
    })
  })

  test("lo que ya existía queda en la combinación elegida; los precios vacíos toman el del producto", () => {
    let d = addOption(emptyDraft())
    d = addValues(d, d.options[0]?.key ?? "", "Pequeño, Grande")
    const [pequeno, grande] = combosOf(d.options)
    const result = variantsPayload(d, 100, {
      key: grande?.key ?? "",
      variantId: "v1",
      sku: "PAN",
      barcode: null,
      priceMinor: 150,
      stockMilli: 0,
    })
    expect(result.ok && result.variants).toEqual([
      { values: ["Pequeño"], barcode: null, priceMinor: 100, active: true },
      { id: "v1", values: ["Grande"], sku: "PAN", barcode: null, priceMinor: 150, active: true },
    ])
    expect(pequeno?.key).not.toBe(grande?.key)
  })

  test("avisa de lo que hay que corregir", () => {
    expect(variantsPayload(emptyDraft(), 100, null)).toMatchObject({ ok: false })
    let d = addOption(emptyDraft())
    expect(variantsPayload(d, 100, null)).toMatchObject({
      error: "Agrega al menos un valor a «Talla»",
    })
    d = addValues(d, d.options[0]?.key ?? "", "S")
    const key = combosOf(d.options)[0]?.key ?? ""
    expect(
      variantsPayload(
        {
          ...d,
          combos: { [key]: { sku: "", barcode: "", price: "abc", active: true, stockMilli: 0 } },
        },
        100,
        null,
      ),
    ).toMatchObject({ ok: false, comboKey: key })
    expect(
      variantsPayload(
        {
          ...d,
          combos: { [key]: { sku: "", barcode: "", price: null, active: false, stockMilli: 0 } },
        },
        100,
        null,
      ),
    ).toMatchObject({ error: "Deja al menos una combinación a la venta" })
  })
})
