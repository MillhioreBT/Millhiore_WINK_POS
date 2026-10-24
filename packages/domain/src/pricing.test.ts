import { describe, expect, test } from "bun:test"
import Big from "big.js"
import { markupPrice, percentPrice, priceInList, roundingStep, roundPrice } from "./pricing"

describe("roundingStep", () => {
  test("con dos decimales: céntimo, 5 y 10 céntimos, unidad", () => {
    expect(roundingStep("none", 2)).toBe(1)
    expect(roundingStep("five", 2)).toBe(5)
    expect(roundingStep("ten", 2)).toBe(10)
    expect(roundingStep("unit", 2)).toBe(100)
  })

  test("sin decimales el paso nunca baja de una unidad menor", () => {
    expect(roundingStep("five", 0)).toBe(1)
    expect(roundingStep("ten", 0)).toBe(1)
    expect(roundingStep("unit", 0)).toBe(1)
  })
})

describe("roundPrice", () => {
  test("al múltiplo más cercano, la mitad hacia arriba", () => {
    expect(roundPrice(new Big(127), 5)).toBe(125)
    expect(roundPrice(new Big("127.5"), 5)).toBe(130)
    expect(roundPrice(new Big(1249), 100)).toBe(1200)
    expect(roundPrice(new Big(1250), 100)).toBe(1300)
  })

  test("un precio positivo no queda en cero", () => {
    expect(roundPrice(new Big(3), 100)).toBe(100)
    expect(roundPrice(new Big(0), 100)).toBe(0)
  })
})

describe("percentPrice", () => {
  test("sube y baja un porcentaje", () => {
    expect(percentPrice(150, 1000, 1)).toBe(165) // 1,50 + 10 %
    expect(percentPrice(116, 1000, 1)).toBe(128) // 127,6 → 128
    expect(percentPrice(116, 1000, 10)).toBe(130)
    expect(percentPrice(200, -2500, 1)).toBe(150) // −25 %
  })

  test("0 % solo redondea", () => {
    expect(percentPrice(116, 0, 5)).toBe(115)
    expect(percentPrice(116, 0, 1)).toBe(116)
  })
})

describe("markupPrice", () => {
  test("costo × ganancia, sin IVA", () => {
    expect(markupPrice(new Big(100), 3000, 0, 1)).toBe(130)
  })

  test("costo × ganancia × IVA cuando el precio lo incluye", () => {
    // 1,00 + 30 % = 1,30; + 16 % = 1,508 → 1,51
    expect(markupPrice(new Big(100), 3000, 1600, 1)).toBe(151)
    expect(markupPrice(new Big(100), 3000, 1600, 10)).toBe(150)
  })

  test("acepta un costo convertido sin redondear", () => {
    // 2 $ a 36,5 Bs/$ = 7300 céntimos de Bs, + 25 %
    expect(markupPrice(new Big("7300"), 2500, 0, 100)).toBe(9100)
    expect(markupPrice(new Big("2.7397260274"), 0, 0, 1)).toBe(3)
  })
})

describe("priceInList", () => {
  const base = { priceMinor: 200, priceCurrency: "USD" }
  const mayor = {
    adjustBp: -1000,
    prices: new Map([["v-own", { priceMinor: 150, priceCurrency: "VES" }]]),
  }

  test("sin lista vale el precio base", () => {
    expect(priceInList("v1", base, null)).toEqual(base)
  })

  test("el precio propio manda, en la moneda en que se fijó", () => {
    expect(priceInList("v-own", base, mayor)).toEqual({ priceMinor: 150, priceCurrency: "VES" })
  })

  test("sin precio propio aplica el ajuste de la lista al céntimo", () => {
    expect(priceInList("v1", base, mayor)).toEqual({ priceMinor: 180, priceCurrency: "USD" })
    expect(priceInList("v1", { priceMinor: 115, priceCurrency: "USD" }, mayor).priceMinor).toBe(
      104, // 103,5 → 104
    )
    expect(priceInList("v1", base, { adjustBp: 0, prices: new Map() })).toEqual(base)
  })
})
