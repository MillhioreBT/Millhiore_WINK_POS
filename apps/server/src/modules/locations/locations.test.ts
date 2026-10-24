import { beforeEach, describe, expect, test } from "bun:test"
import type {
  CatalogItem,
  DocumentDetail,
  DocumentSummary,
  InventoryReport,
  Shift,
  StockLocation,
  TerminalInfo,
} from "@millhiore/contracts"
import { stockBalance } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { checkInvariants } from "../../posting/invariants"
import { cashAccountIds, type Harness, harness, saleBody, setUp } from "../../testing/harness"
import { writeSetting } from "../settings/service"

let h: Harness
beforeEach(() => {
  h = harness()
})

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

async function newLocation(cookie: string, name: string, kind = "warehouse") {
  const res = await h.call("/api/locations", { cookie, body: { name, kind } })
  expect(res.status).toBe(201)
  return (await res.json()) as StockLocation
}

const stockAt = (variantId: string, locationId: string) =>
  h.db
    .select()
    .from(stockBalance)
    .all()
    .find((b) => b.variantId === variantId && b.locationId === locationId)?.qtyMilli ?? 0

const purchase = (terminalId: string, qtyMilli: number, locationId?: string) => ({
  id: uuidv7(),
  type: "PURCHASE",
  terminalId,
  currency: "USD",
  rate: { base: "USD", quote: "VES", value: "36.5" },
  lines: [{ variantId: "v1", qtyMilli, unitPriceMinor: 100 }],
  // Con el IVA incluido, lo pagado es cantidad × costo.
  pricesIncludeTax: true,
  payments: [],
  ...(locationId ? { locationId } : {}),
})

// Compra pagada en efectivo desde la caja 1, a 1 $ cada unidad.
async function stockUp(
  s: Awaited<ReturnType<typeof setUp>>,
  qtyMilli: number,
  locationId?: string,
) {
  const res = await h.call("/api/documents", {
    cookie: s.owner,
    body: {
      ...purchase(s.terminalId, qtyMilli, locationId),
      payments: [
        {
          id: uuidv7(),
          paymentMethodId: s.methodUsd,
          currency: "USD",
          amountMinor: qtyMilli / 10,
        },
      ],
    },
  })
  expect(res.status).toBe(201)
}

const transfer = (
  terminalId: string,
  from: string,
  to: string,
  qtyMilli: number,
  over: Record<string, unknown> = {},
) => ({
  id: uuidv7(),
  type: "STOCK_TRANSFER",
  terminalId,
  currency: "VES",
  rate: null,
  locationId: from,
  toLocationId: to,
  lines: [{ variantId: "v1", qtyMilli, unitPriceMinor: 0 }],
  ...over,
})

describe("ubicaciones", () => {
  test("el asistente crea la tienda; se agregan otras, sin nombres repetidos", async () => {
    const s = await setUp(h)
    const list = async (all = false) =>
      (await (
        await h.call(`/api/locations${all ? "?all=true" : ""}`, { cookie: s.owner })
      ).json()) as StockLocation[]
    expect((await list()).map((l) => l.kind)).toEqual(["store"])
    const deposito = await newLocation(s.owner, "Depósito")
    expect(deposito).toMatchObject({ kind: "warehouse", active: true, productsInStock: 0 })
    const again = await h.call("/api/locations", {
      cookie: s.owner,
      body: { name: "depósito", kind: "store" },
    })
    expect(again.status).toBe(409)
    // La tienda primero, después el depósito.
    expect((await list()).map((l) => l.name)).toEqual([expect.any(String), "Depósito"])
    const boot = (await (await h.call("/api/bootstrap", { cookie: s.owner })).json()) as {
      locations: { name: string }[]
    }
    expect(boot.locations.map((l) => l.name)).toContain("Depósito")
  })

  test("no se desactiva con existencia ni con una caja que vende desde ella", async () => {
    const s = await setUp(h)
    const deposito = await newLocation(s.owner, "Depósito")
    await stockUp(s, 5000, deposito.id)
    const off = (id: string) =>
      h.call(`/api/locations/${id}`, { method: "PATCH", cookie: s.owner, body: { active: false } })
    let res = await off(deposito.id)
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe("LOCATION_HAS_STOCK")
    const tienda = (await (await h.call("/api/locations", { cookie: s.owner })).json()) as
      | StockLocation[]
      | never
    const store = tienda.find((l) => l.kind === "store")
    if (!store) throw new Error("sin tienda")
    res = await off(store.id)
    expect(await errorCode(res)).toBe("LOCATION_IN_USE")
    // Se traslada todo a la tienda y entonces sí.
    expect(
      (
        await h.call("/api/documents", {
          cookie: s.owner,
          body: transfer(s.terminalId, deposito.id, store.id, 5000),
        })
      ).status,
    ).toBe(201)
    res = await off(deposito.id)
    expect(res.status).toBe(200)
    expect(((await res.json()) as StockLocation).active).toBe(false)
  })

  test("solo quien maneja los ajustes crea ubicaciones o cajas", async () => {
    const s = await setUp(h)
    const res = await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Ana", username: "ana", password: "clave-segura-2", roleId: "warehouse" },
    })
    expect(res.status).toBe(201)
    const ana = await h.login("ana", "clave-segura-2")
    expect(
      (await h.call("/api/locations", { cookie: ana, body: { name: "X", kind: "store" } })).status,
    ).toBe(403)
    expect(
      (await h.call("/api/terminals", { cookie: ana, body: { name: "Caja 2", locationId: "x" } }))
        .status,
    ).toBe(403)
  })
})

describe("traslados", () => {
  test("la compra entra al depósito, se traslada a la tienda y la caja vende de la suya", async () => {
    const s = await setUp(h)
    const deposito = await newLocation(s.owner, "Depósito")
    const store = (
      (await (await h.call("/api/locations", { cookie: s.owner })).json()) as StockLocation[]
    ).find((l) => l.kind === "store")
    if (!store) throw new Error("sin tienda")
    await stockUp(s, 10_000, deposito.id)
    expect(stockAt("v1", deposito.id)).toBe(10_000)
    expect(stockAt("v1", store.id)).toBe(0)

    const res = await h.call("/api/documents", {
      cookie: s.owner,
      body: transfer(s.terminalId, deposito.id, store.id, 4000, { note: "Para el mostrador" }),
    })
    expect(res.status).toBe(201)
    const posted = (await res.json()) as { id: string; number: string; totalMinor: number }
    expect(posted.number).toBe("C1-TL-000001")
    expect(posted.totalMinor).toBe(0)
    expect(stockAt("v1", deposito.id)).toBe(6000)
    expect(stockAt("v1", store.id)).toBe(4000)

    const items = (await (await h.call("/api/products", { cookie: s.owner })).json()) as
      | CatalogItem[]
      | never
    expect(items.find((i) => i.variantId === "v1")).toMatchObject({
      stockMilli: 10_000,
      stockByLocation: { [deposito.id]: 6000, [store.id]: 4000 },
    })

    const sale = await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.terminalId, s.methodUsd),
    })
    expect(sale.status).toBe(201)
    expect(stockAt("v1", store.id)).toBe(2000)
    expect(stockAt("v1", deposito.id)).toBe(6000)

    const detail = (await (
      await h.call(`/api/documents/${posted.id}`, { cookie: s.owner })
    ).json()) as DocumentDetail
    expect(detail).toMatchObject({
      type: "STOCK_TRANSFER",
      locationName: "Depósito",
      toLocationName: store.name,
      note: "Para el mostrador",
    })
    expect(detail.lines).toHaveLength(1)
    const list = (await (
      await h.call("/api/documents?type=STOCK_TRANSFER", { cookie: s.owner })
    ).json()) as DocumentSummary[]
    expect(list.map((d) => d.toLocationName)).toEqual([store.name])

    const report = async (q = "") =>
      (await (
        await h.call(`/api/reports/inventory${q}`, { cookie: s.owner })
      ).json()) as InventoryReport
    expect((await report()).rows[0]?.stockMilli).toBe(8000)
    expect((await report(`?locationId=${deposito.id}`)).rows[0]?.stockMilli).toBe(6000)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("anularlo devuelve la mercancía al origen; sin existencia no se traslada si el negocio no lo permite", async () => {
    const s = await setUp(h)
    const deposito = await newLocation(s.owner, "Depósito")
    const store = (
      (await (await h.call("/api/locations", { cookie: s.owner })).json()) as StockLocation[]
    ).find((l) => l.kind === "store")
    if (!store) throw new Error("sin tienda")
    await stockUp(s, 3000, store.id)
    const res = await h.call("/api/documents", {
      cookie: s.owner,
      body: transfer(s.terminalId, store.id, deposito.id, 3000),
    })
    const { id } = (await res.json()) as { id: string }
    const voided = await h.call(`/api/documents/${id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7(), reason: "Se equivocó de producto" },
    })
    expect(voided.status).toBe(201)
    expect(stockAt("v1", store.id)).toBe(3000)
    expect(stockAt("v1", deposito.id)).toBe(0)

    writeSetting(h.db, "inventory.allowNegativeStock", false)
    const short = await h.call("/api/documents", {
      cookie: s.owner,
      body: transfer(s.terminalId, store.id, deposito.id, 4000),
    })
    expect(short.status).toBe(409)
    expect(await errorCode(short)).toBe("INSUFFICIENT_STOCK")
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("rechaza la misma ubicación, servicios, ubicaciones inactivas y elegir ubicación al vender", async () => {
    const s = await setUp(h)
    const deposito = await newLocation(s.owner, "Depósito")
    const cocina = await newLocation(s.owner, "Cocina", "kitchen")
    await h.call(`/api/locations/${cocina.id}`, {
      method: "PATCH",
      cookie: s.owner,
      body: { active: false },
    })
    const post = (body: unknown) => h.call("/api/documents", { cookie: s.owner, body })
    expect((await post(transfer(s.terminalId, deposito.id, deposito.id, 1000))).status).toBe(422)
    expect((await post(transfer(s.terminalId, deposito.id, cocina.id, 1000))).status).toBe(422)
    expect(
      (await post({ ...saleBody(s.terminalId, s.methodUsd), locationId: deposito.id })).status,
    ).toBe(422)
    expect(checkInvariants(h.db)).toEqual([])
  })
})

describe("varias cajas", () => {
  test("cada caja cuenta su propia gaveta: la segunda arranca vacía aunque la primera tenga dinero", async () => {
    const s = await setUp(h)
    const deposito = await newLocation(s.owner, "Mostrador 2", "store")
    let res = await h.call("/api/terminals", {
      cookie: s.owner,
      body: { name: "Caja 2", locationId: deposito.id },
    })
    expect(res.status).toBe(201)
    const caja2 = (await res.json()) as TerminalInfo
    expect(caja2).toMatchObject({ code: "C2", locationName: "Mostrador 2", shiftOpen: false })

    // La caja 1 vende 3 $ en efectivo: su gaveta tiene 3 $.
    expect(
      (
        await h.call("/api/documents", {
          cookie: s.owner,
          body: saleBody(s.terminalId, s.methodUsd),
        })
      ).status,
    ).toBe(201)
    // La caja 2 abre con su gaveta vacía: no hay diferencia que asentar.
    const accounts = cashAccountIds(h)
    res = await h.call("/api/shifts", {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        terminalId: caja2.id,
        counts: Object.values(accounts).map((accountId) => ({ accountId, countedMinor: 0 })),
      },
    })
    expect(res.status).toBe(201)
    const shift2 = (await res.json()) as Shift
    expect(shift2.accounts.every((a) => a.openingExpectedMinor === 0)).toBe(true)

    // Vende de su propia ubicación: sin existencia ahí, queda en negativo (el negocio lo permite).
    await stockUp(s, 5000, deposito.id)
    res = await h.call("/api/documents", { cookie: s.owner, body: saleBody(caja2.id, s.methodUsd) })
    expect(res.status).toBe(201)
    expect((await res.json()) as { number: string }).toMatchObject({ number: "C2-000001" })
    expect(stockAt("v1", deposito.id)).toBe(3000)

    // Al cerrar, cada caja espera solo lo suyo.
    const close = (shiftId: string, usd: number) =>
      h.call(`/api/shifts/${shiftId}/close`, {
        cookie: s.owner,
        body: {
          counts: Object.entries(accounts).map(([name, accountId]) => ({
            accountId,
            countedMinor: name === "Efectivo USD" ? usd : 0,
          })),
        },
      })
    res = await close(shift2.id, 300)
    expect(res.status).toBe(200)
    const closed2 = (await res.json()) as Shift
    expect(
      closed2.accounts.map((a) => [a.accountName, a.closingExpectedMinor, a.differenceMinor]),
    ).toEqual(expect.arrayContaining([["Efectivo USD", 300, 0]]))
    expect(closed2.accounts.every((a) => a.differenceMinor === 0)).toBe(true)
    // La caja 1 vendió 3 $ y pagó 5 $ de la compra: espera −2 $; contar 0 deja 2 $ de sobrante.
    res = await close(s.shiftId, 0)
    expect(res.status).toBe(200)
    const closed1 = (await res.json()) as Shift
    expect(closed1.accounts.find((a) => a.accountName === "Efectivo USD")).toMatchObject({
      closingExpectedMinor: -200,
      differenceMinor: 200,
    })
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("no se mueve ni se desactiva con el turno abierto; tiene que quedar una caja", async () => {
    const s = await setUp(h)
    const otra = await newLocation(s.owner, "Tienda 2", "store")
    const patch = (id: string, body: unknown) =>
      h.call(`/api/terminals/${id}`, { method: "PATCH", cookie: s.owner, body })
    let res = await patch(s.terminalId, { locationId: otra.id })
    expect(await errorCode(res)).toBe("SHIFT_OPEN")
    res = await h.call("/api/terminals", {
      cookie: s.owner,
      body: { name: "Caja 1 bis", locationId: otra.id, code: "C1" },
    })
    expect(await errorCode(res)).toBe("DUPLICATE_CODE")
    res = await h.call("/api/terminals", {
      cookie: s.owner,
      body: { name: "Caja de la tienda 2", locationId: otra.id, code: "t2" },
    })
    const t2 = (await res.json()) as TerminalInfo
    expect(t2.code).toBe("T2")
    res = await patch(t2.id, { active: false })
    expect(res.status).toBe(200)
    res = await patch(t2.id, { active: true })
    expect(res.status).toBe(200)
    // Con la caja 1 cerrada y la 2 desactivada, la 1 es la última.
    await patch(t2.id, { active: false })
    const accounts = cashAccountIds(h)
    await h.call(`/api/shifts/${s.shiftId}/close`, {
      cookie: s.owner,
      body: {
        counts: Object.values(accounts).map((accountId) => ({ accountId, countedMinor: 0 })),
      },
    })
    res = await patch(s.terminalId, { active: false })
    expect(await errorCode(res)).toBe("LAST_TERMINAL")
    const all = (await (await h.call("/api/terminals?all=true", { cookie: s.owner })).json()) as
      | TerminalInfo[]
      | never
    expect(all.map((t) => [t.code, t.active])).toEqual([
      ["C1", true],
      ["T2", false],
    ])
  })
})
