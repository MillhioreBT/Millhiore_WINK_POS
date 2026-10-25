import { describe, expect, test } from "bun:test"
import { type RecipeRow, recipePayload } from "./RecipeEditor"

const row = (over: Partial<RecipeRow>): RecipeRow => ({
  key: "k",
  ingredientId: "pan",
  qty: "1",
  waste: "",
  ...over,
})

describe("receta en la ficha del producto", () => {
  test("lee cantidades y merma escritas como en Venezuela", () => {
    expect(
      recipePayload([row({}), row({ ingredientId: "carne", qty: "0,150", waste: "10" })]),
    ).toEqual({
      ok: true,
      items: [
        { ingredientId: "pan", qtyMilli: 1000, wasteBp: 0 },
        { ingredientId: "carne", qtyMilli: 150, wasteBp: 1000 },
      ],
    })
    // Una fila vacía se ignora.
    expect(recipePayload([row({ ingredientId: "", qty: "" })])).toEqual({ ok: true, items: [] })
  })

  test("dice qué fila está mal", () => {
    expect(recipePayload([row({ ingredientId: "" })])).toMatchObject({ ok: false })
    expect(recipePayload([row({ qty: "0" })])).toEqual({
      ok: false,
      error: "Escribe cuánto lleva en la fila 1",
    })
    expect(recipePayload([row({ waste: "150" })])).toMatchObject({ ok: false })
    expect(recipePayload([row({}), row({ qty: "2" })])).toEqual({
      ok: false,
      error: "Un ingrediente está repetido",
    })
  })
})
