import { beforeEach, describe, expect, test } from "bun:test"
import type { Contact, QuoteDetail, QuoteSummary } from "@millhiore/contracts"
import { auditLog, stockBalance } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, NOW, saleBody, setUp } from "../../testing/harness"

let h: Harness
let ctx: Awaited<ReturnType<typeof setUp>>
beforeEach(async () => {
  h = harness()
  ctx = await setUp(h)
})

const quoteBody = (over: Record<string, unknown> = {}) => ({
  id: uuidv7(),
  validDays: 7,
  lines: [
    {
      variantId: "v1",
      qtyMilli: 2000,
      priceMinor: 140,
      priceCurrency: "USD",
      discount: { kind: "percent", bp: 500 },
    },
  ],
  saleDiscount: { kind: "amount", amountMinor: 1000, currency: "VES" },
  totalLegalMinor: 9711,
  totalRefMinor: 266,
  rateValue: "36.50000000",
  ...over,
})

async function createQuote(over: Record<string, unknown> = {}, cookie = ctx.owner) {
  const res = await h.call("/api/quotes", { cookie, body: quoteBody(over) })
  return { res, quote: res.status === 201 ? ((await res.json()) as QuoteDetail) : null }
}

describe("cotizaciones", () => {
  test("se guardan con número, vigencia y precios congelados; no tocan inventario", async () => {
    const client = (await (
      await h.call("/api/contacts", {
        cookie: ctx.owner,
        body: { name: "María Pérez", phone: "0414-1234567" },
      })
    ).json()) as Contact
    const { res, quote } = await createQuote({ contactId: client.id, note: "Precio especial" })
    expect(res.status).toBe(201)
    expect(quote).toMatchObject({
      number: "COT-000001",
      status: "open",
      contactName: "María Pérez",
      contactPhone: "0414-1234567",
      validUntil: NOW + 7 * 86_400_000,
      lineCount: 1,
      note: "Precio especial",
      createdBy: "Dueña",
      saleDiscount: { kind: "amount", amountMinor: 1000, currency: "VES" },
      charges: [],
    })
    expect(quote?.lines).toEqual([
      expect.objectContaining({
        lineNo: 1,
        name: "Pan",
        qtyMilli: 2000,
        priceMinor: 140,
        discount: { kind: "percent", bp: 500 },
        taxId: null,
        active: true,
      }),
    ])
    expect(h.db.select().from(stockBalance).all()).toEqual([])
    expect((await createQuote()).quote?.number).toBe("COT-000002")
    expect(
      h.db
        .select()
        .from(auditLog)
        .all()
        .map((a) => a.action),
    ).toContain("quote.created")
  })

  test("reenviar el mismo id no la duplica", async () => {
    const body = quoteBody()
    const first = await h.call("/api/quotes", { cookie: ctx.owner, body })
    const again = await h.call("/api/quotes", { cookie: ctx.owner, body })
    expect(((await again.json()) as QuoteDetail).id).toBe(((await first.json()) as QuoteDetail).id)
    const list = (await (
      await h.call("/api/quotes", { cookie: ctx.owner })
    ).json()) as QuoteSummary[]
    expect(list).toHaveLength(1)
  })

  test("al venderla queda convertida y ligada a la venta, una sola vez", async () => {
    const { quote } = await createQuote()
    if (!quote) throw new Error("sin cotización")
    const sale = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: saleBody(ctx.terminalId, ctx.methodUsd, { quoteId: quote.id }),
    })
    expect(sale.status).toBe(201)
    const posted = (await sale.json()) as { id: string; number: string }
    const after = (await (
      await h.call(`/api/quotes/${quote.id}`, { cookie: ctx.owner })
    ).json()) as QuoteDetail
    expect(after).toMatchObject({
      status: "converted",
      documentId: posted.id,
      documentNumber: posted.number,
      closedAt: NOW,
    })
    // Reintentar la misma venta no falla; otra venta con la misma cotización sí.
    const retry = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: { ...saleBody(ctx.terminalId, ctx.methodUsd), id: posted.id, quoteId: quote.id },
    })
    expect(retry.status).toBe(200) // ya estaba: no se escribe nada nuevo
    const second = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: saleBody(ctx.terminalId, ctx.methodUsd, { quoteId: quote.id }),
    })
    expect(second.status).toBe(409)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("se anula si está abierta; una anulada no se vende", async () => {
    const { quote } = await createQuote()
    if (!quote) throw new Error("sin cotización")
    const cancel = await h.call(`/api/quotes/${quote.id}/cancel`, { cookie: ctx.owner, body: {} })
    expect(((await cancel.json()) as QuoteDetail).status).toBe("cancelled")
    expect(
      (await h.call(`/api/quotes/${quote.id}/cancel`, { cookie: ctx.owner, body: {} })).status,
    ).toBe(409)
    const sale = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: saleBody(ctx.terminalId, ctx.methodUsd, { quoteId: quote.id }),
    })
    expect(sale.status).toBe(409)
    const purchase = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: saleBody(ctx.terminalId, ctx.methodUsd, { type: "PURCHASE", quoteId: "nope" }),
    })
    expect(purchase.status).toBe(422)
  })

  test("filtra por estado y busca por número o cliente", async () => {
    const client = (await (
      await h.call("/api/contacts", { cookie: ctx.owner, body: { name: "Abasto Don José" } })
    ).json()) as Contact
    await createQuote({ contactId: client.id })
    const { quote } = await createQuote()
    await h.call(`/api/quotes/${quote?.id}/cancel`, { cookie: ctx.owner, body: {} })
    const get = async (q: string) =>
      (await (await h.call(`/api/quotes?${q}`, { cookie: ctx.owner })).json()) as QuoteSummary[]
    expect((await get("status=open")).map((q) => q.number)).toEqual(["COT-000001"])
    expect((await get("status=cancelled")).map((q) => q.number)).toEqual(["COT-000002"])
    expect((await get("search=jos")).map((q) => q.number)).toEqual(["COT-000001"])
    expect((await get("search=000002")).map((q) => q.number)).toEqual(["COT-000002"])
  })

  test("valida productos, clientes, recargos y permisos", async () => {
    expect((await createQuote({ lines: [] })).res.status).toBe(422)
    expect(
      (
        await createQuote({
          lines: [{ variantId: "nope", qtyMilli: 1000, priceMinor: 1, priceCurrency: "USD" }],
        })
      ).res.status,
    ).toBe(422)
    const supplier = (await (
      await h.call("/api/contacts", {
        cookie: ctx.owner,
        body: { name: "Distribuidora", kind: "supplier" },
      })
    ).json()) as Contact
    expect((await createQuote({ contactId: supplier.id })).res.status).toBe(422)
    expect((await createQuote({ charges: [{ chargeId: "nope" }] })).res.status).toBe(422)

    await h.call("/api/users", {
      cookie: ctx.owner,
      body: { name: "Ana", username: "ana", password: "otra-clave-1", roleId: "warehouse" },
    })
    const warehouse = await h.login("ana", "otra-clave-1")
    expect((await createQuote({}, warehouse)).res.status).toBe(403)
    expect((await h.call("/api/quotes", { cookie: warehouse })).status).toBe(403)
  })
})
