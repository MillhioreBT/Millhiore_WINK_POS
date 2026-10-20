import { describe, expect, test } from "bun:test"
import Big from "big.js"
import fc from "fast-check"
import { applyRate, computeSurcharges, computeTaxes, isValidLineTax, splitTax } from "./tax"

const identity = (n: number) => n

describe("splitTax", () => {
  test("con IVA incluido, base + IVA = precio exacto", () => {
    expect(splitTax(1160, 1600, true)).toEqual({ baseMinor: 1000, taxMinor: 160 })
    expect(splitTax(100, 1600, true)).toEqual({ baseMinor: 86, taxMinor: 14 }) // 86,2 → 86
    expect(splitTax(1080, 800, true)).toEqual({ baseMinor: 1000, taxMinor: 80 })
  })

  test("sin IVA incluido, el IVA se redondea mitad hacia arriba", () => {
    expect(splitTax(1000, 1600, false)).toEqual({ baseMinor: 1000, taxMinor: 160 })
    expect(splitTax(3, 1600, false)).toEqual({ baseMinor: 3, taxMinor: 0 }) // 0,48
    expect(splitTax(25, 1800, false)).toEqual({ baseMinor: 25, taxMinor: 5 }) // 4,5 → 5
  })

  test("exento: todo es base", () => {
    expect(splitTax(999, 0, true)).toEqual({ baseMinor: 999, taxMinor: 0 })
  })

  test("propiedades: incluido conserva el total; ambos son simétricos ante el signo", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        fc.constantFrom(0, 800, 1600, 3100),
        fc.boolean(),
        (anchor, rate, included) => {
          const s = splitTax(anchor, rate, included)
          const neg = splitTax(-anchor, rate, included)
          expect(neg.baseMinor).toBe(-s.baseMinor || 0)
          expect(neg.taxMinor).toBe(-s.taxMinor || 0)
          if (included) expect(s.baseMinor + s.taxMinor).toBe(anchor)
          else expect(s.baseMinor).toBe(anchor)
          // El IVA nunca se aleja más de medio céntimo de base × alícuota.
          expect(Math.abs(s.taxMinor - (s.baseMinor * rate) / 10_000)).toBeLessThanOrEqual(
            included ? 0.5 + rate / 20_000 : 0.5,
          )
        },
      ),
    )
  })
})

describe("isValidLineTax", () => {
  test("gravado exige alícuota positiva y no gravado exige 0 %", () => {
    expect(isValidLineTax({ taxId: "g", kind: "taxed", rateBp: 1600 })).toBe(true)
    expect(isValidLineTax({ taxId: "g", kind: "taxed", rateBp: 0 })).toBe(false)
    expect(isValidLineTax({ taxId: "e", kind: "exempt", rateBp: 0 })).toBe(true)
    expect(isValidLineTax({ taxId: "e", kind: "exonerated", rateBp: 800 })).toBe(false)
    expect(isValidLineTax({ taxId: "x", kind: "taxed", rateBp: 1.5 })).toBe(false)
  })
})

describe("computeTaxes", () => {
  test("líneas sin impuesto se agrupan como no sujetas", () => {
    expect(computeTaxes([{ lineTotalMinor: 500, tax: null }], true, identity)).toEqual([
      {
        taxId: null,
        kind: "not_subject",
        rateBp: 0,
        baseMinor: 500,
        taxMinor: 0,
        baseLegalMinor: 500,
        taxLegalMinor: 0,
      },
    ])
  })

  test("calcula por grupo, no por línea", () => {
    // Tres líneas de 0,01 sin IVA: por línea el IVA sería 0; por grupo, 0,03 × 16 % = 0,0048 → 0
    // y con 10 líneas de 0,01: por línea 0, por grupo 0,10 × 16 % = 0,016 → 0,02.
    const tax = { taxId: "g", kind: "taxed" as const, rateBp: 1600 }
    const lines = Array.from({ length: 10 }, () => ({ lineTotalMinor: 1, tax }))
    expect(computeTaxes(lines, false, identity)[0]?.taxMinor).toBe(2)
  })
})

describe("computeSurcharges", () => {
  const igtf = { surchargeId: "igtf", rateBp: 300 }
  const p = (amount: number, surcharge: typeof igtf | null = null) => ({
    amountMinor: new Big(amount),
    surcharge,
  })

  test("sin pagos con recargo no hay recargo", () => {
    expect(computeSurcharges(1000, [p(1000)], identity)).toEqual([])
  })

  test("los pagos sin recargo cubren primero", () => {
    const [g] = computeSurcharges(1000, [p(600, igtf), p(700)], identity)
    expect(g).toMatchObject({ baseMinor: 300, amountMinor: 9 })
  })

  test("el vuelto (pagos negativos) no altera la base", () => {
    const [g] = computeSurcharges(1500, [p(2045, igtf), p(-500)], identity)
    expect(g?.baseMinor).toBe(1500)
  })

  test("total cubierto en bolívares: sin recargo aunque sobre divisa", () => {
    expect(computeSurcharges(1000, [p(1000), p(50, igtf)], identity)).toEqual([])
  })

  test("documentos con total no positivo no llevan recargo", () => {
    expect(computeSurcharges(0, [p(10, igtf)], identity)).toEqual([])
  })

  test("propiedad: la base nunca supera el total ni lo pagado con recargo", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(
          fc.record({ amount: fc.integer({ min: -100_000, max: 1_000_000 }), igtf: fc.boolean() }),
          { maxLength: 6 },
        ),
        (total, pays) => {
          const groups = computeSurcharges(
            total,
            pays.map((x) => p(x.amount, x.igtf ? igtf : null)),
            identity,
          )
          const base = groups.reduce((acc, g) => acc + g.baseMinor, 0)
          const surchargedPaid = pays
            .filter((x) => x.igtf && x.amount > 0)
            .reduce((acc, x) => acc + x.amount, 0)
          expect(base).toBeLessThanOrEqual(Math.min(total, surchargedPaid))
          for (const g of groups) expect(g.amountMinor).toBe(applyRate(g.baseMinor, 300))
        },
      ),
    )
  })
})
