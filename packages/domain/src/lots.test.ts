import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { daysLeft, isExpired, type LotStock, lotOrder, takeLots } from "./lots"

const lot = (
  lotId: string | null,
  expiresOn: string | null,
  qtyMilli: number,
  createdAt = 0,
): LotStock => ({ lotId, expiresOn, qtyMilli, createdAt })

const TODAY = "2026-10-24"

describe("lotes", () => {
  test("vence al terminar su día; los días que le quedan", () => {
    expect(isExpired("2026-10-24", TODAY)).toBe(false)
    expect(isExpired("2026-10-23", TODAY)).toBe(true)
    expect(isExpired(null, TODAY)).toBe(false)
    expect(daysLeft("2026-11-23", TODAY)).toBe(30)
    expect(daysLeft("2026-10-20", TODAY)).toBe(-4)
    expect(daysLeft(null, TODAY)).toBeNull()
  })

  test("sale primero lo sin lote, después el que vence antes; a igual fecha, el más viejo", () => {
    const order = lotOrder(
      [
        lot("tarde", "2027-01-10", 1000),
        lot("sinFecha", null, 1000),
        lot("b", "2026-12-01", 1000, 20),
        lot(null, null, 1000),
        lot("a", "2026-12-01", 1000, 10),
      ],
      TODAY,
      true,
    )
    expect(order.map((l) => l.lotId)).toEqual([null, "a", "b", "tarde", "sinFecha"])
  })

  test("al vender, lo vencido queda para el final; al ajustar, sale primero", () => {
    const lots = [lot("nuevo", "2026-12-01", 1000), lot("vencido", "2026-10-01", 1000)]
    expect(lotOrder(lots, TODAY, true).map((l) => l.lotId)).toEqual(["nuevo", "vencido"])
    expect(lotOrder(lots, TODAY, false).map((l) => l.lotId)).toEqual(["vencido", "nuevo"])
  })

  test("reparte la salida sin dejar lotes en negativo; lo que falta sale sin lote", () => {
    const ordered = [lot("a", "2026-11-01", 2000), lot("b", "2026-12-01", 3000)]
    expect(takeLots(ordered, 4000)).toEqual([
      { lotId: "a", qtyMilli: 2000 },
      { lotId: "b", qtyMilli: 2000 },
    ])
    expect(takeLots(ordered, 6500)).toEqual([
      { lotId: "a", qtyMilli: 2000 },
      { lotId: "b", qtyMilli: 3000 },
      { lotId: null, qtyMilli: 1500 },
    ])
    // Lo sin lote en negativo no aporta, pero absorbe lo que falta.
    expect(takeLots([lot(null, null, -500), lot("a", null, 1000)], 1500)).toEqual([
      { lotId: "a", qtyMilli: 1000 },
      { lotId: null, qtyMilli: 500 },
    ])
  })

  test("propiedad: lo tomado suma la salida y ningún lote da más de lo que tiene", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -3000, max: 5000 }), { maxLength: 6 }),
        fc.integer({ min: 1, max: 20_000 }),
        (qtys, out) => {
          const lots = qtys.map((q, i) => lot(i === 0 ? null : `l${i}`, null, q, i))
          const taken = takeLots(lotOrder(lots, TODAY, true), out)
          expect(taken.reduce((acc, t) => acc + t.qtyMilli, 0)).toBe(out)
          for (const t of taken) {
            expect(t.qtyMilli).toBeGreaterThan(0)
            const had = lots.find((l) => l.lotId === t.lotId)?.qtyMilli ?? 0
            if (t.lotId !== null) expect(t.qtyMilli).toBeLessThanOrEqual(had)
          }
        },
      ),
    )
  })
})
