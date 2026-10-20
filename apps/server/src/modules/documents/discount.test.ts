import { beforeEach, describe, expect, test } from "bun:test"
import type { DocumentDetail } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const withDiscount = (discountMinor: number, pay: number) => ({
  lines: [{ variantId: "v1", qtyMilli: 2000, unitPriceMinor: 150, discountMinor }],
  payments: (methodId: string) => [
    { id: uuidv7(), paymentMethodId: methodId, currency: "USD", amountMinor: pay },
  ],
})

describe("descuentos por la API", () => {
  test("solo quien tiene sale.discount da descuentos; el resto cobra el precio de lista", async () => {
    const s = await setUp(h)
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    const d = withDiscount(50, 250)

    const denied = await h.call("/api/documents", {
      cookie: cashier,
      body: saleBody(s.terminalId, s.methodUsd, {
        lines: d.lines,
        payments: d.payments(s.methodUsd),
      }),
    })
    expect(denied.status).toBe(403)
    expect(((await denied.json()) as { error: { message: string } }).error.message).toContain(
      "sale.discount",
    )

    // Sin descuento, el cajero vende normal.
    const plain = await h.call("/api/documents", {
      cookie: cashier,
      body: saleBody(s.terminalId, s.methodUsd),
    })
    expect(plain.status).toBe(201)

    const granted = await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.terminalId, s.methodUsd, {
        lines: d.lines,
        payments: d.payments(s.methodUsd),
      }),
    })
    expect(granted.status).toBe(201)
    const { id } = (await granted.json()) as { id: string }
    const detail = (await (
      await h.call(`/api/documents/${id}`, { cookie: s.owner })
    ).json()) as DocumentDetail
    expect(detail).toMatchObject({ totalMinor: 250, discountMinor: 50, discountLegalMinor: 1825 })
    expect(detail.lines[0]).toMatchObject({
      unitPriceMinor: 150,
      discountMinor: 50,
      lineTotalMinor: 250,
    })
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("el cierre de turno y el resumen del día suman los descuentos", async () => {
    const s = await setUp(h)
    const d = withDiscount(50, 250)
    await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.terminalId, s.methodUsd, {
        lines: d.lines,
        payments: d.payments(s.methodUsd),
      }),
    })
    const day = (await (await h.call("/api/reports/day", { cookie: s.owner })).json()) as {
      sales: { discountLegalMinor: number }
    }
    expect(day.sales.discountLegalMinor).toBe(1825)
    const report = (await (
      await h.call(`/api/shifts/${s.shiftId}/report`, { cookie: s.owner })
    ).json()) as { sales: { discountLegalMinor: number } }
    expect(report.sales.discountLegalMinor).toBe(1825)
  })
})
