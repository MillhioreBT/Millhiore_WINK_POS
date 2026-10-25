import { beforeEach, describe, expect, test } from "bun:test"
import type {
  Bootstrap,
  BranchInfo,
  PairingCode,
  StockLocation,
  SyncStatus,
  TerminalInfo,
} from "@millhiore/contracts"
import { cashShift, document, stockBalance, variant } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, eq } from "drizzle-orm"
import {
  cashAccountIds,
  type Harness,
  harness,
  openShiftFor,
  saleBody,
  setUp,
} from "../../testing/harness"
import { readLink } from "./link"

let central: Harness
let sat: Harness
/** La sucursal llega al central como por la red. */
const toCentral = ((input: string | URL | Request, init?: RequestInit) =>
  central.fetch(input, init)) as typeof fetch
beforeEach(() => {
  central = harness()
  sat = harness({ sync: { fetcher: toCentral } })
})

const json = async <T>(res: Response | Promise<Response>): Promise<T> =>
  (await (await res).json()) as T
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

/** El central con las sucursales encendidas y «Centro» (con su tienda y su caja). */
async function centralWithCentro() {
  const s = await setUp(central)
  await central.call("/api/settings/features", {
    method: "PUT",
    cookie: s.owner,
    body: { branches: true },
  })
  const centro = await json<BranchInfo>(
    central.call("/api/branches", { cookie: s.owner, body: { name: "Centro" } }),
  )
  const terminals = await json<TerminalInfo[]>(central.call("/api/terminals", { cookie: s.owner }))
  const till = terminals.find((t) => t.branchId === centro.id)
  const locations = await json<StockLocation[]>(central.call("/api/locations", { cookie: s.owner }))
  const store = locations.find((l) => l.branchId === centro.id)
  const mainStore = locations.find((l) => l.branchId === "main")
  if (!till || !store || !mainStore) throw new Error("Centro no trajo su caja o su tienda")
  return { ...s, centro, till, store, mainStore }
}

async function pairingCode(owner: string, branchId: string): Promise<PairingCode> {
  const res = await central.call("/api/sync/codes", { cookie: owner, body: { branchId } })
  expect(res.status).toBe(201)
  return (await res.json()) as PairingCode
}

/** El central con Centro y una sucursal ya unida (con la historia de Centro bajada). */
async function joined() {
  const c = await centralWithCentro()
  const { code } = await pairingCode(c.owner, c.centro.id)
  const res = await sat.call("/api/setup/join", {
    body: { centralUrl: "central.local:3000", code, name: "PC Centro" },
  })
  expect(res.status).toBe(201)
  await sat.sync.run()
  const owner = await sat.login("duena", "clave-segura-1")
  return { ...c, satOwner: owner }
}

/** Cierra contando todo en cero. */
const closeBody = (h: Harness) => ({
  counts: Object.values(cashAccountIds(h)).map((accountId) => ({ accountId, countedMinor: 0 })),
})

const stockAt = (h: Harness, locationId: string) =>
  h.db
    .select()
    .from(stockBalance)
    .where(and(eq(stockBalance.variantId, "v1"), eq(stockBalance.locationId, locationId)))
    .get()?.qtyMilli ?? 0

describe("central y sucursales", () => {
  test("la sucursal se une con un código y baja el negocio, los usuarios y su historia", async () => {
    const c = await centralWithCentro()
    // Lo que se vendió en Centro antes de que tuviera servidor propio.
    await openShiftFor(central, c.owner, c.till.id, {})
    const before = await central.call("/api/documents", {
      cookie: c.owner,
      body: saleBody(c.till.id, c.methodUsd),
    })
    expect(before.status).toBe(201)
    const sold = (await before.json()) as { id: string; number: string }

    // No con un turno abierto, ni para la principal.
    let res = await central.call("/api/sync/codes", {
      cookie: c.owner,
      body: { branchId: c.centro.id },
    })
    expect(res.status).toBe(409)
    res = await central.call("/api/sync/codes", { cookie: c.owner, body: { branchId: "main" } })
    expect(res.status).toBe(422)
    const shift = central.db
      .select()
      .from(cashShift)
      .where(and(eq(cashShift.terminalId, c.till.id), eq(cashShift.status, "open")))
      .get()
    res = await central.call(`/api/shifts/${shift?.id}/close`, {
      cookie: c.owner,
      body: closeBody(central),
    })
    expect(res.status).toBe(200)

    const code = await pairingCode(c.owner, c.centro.id)
    expect(code.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)

    // Un código mal escrito no sirve; bien escrito (sin guiones, en minúsculas), sí.
    res = await sat.call("/api/setup/join", {
      body: { centralUrl: "http://central.local:3000/", code: "AAAA-BBBB-CCCC" },
    })
    expect(res.status).toBe(422)
    expect(await errorCode(res)).toBe("INVALID_CODE")
    res = await sat.call("/api/setup/join", {
      body: {
        centralUrl: "http://central.local:3000/",
        code: code.code.replace(/-/g, "").toLowerCase(),
        name: "PC Centro",
      },
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ businessName: "Bodega La Esquina", branchName: "Centro" })
    await sat.sync.run()

    // Se entra con los usuarios del central y solo se ve Centro.
    const owner = await sat.login("duena", "clave-segura-1")
    const boot = await json<Bootstrap>(sat.call("/api/bootstrap", { cookie: owner }))
    expect(boot.terminals.map((t) => t.id)).toEqual([c.till.id])
    // Las ubicaciones de las demás siguen ahí: son el destino de un traslado.
    expect(boot.locations.map((l) => l.id).sort()).toEqual([c.mainStore.id, c.store.id].sort())
    // Su historia bajó: la venta de antes y lo que hay en su tienda.
    expect(sat.db.select().from(document).where(eq(document.id, sold.id)).get()?.number).toBe(
      sold.number,
    )
    expect(stockAt(sat, c.store.id)).toBe(stockAt(central, c.store.id))
    expect(stockAt(sat, c.store.id)).toBe(-2000)

    const status = await json<SyncStatus>(sat.call("/api/sync/status", { cookie: owner }))
    expect(status.role).toBe("satellite")
    expect(status.central).toMatchObject({
      url: "http://central.local:3000",
      branchName: "Centro",
      pendingDocuments: 0,
      lastError: null,
    })
    const peers = await json<SyncStatus>(central.call("/api/sync/status", { cookie: c.owner }))
    expect(peers.role).toBe("central")
    expect(peers.peers).toMatchObject([{ branchId: c.centro.id, name: "PC Centro" }])

    // El código era de un solo uso.
    const other = harness({ sync: { fetcher: toCentral } })
    res = await other.call("/api/setup/join", {
      body: { centralUrl: "central.local:3000", code: code.code },
    })
    expect(res.status).toBe(422)
    // Y una PC ya configurada no se une.
    res = await sat.call("/api/setup/join", {
      body: { centralUrl: "central.local:3000", code: code.code },
    })
    expect(res.status).toBe(409)
  })

  test("lo que se vende en la sucursal llega al central, que ya no registra en ella", async () => {
    const c = await joined()
    const shift = await openShiftFor(sat, c.satOwner, c.till.id, {})
    const res = await sat.call("/api/documents", {
      cookie: c.satOwner,
      body: saleBody(c.till.id, c.methodUsd),
    })
    expect(res.status).toBe(201)
    const sale = (await res.json()) as { id: string; number: string }
    let status = await json<SyncStatus>(sat.call("/api/sync/status", { cookie: c.satOwner }))
    expect(status.central?.pendingDocuments).toBe(1)

    status = await json<SyncStatus>(
      sat.call("/api/sync/run", { method: "POST", cookie: c.satOwner }),
    )
    expect(status.central?.pendingDocuments).toBe(0)
    expect(status.central?.lastError).toBeNull()
    const there = central.db.select().from(document).where(eq(document.id, sale.id)).get()
    expect(there?.number).toBe(sale.number)
    expect(stockAt(central, c.store.id)).toBe(-2000)
    expect(
      central.db.select().from(cashShift).where(eq(cashShift.id, shift.id)).get()?.status,
    ).toBe("open")
    // Sus eventos también, para los webhooks, Telegram y los plugins del central.
    const events = central.db.$client
      .query("select type from outbox where delivered_at is null and payload like ?")
      .all(`%${sale.id}%`) as { type: string }[]
    expect(events.map((e) => e.type)).toContain("document.posted")
    // Repetir (o reenviar todo) no duplica nada.
    await sat.sync.run()
    status = await json<SyncStatus>(
      sat.call("/api/sync/run?resend=1", { method: "POST", cookie: c.satOwner }),
    )
    expect(status.central?.lastError).toBeNull()
    expect(
      central.db.$client.query("select count(*) as n from document where id = ?").get(sale.id),
    ).toEqual({ n: 1 })

    // Los números de una factura anotados allá también suben.
    const invoiced = await sat.call("/api/documents", {
      cookie: c.satOwner,
      body: saleBody(c.till.id, c.methodUsd, {
        customer: { name: "Pedro", taxId: "V1" },
        invoice: true,
      }),
    })
    const invoicedId = ((await invoiced.json()) as { id: string }).id
    const recorded = await sat.call(`/api/documents/${invoicedId}/invoice`, {
      method: "PUT",
      cookie: c.satOwner,
      body: { invoiceNumber: "000001", controlNumber: "00-000001" },
    })
    expect(recorded.status).toBe(200)
    await sat.sync.run()
    expect(
      central.db.$client
        .query("select control_number from fiscal_invoice where document_id = ?")
        .get(invoicedId),
    ).toEqual({ control_number: "00-000001" })
    // Y el central no anota facturas de las ventas de Centro.
    const foreign = await central.call(`/api/documents/${invoicedId}/invoice`, {
      method: "PUT",
      cookie: c.owner,
      body: { invoiceNumber: "000002", controlNumber: "00-000002" },
    })
    expect(foreign.status).toBe(409)

    // En el central ya no se vende ni se abre turno en Centro.
    let blocked = await central.call("/api/documents", {
      cookie: c.owner,
      body: saleBody(c.till.id, c.methodUsd),
    })
    expect(blocked.status).toBe(409)
    expect(await errorCode(blocked)).toBe("OTHER_SERVER")
    blocked = await central.call(`/api/shifts/${shift.id}/close`, {
      cookie: c.owner,
      body: closeBody(central),
    })
    expect(blocked.status).toBe(409)

    // Al cerrar el turno allá, el central lo ve cerrado.
    const closed = await sat.call(`/api/shifts/${shift.id}/close`, {
      cookie: c.satOwner,
      body: closeBody(sat),
    })
    expect(closed.status).toBe(200)
    await sat.sync.run()
    expect(
      central.db.select().from(cashShift).where(eq(cashShift.id, shift.id)).get()?.status,
    ).toBe("closed")
  })

  test("el catálogo y los ajustes se cambian en el central y bajan solos", async () => {
    const c = await joined()
    let res = await sat.call("/api/categories", { cookie: c.satOwner, body: { name: "Bebidas" } })
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe("MANAGED_BY_CENTRAL")
    res = await sat.call("/api/settings/features", {
      method: "PUT",
      cookie: c.satOwner,
      body: { dining: true },
    })
    expect(res.status).toBe(409)

    res = await central.call("/api/categories", { cookie: c.owner, body: { name: "Bebidas" } })
    expect(res.status).toBe(201)
    const version = readLink(sat.db)?.masterVersion
    await sat.sync.run()
    expect(readLink(sat.db)?.masterVersion).not.toBe(version)
    expect(sat.db.$client.query("select name from category where name = 'Bebidas'").get()).toEqual({
      name: "Bebidas",
    })

    // Un cliente nuevo de la sucursal sube al central.
    res = await sat.call("/api/contacts", {
      cookie: c.satOwner,
      body: { kind: "customer", name: "María Pérez", taxId: "V12345678" },
    })
    expect(res.status).toBe(201)
    const maria = (await res.json()) as { id: string }
    await sat.sync.run()
    expect(central.db.$client.query("select name from contact where id = ?").get(maria.id)).toEqual(
      { name: "María Pérez" },
    )
  })

  test("la compra de una sucursal deja su costo en el central; un traslado del central le llega", async () => {
    const c = await joined()
    await openShiftFor(sat, c.satOwner, c.till.id, {})
    const purchase = await sat.call("/api/documents", {
      cookie: c.satOwner,
      body: {
        id: uuidv7(),
        type: "PURCHASE",
        terminalId: c.till.id,
        currency: "USD",
        rate: { base: "USD", quote: "VES", value: "36.5" },
        pricesIncludeTax: true,
        lines: [{ variantId: "v1", qtyMilli: 5000, unitPriceMinor: 116 }],
        payments: [
          { id: uuidv7(), paymentMethodId: c.methodUsd, currency: "USD", amountMinor: 580 },
        ],
      },
    })
    expect(purchase.status).toBe(201)
    await sat.sync.run()
    // El mismo costo que deja allá (sin el IVA, que el negocio acredita).
    const cost = sat.db.select().from(variant).where(eq(variant.id, "v1")).get()?.costMinor
    expect(cost).toBe(100)
    expect(central.db.select().from(variant).where(eq(variant.id, "v1")).get()?.costMinor).toBe(
      cost,
    )
    expect(stockAt(central, c.store.id)).toBe(5000)

    // El central le manda mercancía a Centro.
    const sent = await central.call("/api/documents", {
      cookie: c.owner,
      body: {
        id: uuidv7(),
        type: "STOCK_TRANSFER",
        terminalId: c.terminalId,
        locationId: c.mainStore.id,
        toLocationId: c.store.id,
        currency: "USD",
        rate: { base: "USD", quote: "VES", value: "36.5" },
        lines: [{ variantId: "v1", qtyMilli: 3000, unitPriceMinor: 0 }],
        payments: [],
      },
    })
    expect(sent.status).toBe(201)
    await sat.sync.run()
    expect(stockAt(sat, c.store.id)).toBe(8000)
    expect(stockAt(central, c.store.id)).toBe(8000)
    // Lo que llegó del central no se vuelve a subir.
    const status = await json<SyncStatus>(sat.call("/api/sync/status", { cookie: c.satOwner }))
    expect(status.central?.pendingDocuments).toBe(0)
  })

  test("el central solo acepta de cada sucursal lo suyo, con su clave y la misma versión", async () => {
    const c = await joined()
    const token = readLink(sat.db)?.token ?? ""
    const auth = { authorization: `Bearer ${token}` }
    const empty = { contacts: [], shifts: [], documents: [], audit: [], events: [] }
    let res = await central.call("/api/sync/push", { headers: auth, body: { schema: 1, ...empty } })
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe("SYNC_VERSION")
    const schema = (
      central.db.$client.query("select count(*) as n from __drizzle_migrations").get() as {
        n: number
      }
    ).n
    // Un documento de una caja que no es suya.
    res = await central.call("/api/sync/push", {
      headers: auth,
      body: {
        schema,
        ...empty,
        documents: [
          {
            document: { id: uuidv7(), terminal_id: c.terminalId, number: "X-1", type: "SALE" },
            lines: [],
            taxes: [],
            surcharges: [],
            charges: [],
            payments: [],
            allocations: [],
            lots: [],
            stockMoves: [],
            accountMoves: [],
          },
        ],
      },
    })
    expect(res.status).toBe(403)
    expect(await errorCode(res)).toBe("SYNC_FOREIGN")
    res = await central.call("/api/sync/master", { headers: { authorization: "Bearer mws_falsa" } })
    expect(res.status).toBe(401)
    // Ni el código ni la clave sirven para entrar a la API.
    res = await central.call("/api/bootstrap", { headers: auth })
    expect(res.status).toBe(401)

    // Si el central la quita, la sucursal lo dice.
    res = await central.call(`/api/sync/peers/${c.centro.id}`, {
      method: "DELETE",
      cookie: c.owner,
    })
    expect(res.status).toBe(204)
    await sat.sync.run()
    const status = await json<SyncStatus>(sat.call("/api/sync/status", { cookie: c.satOwner }))
    expect(status.central?.lastError).toContain("ya no reconoce")
  })
})
