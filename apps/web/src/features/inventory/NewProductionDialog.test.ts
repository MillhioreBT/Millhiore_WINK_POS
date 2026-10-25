import { describe, expect, test } from "bun:test"
import { ingredientNeeds } from "./NewProductionDialog"

const recipe = [
  {
    ingredientId: "carne",
    name: "Carne molida (kg)",
    qtyMilli: 1000,
    wasteBp: 1000,
    costMinor: null,
    costCurrency: null,
  },
  {
    ingredientId: "pan",
    name: "Pan",
    qtyMilli: 2000,
    wasteBp: 0,
    costMinor: null,
    costCurrency: null,
  },
]

describe("nueva producción", () => {
  test("lo que se gasta de cada ingrediente, con la merma, y lo que hay", () => {
    const stock: Record<string, number> = { carne: 2000, pan: 10_000 }
    expect(ingredientNeeds(recipe, 2500, (id) => stock[id] ?? 0)).toEqual([
      { ingredientId: "carne", name: "Carne molida (kg)", needMilli: 2750, haveMilli: 2000 },
      { ingredientId: "pan", name: "Pan", needMilli: 5000, haveMilli: 10_000 },
    ])
    // Sin cantidad válida no se gasta nada.
    expect(ingredientNeeds(recipe, 0, () => 0).map((n) => n.needMilli)).toEqual([0, 0])
  })
})
