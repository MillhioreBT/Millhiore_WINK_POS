import { beforeEach, describe, expect, test } from "bun:test"
import type {
  Bootstrap,
  BranchInfo,
  CatalogItem,
  DocumentDetail,
  DocumentSummary,
  Me,
  SalesReport,
  StockLocation,
  TerminalInfo,
  UserRow,
} from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import { type Harness, harness, NOW, openShiftFor, saleBody, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

const json = async <T>(res: Response | Promise<Response>): Promise<T> =>
  (await (await res).json()) as T

/** Negocio con las sucursales encendidas y una segunda, «Centro». */
async function withCentro() {
  const s = await setUp(h)
  const res = await h.call("/api/settings/features", {
    method: "PUT",
    cookie: s.owner,
    body: { branches: true },
  })
  expect(((await res.json()) as { locations: boolean }).locations).toBe(true)
  const created = await h.call("/api/branches", {
    cookie: s.owner,
    body: { name: "Centro", address: "Calle 5, Maracay", phone: null },
  })
  expect(created.status).toBe(201)
  const centro = (await created.json()) as BranchInfo
  const terminals = await json<TerminalInfo[]>(h.call("/api/terminals", { cookie: s.owner }))
  const till = terminals.find((t) => t.branchId === centro.id)
  if (!till) throw new Error("la sucursal no trajo su caja")
  return { ...s, centro, till }
}

async function newUser(
  owner: string,
  username: string,
  roleId: string,
  branchIds: string[] | null,
): Promise<string> {
  const res = await h.call("/api/users", {
    cookie: owner,
    body: { name: username, username, password: "otra-clave-1", roleId, branchIds },
  })
  expect(res.status).toBe(201)
  return h.login(username, "otra-clave-1")
}

describe("sucursales", () => {
  test("existe la principal y una nueva llega con su tienda y su caja, lista para vender", async () => {
    const { owner, centro, till, methodUsd } = await withCentro()
    expect(centro).toMatchObject({ name: "Centro", locations: 1, terminals: 1, active: true })
    expect(till).toMatchObject({ code: "C2", name: "Caja Centro", locationName: "Centro" })
    const branches = await json<BranchInfo[]>(h.call("/api/branches", { cookie: owner }))
    expect(branches.map((b) => b.name)).toEqual(["Principal", "Centro"])

    const dup = await h.call("/api/branches", { cookie: owner, body: { name: "centro" } })
    expect(dup.status).toBe(409)

    const boot = await json<Bootstrap>(h.call("/api/bootstrap", { cookie: owner }))
    expect(boot.branches.map((b) => b.name)).toEqual(["Principal", "Centro"])
    expect(boot.terminals.map((t) => t.branchId)).toEqual(["main", centro.id])
    expect(boot.locations.find((l) => l.name === "Centro")?.branchId).toBe(centro.id)

    // Se vende en ella como en cualquier caja.
    await openShiftFor(h, owner, till.id, {})
    const sale = await h.call("/api/documents", {
      cookie: owner,
      body: saleBody(till.id, methodUsd),
    })
    expect(sale.status).toBe(201)
  })

  test("quien trabaja en una sucursal vende, abre turnos y consulta solo en ella", async () => {
    const s = await withCentro()
    const { owner, centro, till } = s
    const pedro = await newUser(owner, "pedro", "cashier", [centro.id])
    const ana = await newUser(owner, "ana", "manager", [centro.id])

    const me = await json<Me>(h.call("/api/me", { cookie: pedro }))
    expect(me.branchIds).toEqual([centro.id])
    const boot = await json<Bootstrap>(h.call("/api/bootstrap", { cookie: pedro }))
    expect(boot.terminals.map((t) => t.name)).toEqual(["Caja Centro"])

    // En la principal no: ni vender (aunque su turno esté abierto) ni abrir turno.
    const there = await h.call("/api/documents", {
      cookie: pedro,
      body: saleBody(s.terminalId, s.methodUsd),
    })
    expect(there.status).toBe(403)
    expect(await errorCode(there)).toBe("OTHER_BRANCH")

    await openShiftFor(h, pedro, till.id, {})
    const mine = await h.call("/api/documents", {
      cookie: pedro,
      body: saleBody(till.id, s.methodUsd),
    })
    expect(mine.status).toBe(201)
    const mineId = ((await mine.json()) as { id: string }).id
    const main = await h.call("/api/documents", {
      cookie: owner,
      body: saleBody(s.terminalId, s.methodUsd),
    })
    const mainId = ((await main.json()) as { id: string }).id

    // El historial: cada quien lo suyo; la dueña, todo o lo de una sucursal.
    const list = (cookie: string, q = "") =>
      json<DocumentSummary[]>(h.call(`/api/documents?type=SALE${q}`, { cookie }))
    expect((await list(pedro)).map((d) => d.id)).toEqual([mineId])
    expect((await list(owner)).length).toBe(2)
    expect((await list(owner, `&branchId=${centro.id}`)).map((d) => d.id)).toEqual([mineId])
    const other = await h.call("/api/documents?type=SALE&branchId=main", { cookie: pedro })
    expect(other.status).toBe(403)
    expect((await h.call(`/api/documents/${mainId}`, { cookie: ana })).status).toBe(403)

    // Informes: la administradora de Centro ve Centro; la dueña elige.
    const range = `from=${NOW - 86_400_000}&to=${NOW + 86_400_000}`
    const sales = (cookie: string, q = "") =>
      json<SalesReport>(h.call(`/api/reports/sales?${range}${q}`, { cookie }))
    expect((await sales(ana)).totals.count).toBe(1)
    expect((await sales(owner)).totals.count).toBe(2)
    expect((await sales(owner, `&branchId=${centro.id}`)).totals.count).toBe(1)
    expect(
      (await h.call(`/api/reports/sales?${range}&branchId=main`, { cookie: ana })).status,
    ).toBe(403)

    // Anular lo de otra sucursal tampoco.
    const voided = await h.call(`/api/documents/${mainId}/void`, {
      cookie: ana,
      body: { reversalId: uuidv7(), reason: "error" },
    })
    expect(voided.status).toBe(403)

    // La existencia: solo la de sus ubicaciones.
    const items = await json<CatalogItem[]>(h.call("/api/products", { cookie: pedro }))
    const locations = await json<StockLocation[]>(h.call("/api/locations", { cookie: owner }))
    const centroLocation = locations.find((l) => l.branchId === centro.id)?.id ?? ""
    expect(Object.keys(items[0]?.stockByLocation ?? {})).toEqual([centroLocation])

    // Lo que le mandan desde otra sucursal sí lo ve la administradora: sabe qué tiene que llegar.
    const mainLocation = locations.find((l) => l.branchId === "main")?.id ?? ""
    const sent = await h.call("/api/documents", {
      cookie: owner,
      body: {
        id: uuidv7(),
        type: "STOCK_TRANSFER",
        terminalId: s.terminalId,
        locationId: mainLocation,
        toLocationId: centroLocation,
        currency: "USD",
        rate: { base: "USD", quote: "VES", value: "36.5" },
        lines: [{ variantId: "v1", qtyMilli: 1000, unitPriceMinor: 0 }],
        payments: [],
      },
    })
    expect(sent.status).toBe(201)
    const transfers = await json<DocumentSummary[]>(
      h.call("/api/documents?type=STOCK_TRANSFER", { cookie: ana }),
    )
    expect(transfers.length).toBe(1)
    expect((await h.call(`/api/documents/${transfers[0]?.id}`, { cookie: ana })).status).toBe(200)
  })

  test("al apagar las sucursales nadie queda limitado y el recibo deja de nombrarla", async () => {
    const s = await withCentro()
    const pedro = await newUser(s.owner, "pedro", "cashier", [s.centro.id])
    await openShiftFor(h, s.owner, s.till.id, {})
    const sale = await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.till.id, s.methodUsd),
    })
    const id = ((await sale.json()) as { id: string }).id
    const detail = await json<DocumentDetail>(h.call(`/api/documents/${id}`, { cookie: s.owner }))
    expect(detail.branch).toMatchObject({
      name: "Centro",
      address: "Calle 5, Maracay",
      phone: null,
    })

    await h.call("/api/settings/features", {
      method: "PUT",
      cookie: s.owner,
      body: { branches: false },
    })
    expect((await json<Me>(h.call("/api/me", { cookie: pedro }))).branchIds).toBeNull()
    const there = await h.call("/api/documents", {
      cookie: pedro,
      body: saleBody(s.terminalId, s.methodUsd),
    })
    expect(there.status).toBe(201)
    expect(
      (await json<DocumentDetail>(h.call(`/api/documents/${id}`, { cookie: s.owner }))).branch,
    ).toBeNull()
  })

  test("asignar sucursales: el dueño trabaja en todas y se guardan en la lista de usuarios", async () => {
    const { owner, centro } = await withCentro()
    await newUser(owner, "pedro", "cashier", [centro.id])
    const users = await json<UserRow[]>(h.call("/api/users", { cookie: owner }))
    expect(users.find((u) => u.username === "pedro")?.branchIds).toEqual([centro.id])
    expect(users.find((u) => u.username === "duena")?.branchIds).toBeNull()

    const pedroId = users.find((u) => u.username === "pedro")?.id
    const all = await h.call(`/api/users/${pedroId}`, {
      method: "PATCH",
      cookie: owner,
      body: { branchIds: null },
    })
    expect(((await all.json()) as UserRow).branchIds).toBeNull()

    const ownerId = users.find((u) => u.username === "duena")?.id
    const limited = await h.call(`/api/users/${ownerId}`, {
      method: "PATCH",
      cookie: owner,
      body: { branchIds: [centro.id] },
    })
    expect(limited.status).toBe(422)
    expect(await errorCode(limited)).toBe("OWNER_ALL_BRANCHES")

    const unknown = await h.call(`/api/users/${pedroId}`, {
      method: "PATCH",
      cookie: owner,
      body: { branchIds: ["no-existe"] },
    })
    expect(unknown.status).toBe(422)
  })

  test("desactivar: no con cajas activas ni la última; una ubicación con existencia no se muda", async () => {
    const s = await withCentro()
    const off = (id: string) =>
      h.call(`/api/branches/${id}`, { method: "PATCH", cookie: s.owner, body: { active: false } })
    let res = await off(s.centro.id)
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe("BRANCH_IN_USE")
    res = await h.call(`/api/terminals/${s.till.id}`, {
      method: "PATCH",
      cookie: s.owner,
      body: { active: false },
    })
    expect(res.status).toBe(200)
    res = await off(s.centro.id)
    expect(res.status).toBe(200)
    expect(((await res.json()) as BranchInfo).active).toBe(false)
    res = await off("main")
    expect(res.status).toBe(409)

    // Una ubicación nueva en la principal, con existencia: ya no cambia de sucursal.
    const created = await h.call("/api/locations", {
      cookie: s.owner,
      body: { name: "Depósito", kind: "warehouse" },
    })
    const depot = (await created.json()) as StockLocation
    expect(depot.branchId).toBe("main")
    const again = await h.call("/api/branches", { cookie: s.owner, body: { name: "Norte" } })
    const norte = (await again.json()) as BranchInfo
    const purchase = await h.call("/api/documents", {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        type: "PURCHASE",
        terminalId: s.terminalId,
        locationId: depot.id,
        currency: "USD",
        rate: { base: "USD", quote: "VES", value: "36.5" },
        pricesIncludeTax: true,
        lines: [{ variantId: "v1", qtyMilli: 1000, unitPriceMinor: 100 }],
        payments: [
          { id: uuidv7(), paymentMethodId: s.methodUsd, currency: "USD", amountMinor: 100 },
        ],
      },
    })
    expect(purchase.status).toBe(201)
    res = await h.call(`/api/locations/${depot.id}`, {
      method: "PATCH",
      cookie: s.owner,
      body: { branchId: norte.id },
    })
    expect(res.status).toBe(409)
  })
})
