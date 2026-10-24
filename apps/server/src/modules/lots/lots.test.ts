import { beforeEach, describe, expect, test } from "bun:test"
import type {
  CatalogItem,
  DaySummary,
  DocumentDetail,
  Lots,
  StockLocation,
} from "@millhiore/contracts"
import { addDays, uuidv7 } from "@millhiore/domain"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"
import { writeSetting } from "../settings/service"

let h: Harness
beforeEach(() => {
  h = harness()
})

type Ctx = Awaited<ReturnType<typeof setUp>>

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

async function lotsOf(s: Ctx, query = "") {
  const res = await h.call(`/api/lots${query}`, { cookie: s.owner })
  expect(res.status).toBe(200)
  return (await res.json()) as Lots
}

/** Lo que hay de cada lote (por código), sumando ubicaciones. */
async function byCode(s: Ctx) {
  const out: Record<string, number> = {}
  for (const r of (await lotsOf(s)).rows)
    out[r.code ?? "—"] = (out[r.code ?? "—"] ?? 0) + r.qtyMilli
  return out
}

async function withLots(s: Ctx) {
  const res = await h.call("/api/products/p1", {
    method: "PATCH",
    cookie: s.owner,
    body: { tracksLots: true },
  })
  expect(res.status).toBe(200)
  await h.call("/api/settings/features", { method: "PUT", cookie: s.owner, body: { lots: true } })
  return (await lotsOf(s)).today
}

/** Compra pagada en efectivo, a 1 $ la unidad, con IVA incluido. */
async function buy(
  s: Ctx,
  qtyMilli: number,
  lot?: { code?: string | null; expiresOn: string | null },
  over: Record<string, unknown> = {},
) {
  const res = await h.call("/api/documents", {
    cookie: s.owner,
    body: {
      id: uuidv7(),
      type: "PURCHASE",
      terminalId: s.terminalId,
      currency: "USD",
      rate: { base: "USD", quote: "VES", value: "36.5" },
      pricesIncludeTax: true,
      lines: [{ variantId: "v1", qtyMilli, unitPriceMinor: 100, ...(lot ? { lot } : {}) }],
      payments: [
        {
          id: uuidv7(),
          paymentMethodId: s.methodUsd,
          currency: "USD",
          amountMinor: qtyMilli / 10,
        },
      ],
      ...over,
    },
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

async function sell(s: Ctx, qtyMilli: number) {
  const res = await h.call("/api/documents", {
    cookie: s.owner,
    body: saleBody(s.terminalId, s.methodUsd, {
      lines: [{ variantId: "v1", qtyMilli, unitPriceMinor: 150 }],
      payments: [
        {
          id: uuidv7(),
          paymentMethodId: s.methodUsd,
          currency: "USD",
          amountMinor: (qtyMilli / 1000) * 150,
        },
      ],
    }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

const adjust = (s: Ctx, line: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  h.call("/api/documents", {
    cookie: s.owner,
    body: {
      id: uuidv7(),
      type: "ADJUSTMENT",
      terminalId: s.terminalId,
      currency: "VES",
      rate: null,
      lines: [{ variantId: "v1", unitPriceMinor: 0, ...line }],
      ...over,
    },
  })

describe("lotes con vencimiento", () => {
  test("cada compra crea su lote y la venta sale primero del que vence antes", async () => {
    const s = await setUp(h)
    const today = await withLots(s)
    await buy(s, 5000, { code: "L1", expiresOn: addDays(today, 60) })
    await buy(s, 3000, { code: "L2", expiresOn: addDays(today, 10) })
    // El mismo código y la misma fecha completan el lote.
    await buy(s, 1000, { code: "L1", expiresOn: addDays(today, 60) })
    expect(await byCode(s)).toEqual({ L1: 6000, L2: 3000 })

    const sale = await sell(s, 4000)
    expect(await byCode(s)).toEqual({ L1: 5000 })
    const detail = (await (
      await h.call(`/api/documents/${sale.id}`, { cookie: s.owner })
    ).json()) as DocumentDetail
    expect(detail.lines[0]?.lots.map((l) => [l.code, l.qtyMilli])).toEqual([
      ["L2", 3000],
      ["L1", 1000],
    ])
    const items = (await (await h.call("/api/products", { cookie: s.owner })).json()) as
      | CatalogItem[]
      | never
    expect(items.find((i) => i.variantId === "v1")).toMatchObject({
      tracksLots: true,
      stockMilli: 5000,
      expiry: { nextExpiresOn: addDays(today, 60), expiredByLocation: {} },
    })
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("lo que había antes sale primero; lo vencido, al final; la baja lo saca", async () => {
    const s = await setUp(h)
    await buy(s, 2000) // sin lotes todavía
    const today = await withLots(s)
    await buy(s, 3000, { code: "VIEJO", expiresOn: addDays(today, -5) })
    await buy(s, 4000, { code: "NUEVO", expiresOn: addDays(today, 30) })
    const expired = (await lotsOf(s, "?status=expired")).rows
    expect(expired.map((r) => [r.code, r.daysLeft])).toEqual([["VIEJO", -5]])
    const items = (await (await h.call("/api/products", { cookie: s.owner })).json()) as
      | CatalogItem[]
      | never
    expect(Object.values(items[0]?.expiry?.expiredByLocation ?? {})).toEqual([3000])

    // Vende 3: los 2 de antes y 1 del lote bueno; el vencido queda.
    await sell(s, 3000)
    expect(await byCode(s)).toEqual({ VIEJO: 3000, NUEVO: 3000 })

    // Se da de baja el lote vencido con el motivo «Vencido».
    const lotId = expired[0]?.lotId
    const res = await adjust(s, { qtyMilli: -3000, lotId }, { stockReasonId: "stk-out-expired" })
    expect(res.status).toBe(201)
    expect(await byCode(s)).toEqual({ NUEVO: 3000 })
    // Si solo queda lo vencido, la venta igual sale (la caja avisa).
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("una devolución regresa a los lotes de donde salió; las anulaciones lo deshacen", async () => {
    const s = await setUp(h)
    const today = await withLots(s)
    await buy(s, 5000, { code: "L1", expiresOn: addDays(today, 60) })
    await buy(s, 3000, { code: "L2", expiresOn: addDays(today, 10) })
    const sale = await sell(s, 4000)
    let res = await h.call(`/api/documents/${sale.id}/return`, {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        terminalId: s.terminalId,
        rate: { base: "USD", quote: "VES", value: "36.5" },
        lines: [{ lineNo: 1, qtyMilli: 2000 }],
        payments: [
          { id: uuidv7(), paymentMethodId: s.methodUsd, currency: "USD", amountMinor: 300 },
        ],
      },
    })
    expect(res.status).toBe(201)
    const ret = (await res.json()) as { id: string }
    expect(await byCode(s)).toEqual({ L1: 4000, L2: 2000 })
    res = await h.call(`/api/documents/${ret.id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7() },
    })
    expect(res.status).toBe(201)
    res = await h.call(`/api/documents/${sale.id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7() },
    })
    expect(res.status).toBe(201)
    expect(await byCode(s)).toEqual({ L1: 5000, L2: 3000 })
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("un traslado lleva los mismos lotes; se puede elegir de cuál", async () => {
    const s = await setUp(h)
    const today = await withLots(s)
    const dep = (await (
      await h.call("/api/locations", {
        cookie: s.owner,
        body: { name: "Depósito", kind: "warehouse" },
      })
    ).json()) as StockLocation
    const store = (
      (await (await h.call("/api/locations", { cookie: s.owner })).json()) as StockLocation[]
    ).find((l) => l.kind === "store")
    if (!store) throw new Error("sin tienda")
    await buy(s, 5000, { code: "L1", expiresOn: addDays(today, 60) }, { locationId: dep.id })
    await buy(s, 2000, { code: "L2", expiresOn: addDays(today, 10) }, { locationId: dep.id })
    const move = (line: Record<string, unknown>) =>
      h.call("/api/documents", {
        cookie: s.owner,
        body: {
          id: uuidv7(),
          type: "STOCK_TRANSFER",
          terminalId: s.terminalId,
          currency: "VES",
          rate: null,
          locationId: dep.id,
          toLocationId: store.id,
          lines: [{ variantId: "v1", unitPriceMinor: 0, ...line }],
        },
      })
    expect((await move({ qtyMilli: 3000 })).status).toBe(201)
    const at = async (locationId: string) =>
      Object.fromEntries(
        (await lotsOf(s, `?locationId=${locationId}`)).rows.map((r) => [r.code, r.qtyMilli]),
      )
    expect(await at(store.id)).toEqual({ L2: 2000, L1: 1000 })
    expect(await at(dep.id)).toEqual({ L1: 4000 })
    const l1 = (await lotsOf(s, `?locationId=${dep.id}`)).rows[0]?.lotId
    expect((await move({ qtyMilli: 1000, lotId: l1 })).status).toBe(201)
    expect(await at(store.id)).toEqual({ L2: 2000, L1: 2000 })
    // Del lote elegido no se saca más de lo que tiene.
    const short = await move({ qtyMilli: 9000, lotId: l1 })
    expect(short.status).toBe(409)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("valida dónde va un lote: no en ventas, no en productos sin lotes, no de otro producto", async () => {
    const s = await setUp(h)
    const lot = { code: null, expiresOn: "2030-01-01" }
    // El producto todavía no lleva lotes.
    expect((await adjust(s, { qtyMilli: 1000, lot })).status).toBe(422)
    await withLots(s)
    const sale = await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.terminalId, s.methodUsd, {
        lines: [{ variantId: "v1", qtyMilli: 1000, unitPriceMinor: 150, lot }],
        payments: [
          { id: uuidv7(), paymentMethodId: s.methodUsd, currency: "USD", amountMinor: 150 },
        ],
      }),
    })
    expect(sale.status).toBe(422)
    expect((await adjust(s, { qtyMilli: -1000, lot })).status).toBe(422)
    expect((await adjust(s, { qtyMilli: 1000, lot: { expiresOn: "2030-02-31" } })).status).toBe(422)
    const res = await adjust(s, { qtyMilli: -1000, lotId: "no-existe" })
    expect(await errorCode(res)).toBe("UNKNOWN_REFERENCE")
    // Una entrada sin fecha queda sin lote; con fecha, en su lote.
    expect((await adjust(s, { qtyMilli: 1000, lot })).status).toBe(201)
    expect(await byCode(s)).toEqual({ "—": 1000 })
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("se corrige la fecha de un lote, se eligen los días de aviso y Inicio cuenta lo que vence", async () => {
    const s = await setUp(h)
    const today = await withLots(s)
    await buy(s, 2000, { code: "A", expiresOn: addDays(today, 20) })
    await buy(s, 2000, { code: "B", expiresOn: addDays(today, -1) })
    expect((await lotsOf(s, "?status=expiring")).rows.map((r) => r.code)).toEqual(["A"])
    let res = await h.call("/api/settings/lots", {
      method: "PUT",
      cookie: s.owner,
      body: { alertDays: 10 },
    })
    expect(res.status).toBe(200)
    expect((await lotsOf(s, "?status=expiring")).rows).toEqual([])
    const a = (await lotsOf(s)).rows.find((r) => r.code === "A")
    res = await h.call(`/api/lots/${a?.lotId}`, {
      method: "PATCH",
      cookie: s.owner,
      body: { expiresOn: addDays(today, 5), code: "A-1" },
    })
    expect(res.status).toBe(200)
    expect((await lotsOf(s, "?status=expiring")).rows.map((r) => [r.code, r.daysLeft])).toEqual([
      ["A-1", 5],
    ])
    const day = (await (await h.call("/api/reports/day", { cookie: s.owner })).json()) as DaySummary
    expect(day.expiry).toEqual({ alertDays: 10, expiringLots: 1, expiredLots: 1 })
    // Sin la función de lotes, Inicio no los cuenta.
    writeSetting(h.db, "features", { lots: false })
    const off = (await (await h.call("/api/reports/day", { cookie: s.owner })).json()) as DaySummary
    expect(off.expiry).toBeNull()
  })
})
