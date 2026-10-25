import { describe, expect, test } from "bun:test"
import type Big from "big.js"
import { ingredientQty, recipeCost } from "./recipes"

describe("recetas", () => {
  test("lo que se gasta de cada ingrediente, con la merma", () => {
    // 0,150 kg de carne por hamburguesa, con 10 % de merma: 2 hamburguesas gastan 0,330 kg.
    expect(ingredientQty(2000, { qtyMilli: 150, wasteBp: 1000 })).toBe(330)
    expect(ingredientQty(1000, { qtyMilli: 1000, wasteBp: 0 })).toBe(1000)
    // Media porción: 0,0375 → 0,038 (a la milésima, hacia arriba en la mitad).
    expect(ingredientQty(500, { qtyMilli: 75, wasteBp: 0 })).toBe(38)
  })

  test("el costo de una unidad sale de sus ingredientes", () => {
    const same = (amount: Big, from: string, to: string) => (from === to ? amount : null)
    // Pan a 0,40 $ la unidad y carne a 8 $ el kg (0,150 kg con 10 % de merma = 1,32 $).
    const items = [
      { qtyMilli: 1000, wasteBp: 0, costMinor: 40, costCurrency: "USD" },
      { qtyMilli: 150, wasteBp: 1000, costMinor: 800, costCurrency: "USD" },
    ]
    expect(recipeCost(items, same)).toEqual({ costMinor: 172, costCurrency: "USD" })
    // Sin el costo de un ingrediente no se sabe.
    expect(
      recipeCost(
        [...items, { qtyMilli: 30, wasteBp: 0, costMinor: null, costCurrency: null }],
        same,
      ),
    ).toBeNull()
    // Un ingrediente en bolívares se convierte a la moneda del primero.
    const withRate = (amount: Big, from: string, to: string) =>
      from === to ? amount : from === "VES" && to === "USD" ? amount.div(36.5) : null
    expect(
      recipeCost(
        [...items, { qtyMilli: 1000, wasteBp: 0, costMinor: 3650, costCurrency: "VES" }],
        withRate,
      ),
    ).toEqual({ costMinor: 272, costCurrency: "USD" })
    expect(recipeCost([], same)).toBeNull()
  })
})
