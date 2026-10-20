import { describe, expect, test } from "bun:test"
import { commissionMinor } from "./commission"

describe("commissionMinor", () => {
  test("aplica los puntos básicos y redondea la mitad hacia arriba", () => {
    expect(commissionMinor(10_000, 250)).toBe(250) // 2,5 % de 100,00
    expect(commissionMinor(1_000, 150)).toBe(15) // 1,5 % de 10,00
    expect(commissionMinor(199, 250)).toBe(5) // 4,975 → 5
    expect(commissionMinor(10, 250)).toBe(0) // 0,25 → 0
    expect(commissionMinor(20, 250)).toBe(1) // 0,5 → 1 (la mitad sube)
  })

  test("sin comisión, sin monto positivo o con datos inválidos no cobra nada", () => {
    expect(commissionMinor(10_000, 0)).toBe(0)
    expect(commissionMinor(0, 250)).toBe(0)
    expect(commissionMinor(-10_000, 250)).toBe(0)
    expect(commissionMinor(10_000, -5)).toBe(0)
    expect(commissionMinor(10_000, 2.5)).toBe(0)
    expect(commissionMinor(Number.NaN, 250)).toBe(0)
  })

  test("con montos enormes no pierde precisión", () => {
    expect(commissionMinor(Number.MAX_SAFE_INTEGER, 10_000)).toBe(Number.MAX_SAFE_INTEGER)
    expect(commissionMinor(9_000_000_000_000_000, 5_000)).toBe(4_500_000_000_000_000)
  })
})
