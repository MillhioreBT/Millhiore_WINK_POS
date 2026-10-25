import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import {
  combinations,
  comboKey,
  compareCombos,
  MAX_VARIANTS,
  optionsProblem,
  type ProductOption,
  variantName,
} from "./variants"

const talla = { name: "Talla", values: ["S", "M", "L"] }
const color = { name: "Color", values: ["Azul", "Negro"] }

describe("variantes", () => {
  test("nombre de la combinación y todas las combinaciones en el orden de la cuadrícula", () => {
    expect(variantName("Camisa", ["M", "Azul"])).toBe("Camisa (M, Azul)")
    expect(variantName("Camisa", null)).toBe("Camisa")
    expect(variantName("Camisa", [])).toBe("Camisa")
    expect(combinations([talla, color])).toEqual([
      ["S", "Azul"],
      ["S", "Negro"],
      ["M", "Azul"],
      ["M", "Negro"],
      ["L", "Azul"],
      ["L", "Negro"],
    ])
    expect(combinations([])).toEqual([])
  })

  test("cuántas combinaciones: el producto de los valores, sin repetirse", () => {
    const option = fc.record({
      name: fc.string({ minLength: 1 }),
      values: fc.uniqueArray(fc.string({ minLength: 1, maxLength: 3 }), {
        minLength: 1,
        maxLength: 5,
      }),
    })
    fc.assert(
      fc.property(fc.array(option, { minLength: 1, maxLength: 3 }), (options) => {
        const combos = combinations(options)
        expect(combos).toHaveLength(options.reduce((acc, o) => acc * o.values.length, 1))
        expect(new Set(combos.map((c) => JSON.stringify(c))).size).toBe(combos.length)
      }),
    )
  })

  test("ordena como la cuadrícula; lo que ya no existe va al final", () => {
    const sorted = [
      ["L", "Negro"],
      ["S", "Azul"],
      ["XL", "Azul"],
      ["M", "Negro"],
      ["S", "Negro"],
    ]
      .sort((a, b) => compareCombos([talla, color], a, b))
      .map((c) => c.join(" "))
    expect(sorted).toEqual(["S Azul", "S Negro", "M Negro", "L Negro", "XL Azul"])
  })

  test("compara combinaciones sin importar mayúsculas ni espacios", () => {
    expect(comboKey([" m ", "AZUL"])).toBe(comboKey(["M", "azul"]))
    expect(comboKey(["M", "Azul"])).not.toBe(comboKey(["Azul", "M"]))
  })

  test("valida las características", () => {
    const problem = (options: ProductOption[]) => optionsProblem(options)
    expect(problem([talla, color])).toBeNull()
    expect(problem([talla, { name: "talla", values: ["X"] }])).toContain("repetida")
    expect(problem([{ name: "Talla", values: ["M", "m"] }])).toContain("repetido")
    expect(problem([{ name: "Talla", values: [] }])).toContain("al menos un valor")
    expect(problem([{ name: " ", values: ["M"] }])).toContain("nombre")
    expect(
      problem([talla, color, { name: "Tela", values: ["A"] }, { name: "X", values: ["1"] }]),
    ).toContain("Hasta 3")
    const many = (n: number) => Array.from({ length: n }, (_, i) => String(i))
    expect(
      problem([
        { name: "A", values: many(20) },
        { name: "B", values: many(10) },
      ]),
    ).toBeNull()
    expect(
      problem([
        { name: "A", values: many(21) },
        { name: "B", values: many(10) },
      ]),
    ).toContain(`máximo es ${MAX_VARIANTS}`)
  })
})
