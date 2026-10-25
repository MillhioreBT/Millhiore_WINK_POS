import { describe, expect, test } from "bun:test"
import type { PublicProduct } from "@millhiore/contracts"
import {
  cheapest,
  chooseValue,
  initialValues,
  matches,
  priceText,
  valueExists,
  variantFor,
} from "./view"

const both = { currencies: "both", referenceCurrency: "USD", legalCurrency: "VES" } as const

const camisa: PublicProduct = {
  id: "p1",
  name: "Camisa",
  description: "Algodón peinado",
  categoryId: null,
  unit: "unit",
  imageUrl: null,
  options: [
    { name: "Talla", values: ["S", "M", "L"] },
    { name: "Color", values: ["Azul", "Negro"] },
  ],
  variants: [
    {
      id: "s-azul",
      optionValues: ["S", "Azul"],
      referenceMinor: 1000,
      legalMinor: 36500,
      available: true,
    },
    {
      id: "m-azul",
      optionValues: ["M", "Azul"],
      referenceMinor: 1000,
      legalMinor: 36500,
      available: false,
    },
    {
      id: "m-negro",
      optionValues: ["M", "Negro"],
      referenceMinor: 1200,
      legalMinor: 43800,
      available: true,
    },
    {
      id: "l-negro",
      optionValues: ["L", "Negro"],
      referenceMinor: 900,
      legalMinor: 32850,
      available: false,
    },
  ],
}

describe("catálogo: precios", () => {
  test("en las dos monedas, solo en una o, sin tasa, en la que hay", () => {
    const v = camisa.variants[0]
    if (!v) throw new Error()
    expect(priceText(v, both, "unit")).toEqual({ main: "$ 10,00", other: "Bs 365,00" })
    expect(priceText(v, { ...both, currencies: "legal" }, "unit")).toEqual({
      main: "Bs 365,00",
      other: null,
    })
    expect(priceText({ ...v, legalMinor: null }, both, "kg")).toEqual({
      main: "$ 10,00/kg",
      other: null,
    })
  })

  test("«desde» la forma más barata que hay (lo agotado no cuenta)", () => {
    expect(cheapest(camisa)).toMatchObject({ variant: { id: "s-azul" }, from: true })
    const sinNada = {
      ...camisa,
      variants: camisa.variants.map((v) => ({ ...v, available: false })),
    }
    expect(cheapest(sinNada).variant.id).toBe("l-negro")
  })
})

describe("catálogo: buscar y elegir", () => {
  test("busca sin tildes ni mayúsculas, también en la descripción y las tallas", () => {
    expect(matches(camisa, "ALGODON")).toBe(true)
    expect(matches(camisa, "camisa negro")).toBe(true)
    expect(matches(camisa, "pantalón")).toBe(false)
    expect(matches(camisa, "  ")).toBe(true)
  })

  test("elegir talla y color", () => {
    expect(initialValues(camisa)).toEqual(["S", "Azul"])
    expect(variantFor(camisa, ["M", "Negro"])?.id).toBe("m-negro")
    expect(variantFor(camisa, ["S", "Negro"])).toBeUndefined()
    // Con S elegida, el negro no existe; el azul sí.
    expect(valueExists(camisa, 1, "Negro", ["S", "Azul"])).toBe(false)
    expect(valueExists(camisa, 1, "Azul", ["S", "Azul"])).toBe(true)
    // Elegir L con azul salta a la que existe (L negra).
    expect(chooseValue(camisa, ["S", "Azul"], 0, "L")).toEqual(["L", "Negro"])
    expect(chooseValue(camisa, ["M", "Azul"], 1, "Negro")).toEqual(["M", "Negro"])
  })
})
