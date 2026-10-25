import { beforeEach, describe, expect, test } from "bun:test"
import type { PlacedOrder, WebOrder } from "@millhiore/contracts"
import { auditLog, telegramMessage, webhookDelivery, webOrder } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { drainOutbox } from "../../events/outbox"
import { type Harness, harness, NOW, saleBody, setUp } from "../../testing/harness"
import { writeSetting } from "../settings/service"

let h: Harness
beforeEach(() => {
  h = harness()
})

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

/** Catálogo encendido y sin mirar la existencia (el pan de la prueba no tiene). */
async function withOrders() {
  const s = await setUp(h)
  await h.call("/api/settings/features", {
    method: "PUT",
    cookie: s.owner,
    body: { catalog: true },
  })
  await h.call("/api/storefront", { method: "PUT", cookie: s.owner, body: { soldOut: "ignore" } })
  return s
}

const order = (over: Record<string, unknown> = {}) => ({
  id: uuidv7(),
  name: "Ana",
  phone: "0414-1112233",
  delivery: "pickup",
  lines: [{ variantId: "v1", qtyMilli: 2000 }],
  ...over,
})

const place = (body: Record<string, unknown>, ip = "192.168.1.20") =>
  h.call("/api/public/orders", { body, ip })

async function newUser(owner: string, username: string, roleId: string) {
  await h.call("/api/users", {
    cookie: owner,
    body: { name: username, username, password: "otra-clave-1", roleId },
  })
  return h.login(username, "otra-clave-1")
}

describe("pedidos desde el catálogo", () => {
  test("sin catálogo, o sin pedidos, no se puede pedir", async () => {
    const s = await setUp(h)
    expect(await errorCode(await place(order()))).toBe("CATALOG_OFF")
    await h.call("/api/settings/features", {
      method: "PUT",
      cookie: s.owner,
      body: { catalog: true },
    })
    await h.call("/api/storefront", { method: "PUT", cookie: s.owner, body: { orders: false } })
    const off = await place(order())
    expect(off.status).toBe(404)
    expect(await errorCode(off)).toBe("ORDERS_OFF")
    const catalog = (await (await h.call("/api/public/catalog")).json()) as { orders: unknown }
    expect(catalog.orders).toBeNull()
  })

  test("los precios los pone el servidor; el mismo id no se anota dos veces", async () => {
    await withOrders()
    const catalog = (await (await h.call("/api/public/catalog")).json()) as {
      orders: { delivery: boolean; payments: string[] }
    }
    expect(catalog.orders.delivery).toBe(true)
    expect(catalog.orders.payments).toContain("Efectivo USD")

    const body = order({
      payment: "Pago móvil",
      note: "Tocar el timbre",
      lines: [{ variantId: "v1", qtyMilli: 2000, note: "bien tostado", unitPriceMinor: 1 }],
    })
    const res = await place(body)
    expect(res.status).toBe(201)
    const placed = (await res.json()) as PlacedOrder
    expect(placed).toMatchObject({
      number: "P-000001",
      totalReferenceMinor: 300,
      totalLegalMinor: 10950,
      referenceCurrency: "USD",
      legalCurrency: "VES",
    })
    expect(placed.lines).toEqual([
      {
        variantId: "v1",
        name: "Pan",
        unit: "unit",
        qtyMilli: 2000,
        referenceMinor: 150,
        legalMinor: 5475,
        note: "bien tostado",
      },
    ])
    // La página reintenta: el mismo pedido.
    const again = (await (await place(body)).json()) as PlacedOrder
    expect(again.number).toBe("P-000001")
    expect(h.db.select().from(webOrder).all()).toHaveLength(1)
    const second = (await (await place(order())).json()) as PlacedOrder
    expect(second.number).toBe("P-000002")
  })

  test("valida el teléfono, la dirección del delivery, las cantidades y lo que hay", async () => {
    const s = await withOrders()
    const code = async (over: Record<string, unknown>) => errorCode(await place(order(over)))
    expect(await code({ phone: "12345678" })).toBe("INVALID_PHONE")
    expect(await code({ delivery: "delivery" })).toBe("ADDRESS_REQUIRED")
    expect(await code({ lines: [{ variantId: "v1", qtyMilli: 1500 }] })).toBe("INVALID_QUANTITY")
    expect(await code({ lines: [{ variantId: "no-existe", qtyMilli: 1000 }] })).toBe(
      "UNKNOWN_PRODUCT",
    )
    expect(await code({ lines: [] })).toBe("VALIDATION")
    // Escondido del catálogo, no se pide.
    await h.call("/api/products/p1", {
      method: "PATCH",
      cookie: s.owner,
      body: { inCatalog: false },
    })
    expect(await code({})).toBe("UNKNOWN_PRODUCT")
    await h.call("/api/products/p1", {
      method: "PATCH",
      cookie: s.owner,
      body: { inCatalog: true },
    })
    // Sin delivery, solo retiro.
    await h.call("/api/storefront", { method: "PUT", cookie: s.owner, body: { delivery: false } })
    expect(await code({ delivery: "delivery", address: "Calle 5" })).toBe("NO_DELIVERY")
    // Lo agotado no se pide.
    await h.call("/api/storefront", { method: "PUT", cookie: s.owner, body: { soldOut: "mark" } })
    const sold = await place(order())
    expect(sold.status).toBe(409)
    expect(await errorCode(sold)).toBe("SOLD_OUT")
    expect(h.db.select().from(webOrder).all()).toHaveLength(0)
  })

  test("un límite de pedidos por visitante y de pedidos sin atender", async () => {
    await withOrders()
    for (let i = 0; i < 10; i++) expect((await place(order())).status).toBe(201)
    const blocked = await place(order())
    expect(blocked.status).toBe(429)
    expect(await errorCode(blocked)).toBe("RATE_LIMITED")
    expect((await place(order(), "192.168.1.21")).status).toBe(201)
    // Con 300 sin atender no se anotan más.
    for (let n = 12; n <= 300; n++) {
      h.db
        .insert(webOrder)
        .values({
          id: `x${n}`,
          number: n,
          customerName: "x",
          customerPhone: "04141112233",
          delivery: "pickup",
          lines: [],
          referenceCurrency: "USD",
          legalCurrency: "VES",
          createdAt: NOW,
        })
        .run()
    }
    const full = await place(order(), "192.168.1.22")
    expect(await errorCode(full)).toBe("TOO_MANY_ORDERS")
  })

  test("la bandeja: quien vende los ve, los descarta o los da por atendidos", async () => {
    const s = await withOrders()
    const a = (await (await place(order())).json()) as PlacedOrder
    const b = (await (await place(order({ name: "Luis" }))).json()) as PlacedOrder
    const cashier = await newUser(s.owner, "pedro", "cashier")
    const waiter = await newUser(s.owner, "mesonero", "waiter")
    expect((await h.call("/api/orders", { cookie: waiter })).status).toBe(403)
    const list = (await (await h.call("/api/orders", { cookie: cashier })).json()) as WebOrder[]
    expect(list.map((o) => o.number)).toEqual(["P-000002", "P-000001"])
    expect(await (await h.call("/api/orders/count", { cookie: cashier })).json()).toEqual({
      new: 2,
    })

    const cancel = await h.call(`/api/orders/${a.id}/cancel`, {
      cookie: cashier,
      body: { reason: "No contesta" },
    })
    expect(((await cancel.json()) as WebOrder).status).toBe("cancelled")
    const twice = await h.call(`/api/orders/${a.id}/cancel`, { cookie: cashier, body: {} })
    expect(twice.status).toBe(409)
    const done = (await (
      await h.call(`/api/orders/${b.id}/done`, { method: "POST", cookie: cashier })
    ).json()) as WebOrder
    expect(done).toMatchObject({ status: "done", handledByName: "pedro", documentId: null })
    const cancelled = (await (
      await h.call("/api/orders?status=cancelled", { cookie: s.owner })
    ).json()) as WebOrder[]
    expect(cancelled[0]).toMatchObject({ number: "P-000001", cancelReason: "No contesta" })
    expect(await (await h.call("/api/orders/count", { cookie: s.owner })).json()).toEqual({
      new: 0,
    })
    const actions = h.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .all()
      .map((r) => r.action)
    expect(actions).toEqual(expect.arrayContaining(["order.cancelled", "order.done"]))
  })

  test("cobrarlo en la caja lo deja atendido con su venta, una sola vez", async () => {
    const s = await withOrders()
    const placed = (await (await place(order())).json()) as PlacedOrder
    const sale = saleBody(s.terminalId, s.methodUsd, { webOrderId: placed.id })
    const res = await h.call("/api/documents", { cookie: s.owner, body: sale })
    expect(res.status).toBe(201)
    const o = (await (
      await h.call(`/api/orders/${placed.id}`, { cookie: s.owner })
    ).json()) as WebOrder
    expect(o).toMatchObject({ status: "done", documentId: sale.id, documentNumber: "C1-000001" })
    expect(o.handledByName).toBe("Dueña")
    const again = await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.terminalId, s.methodUsd, { webOrderId: placed.id }),
    })
    expect(again.status).toBe(409)
    expect(await errorCode(again)).toBe("ORDER_CLOSED")
    // Solo una venta cobra un pedido.
    const other = (await (await place(order())).json()) as PlacedOrder
    const wrong = await h.call("/api/documents", {
      cookie: s.owner,
      body: { ...saleBody(s.terminalId, s.methodUsd), type: "PURCHASE", webOrderId: other.id },
    })
    expect(wrong.status).not.toBe(201)
  })

  test("avisa por Telegram y a los webhooks que esperan «order.created»", async () => {
    const s = await withOrders()
    writeSetting(h.db, "telegram", {
      token: "123:abc",
      botName: "@Bodega",
      chats: [{ id: "1", name: "Dueña" }],
    })
    const hook = await h.call("/api/webhooks", {
      cookie: s.owner,
      body: { name: "Tienda", url: "https://ejemplo.com/hook", events: ["order.created"] },
    })
    expect(hook.status).toBe(201)
    h.clock.now += 1000
    await place(
      order({
        delivery: "delivery",
        address: "Calle 5, Maracay",
        payment: "Pago móvil",
      }),
    )
    drainOutbox(h.db, h.clock.now)
    const msgs = h.db.select().from(telegramMessage).all()
    expect(msgs.map((m) => m.text)).toEqual([
      "🛒 Pedido P-000001 de Ana (0414-1112233): 2 × Pan. Total $ 3,00. Delivery a Calle 5, Maracay. Paga con Pago móvil.",
    ])
    const deliveries = h.db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.event, "order.created"))
      .all()
    expect(deliveries).toHaveLength(1)
    expect(JSON.parse(deliveries[0]?.body ?? "{}").data).toMatchObject({
      number: "P-000001",
      customerName: "Ana",
    })
  })
})
