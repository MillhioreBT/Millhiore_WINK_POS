import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { USD, VES } from "./currency"
import {
  add,
  allocate,
  money,
  multiply,
  negate,
  parseMajor,
  roundToMultiple,
  sub,
  sum,
} from "./money"

const usd = (n: number) => money(n, "USD")

describe("money", () => {
  test("suma y resta en la misma moneda", () => {
    expect(add(usd(150), usd(275))).toEqual(usd(425))
    expect(sub(usd(150), usd(275))).toEqual(usd(-125))
    expect(negate(usd(5))).toEqual(usd(-5))
  })

  test("rechaza mezclar monedas y no enteros", () => {
    expect(() => add(usd(1), money(1, "VES"))).toThrow(TypeError)
    expect(() => money(1.5, "USD")).toThrow(RangeError)
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, "USD")).toThrow(RangeError)
  })

  test("multiply redondea una sola vez, con el modo pedido", () => {
    expect(multiply(usd(1005), "0.16")).toEqual(usd(161)) // 160.8
    expect(multiply(usd(25), "0.5")).toEqual(usd(13)) // 12.5 half-up
    expect(multiply(usd(25), "0.5", "half-even")).toEqual(usd(12))
    expect(multiply(usd(25), "0.5", "down")).toEqual(usd(12))
    expect(multiply(usd(-25), "0.5")).toEqual(usd(-13)) // half-up es simétrico
  })

  test("roundToMultiple para efectivo en Bs", () => {
    expect(roundToMultiple(money(1237, "VES"), 5)).toEqual(money(1235, "VES"))
    expect(roundToMultiple(money(1238, "VES"), 5)).toEqual(money(1240, "VES"))
    expect(() => roundToMultiple(money(1, "VES"), 0)).toThrow(RangeError)
  })

  test("parseMajor evita errores de float", () => {
    expect(parseMajor("0.1", USD)).toEqual(usd(10))
    expect(parseMajor("1.005", VES)).toEqual(money(101, "VES")) // half-up exacto
    expect(parseMajor("19.99", USD)).toEqual(usd(1999))
  })

  test("allocate reparte sin perder céntimos", () => {
    expect(allocate(usd(100), [1, 1, 1])).toEqual([usd(34), usd(33), usd(33)])
    expect(allocate(usd(-100), [1, 1, 1])).toEqual([usd(-34), usd(-33), usd(-33)])
    expect(allocate(usd(5), [0, 1])).toEqual([usd(0), usd(5)])
    expect(() => allocate(usd(5), [0, 0])).toThrow(RangeError)
  })
})

describe("propiedades", () => {
  const amount = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 })

  test("add/sub son inversas y add es conmutativa", () => {
    fc.assert(
      fc.property(amount, amount, (a, b) => {
        expect(sub(add(usd(a), usd(b)), usd(b))).toEqual(usd(a))
        expect(add(usd(a), usd(b))).toEqual(add(usd(b), usd(a)))
      }),
    )
  })

  test("allocate: la suma de partes es exactamente el total", () => {
    fc.assert(
      fc.property(
        amount,
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          fc.pre(weights.some((w) => w > 0))
          const parts = allocate(usd(total), weights)
          expect(sum(parts, "USD")).toEqual(usd(total))
          // ninguna parte se aparta más de 1 céntimo de su cuota exacta
          const weightSum = weights.reduce((a, w) => a + w, 0)
          parts.forEach((p, i) => {
            const exact = (total * (weights[i] ?? 0)) / weightSum
            expect(Math.abs(p.amountMinor - exact)).toBeLessThan(1)
          })
        },
      ),
    )
  })

  test("roundToMultiple devuelve un múltiplo cercano", () => {
    fc.assert(
      fc.property(amount, fc.integer({ min: 1, max: 500 }), (n, step) => {
        const r = roundToMultiple(usd(n), step).amountMinor
        expect(Math.abs(r % step)).toBe(0)
        expect(Math.abs(r - n)).toBeLessThanOrEqual(step / 2)
      }),
    )
  })
})
