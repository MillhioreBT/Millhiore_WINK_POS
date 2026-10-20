import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { USD, VES } from "./currency"
import { money } from "./money"
import { convert, exchangeRate, normalizeRate } from "./rate"

const pair = { base: USD, quote: VES }
const rate = exchangeRate("USD", "VES", "36.5")

describe("rate", () => {
  test("normaliza a 8 decimales y rechaza valores inválidos", () => {
    expect(normalizeRate("36.5")).toBe("36.50000000")
    expect(normalizeRate(" 36.12345678 ")).toBe("36.12345678")
    expect(() => normalizeRate("0")).toThrow(RangeError)
    expect(() => normalizeRate("-1")).toThrow(RangeError)
    expect(() => normalizeRate("1.123456789")).toThrow(RangeError)
    expect(() => exchangeRate("USD", "USD", "1")).toThrow(TypeError)
  })

  test("convierte USD → VES y VES → USD", () => {
    expect(convert(money(1000, "USD"), rate, pair)).toEqual(money(36500, "VES")) // 10 USD = 365 Bs
    expect(convert(money(36500, "VES"), rate, pair)).toEqual(money(1000, "USD"))
    expect(convert(money(1, "USD"), rate, pair)).toEqual(money(37, "VES")) // 36,5 → half-up
  })

  test("rechaza monedas ajenas a la tasa", () => {
    expect(() => convert(money(1, "EUR"), rate, pair)).toThrow(TypeError)
    expect(() => convert(money(1, "USD"), rate, { base: VES, quote: USD })).toThrow(TypeError)
  })

  test("respeta monedas con decimales distintos", () => {
    const jpy = { code: "JPY", decimals: 0 }
    const r = exchangeRate("USD", "JPY", "150")
    expect(convert(money(1000, "USD"), r, { base: USD, quote: jpy })).toEqual(money(1500, "JPY"))
    expect(convert(money(1500, "JPY"), r, { base: USD, quote: jpy })).toEqual(money(1000, "USD"))
  })
})

describe("propiedades", () => {
  test("ida y vuelta no se desvía más de lo que permite el redondeo", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 5_000_000_000 }), // tasa 0.01 … 50 con 8 decimales
        (cents, scaled) => {
          const value = (scaled / 1e8).toFixed(8)
          const r = exchangeRate("USD", "VES", value)
          const there = convert(money(cents, "USD"), r, pair)
          const back = convert(there, r, pair)
          // un Bs-céntimo equivale a 1/tasa USD-céntimos
          const tolerance = Math.ceil(1 / Number(value)) + 1
          expect(Math.abs(back.amountMinor - cents)).toBeLessThanOrEqual(tolerance)
        },
      ),
    )
  })

  test("convert es monótona", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a]
          expect(convert(money(lo, "USD"), rate, pair).amountMinor).toBeLessThanOrEqual(
            convert(money(hi, "USD"), rate, pair).amountMinor,
          )
        },
      ),
    )
  })
})
