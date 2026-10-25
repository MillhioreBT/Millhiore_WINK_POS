import { describe, expect, test } from "bun:test"
import { groupRule, missingChoice, modifiersText } from "./ModifierDialog"

const group = (minSelect: number, maxSelect: number | null) => ({
  id: "g",
  name: "Término",
  minSelect,
  maxSelect,
  modifiers: [
    { id: "a", name: "Tres cuartos", priceMinor: 0, priceCurrency: null },
    { id: "b", name: "Bien cocida", priceMinor: 0, priceCurrency: null },
  ],
})

describe("opciones al vender", () => {
  test("qué pide cada grupo", () => {
    expect(groupRule(group(1, 1))).toBe("Elige 1")
    expect(groupRule(group(1, null))).toBe("Elige al menos 1")
    expect(groupRule(group(0, 2))).toBe("Opcional, hasta 2")
    expect(groupRule(group(0, null))).toBe("Opcional")
  })

  test("falta lo obligatorio", () => {
    expect(missingChoice([group(1, 1)], [])).toBe("Término")
    expect(missingChoice([group(1, 1)], ["b"])).toBeNull()
    expect(missingChoice([group(0, null)], [])).toBeNull()
  })

  test("lo elegido, en una línea", () => {
    expect(modifiersText(group(0, 1).modifiers, "sin sal")).toBe(
      "Tres cuartos · Bien cocida · sin sal",
    )
    expect(modifiersText([], null)).toBeNull()
  })
})
