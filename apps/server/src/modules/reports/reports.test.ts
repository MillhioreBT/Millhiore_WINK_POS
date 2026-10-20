import { beforeEach, describe, expect, test } from "bun:test"
import type { CatalogItem, DaySummary } from "@millhiore/contracts"
import { localDate, uuidv7 } from "@millhiore/domain"
import { type Harness, harness, NOW, saleBody, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const DAY = 86_400_000

async function summary(cookie: string, date?: string): Promise<DaySummary> {
  const res = await h.call(`/api/reports/day${date ? `?date=${date}` : ""}`, { cookie })
  expect(res.status).toBe(200)
  return (await res.json()) as DaySummary
}

describe("resumen del día", () => {
  test("ventas netas de anulaciones, cobrado por método, por hora y lo más vendido", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    const sold = await h.call("/api/documents", {
      cookie: owner,
      body: saleBody(terminalId, methodUsd),
    })
    expect(sold.status).toBe(201)
    const first = (await sold.json()) as { totalLegalMinor: number }
    const voidMe = (await (
      await h.call("/api/documents", {
        cookie: owner,
        body: saleBody(terminalId, methodUsd, {
          lines: [{ variantId: "v1", qtyMilli: 1000, unitPriceMinor: 150 }],
          payments: [
            { id: uuidv7(), paymentMethodId: methodUsd, currency: "USD", amountMinor: 150 },
          ],
        }),
      })
    ).json()) as { id: string }
    const voided = await h.call(`/api/documents/${voidMe.id}/void`, {
      cookie: owner,
      body: { reversalId: uuidv7() },
    })
    expect(voided.status).toBe(201)

    const today = await summary(owner)
    expect(today.date).toBe(localDate(NOW, "America/Caracas"))
    expect(today.sales).toMatchObject({
      count: 2,
      voided: 1,
      totalLegalMinor: first.totalLegalMinor,
      totalReferenceMinor: 300,
    })
    expect(today.previous).toMatchObject({ count: 0, totalLegalMinor: 0, totalReferenceMinor: 0 })
    expect(today.byMethod).toEqual([
      {
        methodId: methodUsd,
        methodName: "Efectivo USD",
        currency: "USD",
        amountMinor: 300,
        commissionMinor: 0,
      },
    ])
    expect(today.byHour).toHaveLength(1)
    expect(today.byHour[0]).toMatchObject({ count: 2, totalLegalMinor: first.totalLegalMinor })
    expect(today.topProducts).toEqual([
      { variantId: "v1", name: "Pan", qtyMilli: 2000, totalLegalMinor: 10950 },
    ])
    expect(today.openShifts).toHaveLength(1)
    // Sin existencia cargada, el pan quedó en −2: está en la lista de reposición.
    expect(today.lowStock).toEqual([
      { productId: "p1", variantId: "v1", name: "Pan", stockMilli: -2000, minStockMilli: null },
    ])
  })

  test("el día es el del negocio: lo vendido mañana no entra hoy y hoy pasa a ser «ayer»", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    const today = localDate(NOW, "America/Caracas")
    await h.call("/api/documents", { cookie: owner, body: saleBody(terminalId, methodUsd) })
    h.clock.now = NOW + DAY
    await h.call("/api/documents", { cookie: owner, body: saleBody(terminalId, methodUsd) })
    await h.call("/api/documents", { cookie: owner, body: saleBody(terminalId, methodUsd) })

    const past = await summary(owner, today)
    expect(past.sales.count).toBe(1)
    const now = await summary(owner)
    expect(now.date).not.toBe(today)
    expect(now.sales.count).toBe(2)
    expect(now.previous).toEqual(past.sales)
    expect(now.to - now.from).toBe(DAY)
  })

  test("el mínimo de existencia avisa antes de agotarse", async () => {
    const { owner } = await setUp(h)
    const res = await h.call("/api/products", {
      cookie: owner,
      body: { name: "Harina PAN", priceMinor: 120, priceCurrency: "USD", minStockMilli: 5000 },
    })
    expect(res.status).toBe(201)
    const item = (await res.json()) as CatalogItem
    expect(item.minStockMilli).toBe(5000)
    const servicio = (await (
      await h.call("/api/products", {
        cookie: owner,
        body: { name: "Recarga", kind: "service", priceMinor: 100, priceCurrency: "USD" },
      })
    ).json()) as CatalogItem

    const names = async () => ((await summary(owner)).lowStock ?? []).map((l) => l.name)
    expect(await names()).toContain("Harina PAN")
    expect(await names()).not.toContain(servicio.name)

    const cleared = await h.call(`/api/products/${item.productId}`, {
      method: "PATCH",
      cookie: owner,
      body: { minStockMilli: null },
    })
    expect(((await cleared.json()) as CatalogItem).minStockMilli).toBeNull()
    const negative = await h.call("/api/products", {
      cookie: owner,
      body: { name: "X", priceMinor: 1, priceCurrency: "USD", minStockMilli: -1 },
    })
    expect(negative.status).toBe(422)
  })

  test("exige report.view; la fecha se valida", async () => {
    const { owner } = await setUp(h)
    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await h.call("/api/reports/day", { cookie: cashier })).status).toBe(403)
    expect((await h.call("/api/reports/day?date=2026-02-30", { cookie: owner })).status).toBe(422)
    expect((await h.call("/api/reports/day?date=hoy", { cookie: owner })).status).toBe(422)
  })
})
