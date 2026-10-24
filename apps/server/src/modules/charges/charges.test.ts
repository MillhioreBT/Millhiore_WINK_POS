import { beforeEach, describe, expect, test } from "bun:test"
import type { Bootstrap, DocumentDetail, SaleCharge } from "@millhiore/contracts"
import { documentCharge } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"

let h: Harness
let ctx: Awaited<ReturnType<typeof setUp>>
beforeEach(async () => {
  h = harness()
  ctx = await setUp(h)
})

async function createCharge(body: Record<string, unknown>): Promise<SaleCharge> {
  const res = await h.call("/api/charges", { cookie: ctx.owner, body })
  expect(res.status).toBe(201)
  return (await res.json()) as SaleCharge
}

const detail = async (id: string) =>
  (await (await h.call(`/api/documents/${id}`, { cookie: ctx.owner })).json()) as DocumentDetail

describe("recargos de venta", () => {
  test("se configuran y la caja recibe los activos", async () => {
    const delivery = await createCharge({
      name: "Delivery",
      kind: "fixed",
      amountMinor: 200,
      currency: "USD",
    })
    const service = await createCharge({
      name: "Servicio",
      kind: "percent",
      rateBp: 1000,
      auto: true,
    })
    expect(delivery).toMatchObject({ kind: "fixed", rateBp: 0, taxId: null, position: 1 })
    expect(service).toMatchObject({ kind: "percent", amountMinor: 0, currency: null, auto: true })

    const off = await h.call(`/api/charges/${service.id}`, {
      method: "PATCH",
      cookie: ctx.owner,
      body: { active: false, rateBp: 1200, amountMinor: 999 },
    })
    // Un porcentaje no toma un monto: el tipo no cambia.
    expect(await off.json()).toMatchObject({ active: false, rateBp: 1200, amountMinor: 0 })
    const boot = (await (await h.call("/api/bootstrap", { cookie: ctx.owner })).json()) as Bootstrap
    expect(boot.charges.map((c) => c.name)).toEqual(["Delivery"])
  })

  test("validan nombre, porcentaje, moneda, IVA y permisos", async () => {
    await createCharge({ name: "Delivery", kind: "fixed", amountMinor: 200, currency: "USD" })
    const post = (body: Record<string, unknown>, cookie = ctx.owner) =>
      h.call("/api/charges", { cookie, body })
    expect(
      (await post({ name: "Delivery", kind: "fixed", amountMinor: 1, currency: "USD" })).status,
    ).toBe(409)
    expect((await post({ name: "Servicio", kind: "percent" })).status).toBe(422)
    expect((await post({ name: "Envío", kind: "fixed", amountMinor: 100 })).status).toBe(422)
    expect(
      (await post({ name: "Envío", kind: "fixed", amountMinor: 1, currency: "XXX" })).status,
    ).toBe(422)
    expect(
      (await post({ name: "Servicio", kind: "percent", rateBp: 1000, taxId: "nope" })).status,
    ).toBe(422)

    await h.call("/api/users", {
      cookie: ctx.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await h.call("/api/charges", { cookie: cashier })).status).toBe(200)
    expect((await post({ name: "Bolsa", kind: "percent", rateBp: 100 }, cashier)).status).toBe(403)
  })

  test("una venta con delivery y servicio: se cobran, se ven en el detalle y cuadran", async () => {
    const delivery = await createCharge({
      name: "Delivery",
      kind: "fixed",
      amountMinor: 200,
      currency: "USD",
    })
    const service = await createCharge({
      name: "Servicio",
      kind: "percent",
      rateBp: 1000,
    })
    // Pan: 2 × 1,50 $ con IVA incluido = 3,00 $ (base 2,59). Servicio 10 % = 0,26 $ sin IVA.
    // Delivery: el sugerido (2,00 $). Total = 3,00 + 0,26 + 2,00 = 5,26 $.
    const res = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: saleBody(ctx.terminalId, ctx.methodUsd, {
        charges: [{ chargeId: delivery.id }, { chargeId: service.id }],
        payments: [
          { id: uuidv7(), paymentMethodId: ctx.methodUsd, currency: "USD", amountMinor: 526 },
        ],
      }),
    })
    expect(res.status).toBe(201)
    const sale = (await res.json()) as { id: string; totalMinor: number }
    expect(sale.totalMinor).toBe(526)
    const d = await detail(sale.id)
    expect(d.charges).toEqual([
      expect.objectContaining({ name: "Delivery", kind: "fixed", amountMinor: 200, baseMinor: 0 }),
      expect.objectContaining({
        name: "Servicio",
        kind: "percent",
        baseMinor: 259,
        amountMinor: 26,
      }),
    ])
    expect(d.taxes.map((t) => [t.kind, t.baseMinor, t.taxMinor])).toEqual([
      ["taxed", 259, 41],
      ["not_subject", 226, 0],
    ])
    expect(checkInvariants(h.db)).toEqual([])

    // Anular devuelve también los recargos.
    const voided = await h.call(`/api/documents/${sale.id}/void`, {
      cookie: ctx.owner,
      body: { reversalId: uuidv7(), reason: "prueba" },
    })
    expect(voided.status).toBe(201)
    const reversal = (await voided.json()) as { id: string }
    expect((await detail(reversal.id)).charges.map((c) => c.amountMinor)).toEqual([-200, -26])
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("el monto de un fijo se puede cambiar en la venta y el sugerido se convierte con la tasa", async () => {
    const delivery = await createCharge({
      name: "Delivery",
      kind: "fixed",
      amountMinor: 100,
      currency: "USD",
    })
    // Venta en Bs: el delivery sugerido (1 $) vale 36,50 Bs a la tasa del documento.
    const inBs = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: saleBody(ctx.terminalId, ctx.methodUsd, {
        currency: "VES",
        lines: [{ variantId: "v1", qtyMilli: 1000, unitPriceMinor: 5475 }],
        charges: [{ chargeId: delivery.id }],
        payments: [
          {
            id: uuidv7(),
            paymentMethodId: ctx.methodUsd,
            currency: "USD",
            amountMinor: 250,
            rate: { base: "USD", quote: "VES", value: "36.5" },
          },
        ],
      }),
    })
    expect(inBs.status).toBe(201)
    const bs = await detail(((await inBs.json()) as { id: string }).id)
    expect(bs.charges[0]?.amountMinor).toBe(3650)

    const custom = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: saleBody(ctx.terminalId, ctx.methodUsd, {
        charges: [{ chargeId: delivery.id, amountMinor: 350 }],
        payments: [
          { id: uuidv7(), paymentMethodId: ctx.methodUsd, currency: "USD", amountMinor: 650 },
        ],
      }),
    })
    expect(custom.status).toBe(201)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("con IVA: el recargo suma al grupo de su alícuota; un negocio sin IVA no lo cobra", async () => {
    const delivery = await createCharge({
      name: "Delivery",
      kind: "fixed",
      amountMinor: 116,
      currency: "USD",
      taxId: "iva-general",
    })
    const sale = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: saleBody(ctx.terminalId, ctx.methodUsd, {
        charges: [{ chargeId: delivery.id }],
        payments: [
          { id: uuidv7(), paymentMethodId: ctx.methodUsd, currency: "USD", amountMinor: 416 },
        ],
      }),
    })
    const d = await detail(((await sale.json()) as { id: string }).id)
    // 3,00 + 1,16 = 4,16 $ con IVA incluido: base 3,59 e IVA 0,57 en un solo grupo.
    expect(d.taxes.map((t) => [t.taxId, t.baseMinor, t.taxMinor])).toEqual([
      ["iva-general", 359, 57],
    ])

    await h.call("/api/settings/fiscal", {
      method: "PUT",
      cookie: ctx.owner,
      body: { taxpayer: "none" },
    })
    const plain = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: saleBody(ctx.terminalId, ctx.methodUsd, {
        charges: [{ chargeId: delivery.id }],
        payments: [
          { id: uuidv7(), paymentMethodId: ctx.methodUsd, currency: "USD", amountMinor: 416 },
        ],
      }),
    })
    const p = await detail(((await plain.json()) as { id: string }).id)
    expect(p.charges[0]).toMatchObject({ taxId: null, taxRateBp: 0 })
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("se rechazan fuera de una venta, inactivos o desconocidos", async () => {
    const delivery = await createCharge({
      name: "Delivery",
      kind: "fixed",
      amountMinor: 100,
      currency: "USD",
    })
    const purchase = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: saleBody(ctx.terminalId, ctx.methodUsd, {
        type: "PURCHASE",
        charges: [{ chargeId: delivery.id }],
      }),
    })
    expect(purchase.status).toBe(422)
    const unknown = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: saleBody(ctx.terminalId, ctx.methodUsd, { charges: [{ chargeId: "nope" }] }),
    })
    expect(unknown.status).toBe(422)
    await h.call(`/api/charges/${delivery.id}`, {
      method: "PATCH",
      cookie: ctx.owner,
      body: { active: false },
    })
    const inactive = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: saleBody(ctx.terminalId, ctx.methodUsd, { charges: [{ chargeId: delivery.id }] }),
    })
    expect(inactive.status).toBe(422)
  })

  test("checkInvariants detecta un recargo agregado a mano", async () => {
    const delivery = await createCharge({
      name: "Delivery",
      kind: "fixed",
      amountMinor: 100,
      currency: "USD",
    })
    const res = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: saleBody(ctx.terminalId, ctx.methodUsd),
    })
    const sale = (await res.json()) as { id: string }
    h.db
      .insert(documentCharge)
      .values({
        id: uuidv7(),
        documentId: sale.id,
        position: 1,
        chargeId: delivery.id,
        name: "Delivery",
        kind: "fixed",
        rateBp: 0,
        baseMinor: 0,
        amountMinor: 100,
        amountLegalMinor: 3650,
        taxId: null,
        taxRateBp: 0,
      })
      .run()
    expect(checkInvariants(h.db).map((v) => v.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("el desglose de IVA no coincide")]),
    )
  })
})
