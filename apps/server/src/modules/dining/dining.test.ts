import { beforeEach, describe, expect, test } from "bun:test"
import type { DiningFloor, TabDetail } from "@millhiore/contracts"
import { auditLog, variant } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"

let h: Harness
let ctx: Awaited<ReturnType<typeof setUp>>
beforeEach(async () => {
  h = harness()
  ctx = await setUp(h)
})

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

async function layout(body: unknown, cookie = ctx.owner) {
  return h.call("/api/dining/layout", { method: "PUT", cookie, body })
}

/** Salón con tres mesas y una terraza con una. */
async function floor(): Promise<DiningFloor> {
  const res = await layout({
    areas: [
      { name: "Salón", tables: [{ name: "1", seats: 4 }, { name: "2" }, { name: "3" }] },
      { name: "Terraza", tables: [{ name: "T1", seats: 2 }] },
    ],
  })
  expect(res.status).toBe(200)
  return (await res.json()) as DiningFloor
}

const tableId = (f: DiningFloor, area: number, i: number) => {
  const id = f.areas[area]?.tables[i]?.id
  if (!id) throw new Error("no existe esa mesa")
  return id
}

async function open(body: Record<string, unknown>, cookie = ctx.owner) {
  const res = await h.call("/api/tabs", { cookie, body: { id: uuidv7(), ...body } })
  return { res, tab: res.status === 201 ? ((await res.json()) as TabDetail) : null }
}

async function order(tabId: string, lines: Record<string, unknown>[], cookie = ctx.owner) {
  return h.call(`/api/tabs/${tabId}/lines`, {
    cookie,
    body: { lines: lines.map((l) => ({ id: uuidv7(), variantId: "v1", qtyMilli: 1000, ...l })) },
  })
}

const detail = async (tabId: string) =>
  (await (await h.call(`/api/tabs/${tabId}`, { cookie: ctx.owner })).json()) as TabDetail

const pendingOf = (t: TabDetail) => t.lines.filter((l) => !l.voidedAt && !l.documentId)

/** Venta que cobra esos productos de la cuenta, a 1,50 $ cada uno, en efectivo. */
function charge(tabId: string, takes: { lineId: string; qtyMilli: number }[], over = {}) {
  const qty = takes.reduce((acc, t) => acc + t.qtyMilli, 0)
  return h.call("/api/documents", {
    cookie: ctx.owner,
    body: saleBody(ctx.terminalId, ctx.methodUsd, {
      lines: [{ variantId: "v1", qtyMilli: qty, unitPriceMinor: 150 }],
      payments: [
        {
          id: uuidv7(),
          paymentMethodId: ctx.methodUsd,
          currency: "USD",
          amountMinor: (qty / 1000) * 150,
        },
      ],
      tab: { id: tabId, lines: takes },
      ...over,
    }),
  })
}

async function waiterCookie() {
  const res = await h.call("/api/users", {
    cookie: ctx.owner,
    body: { name: "Luis", username: "luis", password: "otra-clave-1", roleId: "waiter" },
  })
  expect(res.status).toBe(201)
  return h.login("luis", "otra-clave-1")
}

describe("salas y mesas", () => {
  test("se guardan en orden; se renombran, se mueven y se quitan sin perder las cuentas", async () => {
    const f = await floor()
    expect(f.areas.map((a) => [a.name, a.tables.map((t) => t.name)])).toEqual([
      ["Salón", ["1", "2", "3"]],
      ["Terraza", ["T1"]],
    ])
    expect(f.areas[0]?.tables[0]).toMatchObject({ seats: 4, tab: null })

    // Dos mesas con el mismo nombre en una sala confunden: no. En salas distintas, sí.
    const dup = await layout({
      areas: [{ name: "Salón", tables: [{ name: "1" }, { name: " 1 " }] }],
    })
    expect(dup.status).toBe(422)
    expect(await errorCode(dup)).toBe("DUPLICATE_NAME")

    // La mesa 2 tiene la cuenta abierta: no se puede quitar.
    const { tab } = await open({ tableId: tableId(f, 0, 1) })
    const salon = f.areas[0]
    const terraza = f.areas[1]
    if (!salon || !terraza || !tab) throw new Error("falta el plano")
    const without2 = {
      areas: [
        {
          id: salon.id,
          name: "Salón principal",
          tables: [salon.tables[0], salon.tables[2]].map((t) => ({ id: t?.id, name: t?.name })),
        },
      ],
    }
    const busy = await layout(without2)
    expect(busy.status).toBe(409)
    expect(await errorCode(busy)).toBe("TABLE_BUSY")

    // Se pasa la mesa 2 a la terraza (con su cuenta) y se quita la T1 y la sala vacía no.
    const moved = await layout({
      areas: [
        {
          id: salon.id,
          name: "Salón principal",
          tables: [salon.tables[0], salon.tables[2]].map((t) => ({ id: t?.id, name: t?.name })),
        },
        {
          id: terraza.id,
          name: "Terraza",
          tables: [{ id: salon.tables[1]?.id, name: "2" }, { name: "T2" }],
        },
      ],
    })
    expect(moved.status).toBe(200)
    const after = (await moved.json()) as DiningFloor
    expect(after.areas.map((a) => [a.name, a.tables.map((t) => t.name)])).toEqual([
      ["Salón principal", ["1", "3"]],
      ["Terraza", ["2", "T2"]],
    ])
    expect(after.areas[1]?.tables[0]?.tab?.id).toBe(tab.id)

    // Solo quien configura arma el plano; quien atiende lo ve.
    const luis = await waiterCookie()
    expect((await layout({ areas: [] }, luis)).status).toBe(403)
    expect((await h.call("/api/dining", { cookie: luis })).status).toBe(200)
  })
})

describe("cuentas abiertas", () => {
  test("una por mesa; sin mesa, con nombre; reintentar no abre otra", async () => {
    const f = await floor()
    const id = uuidv7()
    const first = await h.call("/api/tabs", {
      cookie: ctx.owner,
      body: { id, tableId: tableId(f, 0, 0), guests: 3 },
    })
    expect(first.status).toBe(201)
    const tab = (await first.json()) as TabDetail
    expect(tab).toMatchObject({
      number: "CTA-000001",
      tableName: "1",
      areaName: "Salón",
      guests: 3,
      status: "open",
      waiterName: "Dueña",
      pendingQtyMilli: 0,
      lines: [],
    })
    const again = await h.call("/api/tabs", {
      cookie: ctx.owner,
      body: { id, tableId: tableId(f, 0, 0) },
    })
    expect(again.status).toBe(201)
    expect(((await again.json()) as TabDetail).id).toBe(id)

    const busy = await open({ tableId: tableId(f, 0, 0) })
    expect(busy.res.status).toBe(409)
    expect(await errorCode(busy.res)).toBe("TABLE_BUSY")

    expect((await open({})).res.status).toBe(422)
    const bar = await open({ label: "Juan (barra)" })
    expect(bar.tab).toMatchObject({ tableId: null, label: "Juan (barra)", number: "CTA-000002" })

    const plano = (await (await h.call("/api/dining", { cookie: ctx.owner })).json()) as DiningFloor
    expect(plano.areas[0]?.tables[0]?.tab?.id).toBe(id)
    expect(plano.others.map((t) => t.label)).toEqual(["Juan (barra)"])
  })

  test("el pedido guarda el precio del momento; reenviarlo no lo repite", async () => {
    const f = await floor()
    const { tab } = await open({ tableId: tableId(f, 0, 0) })
    if (!tab) throw new Error("no abrió")
    const lines = [
      { id: uuidv7(), variantId: "v1", qtyMilli: 2000, note: "tostado" },
      { id: uuidv7(), variantId: "v1", qtyMilli: 1000 },
    ]
    const res = await h.call(`/api/tabs/${tab.id}/lines`, { cookie: ctx.owner, body: { lines } })
    expect(res.status).toBe(200)
    // Sube el precio: lo ya pedido sigue con el de antes.
    h.db.update(variant).set({ priceMinor: 200 }).where(eq(variant.id, "v1")).run()
    const again = await h.call(`/api/tabs/${tab.id}/lines`, { cookie: ctx.owner, body: { lines } })
    const t = (await again.json()) as TabDetail
    expect(t.lines.map((l) => [l.qtyMilli, l.priceMinor, l.note])).toEqual([
      [2000, 150, "tostado"],
      [1000, 150, null],
    ])
    expect(t.pendingQtyMilli).toBe(3000)
    expect(t.pending).toEqual([{ currency: "USD", amountMinor: 450 }])

    expect((await order(tab.id, [{ variantId: "nope" }])).status).toBe(422)
    // El mismo id en otra cuenta es un error, no un pedido nuevo.
    const other = await open({ tableId: tableId(f, 0, 1) })
    const reused = await h.call(`/api/tabs/${other.tab?.id}/lines`, {
      cookie: ctx.owner,
      body: { lines: [lines[0]] },
    })
    expect(reused.status).toBe(409)
    expect(
      h.db
        .select()
        .from(auditLog)
        .all()
        .map((a) => a.action),
    ).toContain("tab.ordered")
  })

  test("anular lo pedido pide permiso y motivo, y deja la línea tachada", async () => {
    const f = await floor()
    const luis = await waiterCookie()
    const { tab } = await open({ tableId: tableId(f, 0, 0) }, luis)
    if (!tab) throw new Error("no abrió")
    expect(tab.waiterName).toBe("Luis")
    await order(tab.id, [{ qtyMilli: 3000 }], luis)
    const line = pendingOf(await detail(tab.id))[0]
    if (!line) throw new Error("no pidió")
    const url = `/api/tabs/${tab.id}/lines/${line.id}/void`
    expect(
      (await h.call(url, { cookie: luis, body: { qtyMilli: 1000, reason: "se equivocó" } })).status,
    ).toBe(403)
    expect(
      (await h.call(url, { cookie: ctx.owner, body: { qtyMilli: 1000, reason: "" } })).status,
    ).toBe(422)
    const res = await h.call(url, {
      cookie: ctx.owner,
      body: { qtyMilli: 1000, reason: "No lo quiso" },
    })
    expect(res.status).toBe(200)
    const t = (await res.json()) as TabDetail
    expect(t.lines.map((l) => [l.qtyMilli, l.voidReason, l.voidedBy])).toEqual([
      [2000, null, null],
      [1000, "No lo quiso", "Dueña"],
    ])
    expect(t.pendingQtyMilli).toBe(2000)
    // No se anula más de lo que queda.
    const tooMuch = await h.call(url, {
      cookie: ctx.owner,
      body: { qtyMilli: 3000, reason: "todo" },
    })
    expect(tooMuch.status).toBe(409)
  })

  test("se muda a una mesa libre, se junta con una ocupada o se le pasa una parte", async () => {
    const f = await floor()
    const a = (await open({ tableId: tableId(f, 0, 0) })).tab
    const b = (await open({ tableId: tableId(f, 0, 1) })).tab
    if (!a || !b) throw new Error("no abrió")
    await order(a.id, [{ qtyMilli: 2000 }, { qtyMilli: 1000, note: "sin sal" }])
    await order(b.id, [{ qtyMilli: 1000 }])

    // Toda la cuenta a la mesa 3, libre: solo cambia de mesa.
    const mudada = await h.call(`/api/tabs/${a.id}/move`, {
      cookie: ctx.owner,
      body: { tableId: tableId(f, 0, 2) },
    })
    expect(((await mudada.json()) as TabDetail).tableName).toBe("3")

    // Una parte a la terraza (libre): abre una cuenta nueva allí con eso.
    const [dos] = pendingOf(await detail(a.id))
    if (!dos) throw new Error("falta la línea")
    const parte = await h.call(`/api/tabs/${a.id}/move`, {
      cookie: ctx.owner,
      body: { tableId: tableId(f, 1, 0), lines: [{ lineId: dos.id, qtyMilli: 1000 }] },
    })
    const terraza = (await parte.json()) as TabDetail
    expect(terraza).toMatchObject({ tableName: "T1", pendingQtyMilli: 1000 })
    expect((await detail(a.id)).pendingQtyMilli).toBe(2000)

    // La mesa 3 se junta con la 2 (ocupada): la 3 queda cerrada y la 2 con todo.
    const juntas = await h.call(`/api/tabs/${a.id}/move`, {
      cookie: ctx.owner,
      body: { tableId: tableId(f, 0, 1) },
    })
    const dosMesa = (await juntas.json()) as TabDetail
    expect(dosMesa.id).toBe(b.id)
    expect(dosMesa.pendingQtyMilli).toBe(3000)
    // En el orden en que se pidieron (con el reloj quieto de las pruebas, el de inserción).
    expect(pendingOf(dosMesa).map((l) => l.note)).toEqual([null, "sin sal", null])
    expect(await detail(a.id)).toMatchObject({
      status: "cancelled",
      cancelReason: `Pasada a la cuenta ${b.number}`,
    })
    const same = await h.call(`/api/tabs/${b.id}/move`, {
      cookie: ctx.owner,
      body: { tableId: tableId(f, 0, 1) },
    })
    expect(same.status).toBe(422)
  })

  test("se cobra por partes y se cierra al quedar saldada", async () => {
    const f = await floor()
    const { tab } = await open({ tableId: tableId(f, 0, 0) })
    if (!tab) throw new Error("no abrió")
    await order(tab.id, [{ qtyMilli: 3000 }, { qtyMilli: 1000, note: "para llevar" }])
    const [tres, uno] = pendingOf(await detail(tab.id))
    if (!tres || !uno) throw new Error("no pidió")

    // Uno paga una de las tres.
    const first = await charge(tab.id, [{ lineId: tres.id, qtyMilli: 1000 }])
    expect(first.status).toBe(201)
    const sale = (await first.json()) as { id: string; number: string }
    let t = await detail(tab.id)
    expect(t.status).toBe("open")
    expect(t.pendingQtyMilli).toBe(3000)
    expect(t.lines.filter((l) => l.documentId).map((l) => [l.qtyMilli, l.documentNumber])).toEqual([
      [1000, sale.number],
    ])

    // La venta tiene que ser lo mismo que lo que se toma de la cuenta.
    const wrong = await charge(tab.id, [{ lineId: tres.id, qtyMilli: 2000 }], {
      lines: [{ variantId: "v1", qtyMilli: 1000, unitPriceMinor: 150 }],
    })
    expect(wrong.status).toBe(409)
    expect(await errorCode(wrong)).toBe("TAB_CHANGED")
    // Lo ya cobrado no se cobra dos veces.
    const twice = await charge(tab.id, [
      { lineId: t.lines.find((l) => l.documentId)?.id ?? "", qtyMilli: 1000 },
    ])
    expect(twice.status).toBe(409)

    // El resto: la cuenta queda cerrada.
    const rest = pendingOf(t).map((l) => ({ lineId: l.id, qtyMilli: l.qtyMilli }))
    expect((await charge(tab.id, rest)).status).toBe(201)
    t = await detail(tab.id)
    expect(t.status).toBe("closed")
    expect(t.pendingQtyMilli).toBe(0)
    expect((await charge(tab.id, rest)).status).toBe(409)
    // Y la mesa vuelve a estar libre.
    const plano = (await (await h.call("/api/dining", { cookie: ctx.owner })).json()) as DiningFloor
    expect(plano.areas[0]?.tables[0]?.tab).toBeNull()
    checkInvariants(h.db)
  })

  test("el mesonero pide pero no cobra; anular una cuenta con algo pide permiso", async () => {
    const f = await floor()
    const luis = await waiterCookie()
    const { tab } = await open({ tableId: tableId(f, 0, 0) }, luis)
    if (!tab) throw new Error("no abrió")
    await order(tab.id, [{}], luis)
    const [line] = pendingOf(await detail(tab.id))
    if (!line) throw new Error("no pidió")
    const sale = await h.call("/api/documents", {
      cookie: luis,
      body: saleBody(ctx.terminalId, ctx.methodUsd, {
        lines: [{ variantId: "v1", qtyMilli: 1000, unitPriceMinor: 150 }],
        payments: [
          { id: uuidv7(), paymentMethodId: ctx.methodUsd, currency: "USD", amountMinor: 150 },
        ],
        tab: { id: tab.id, lines: [{ lineId: line.id, qtyMilli: 1000 }] },
      }),
    })
    expect(sale.status).toBe(403)

    const cancel = (cookie: string) =>
      h.call(`/api/tabs/${tab.id}/cancel`, { cookie, body: { reason: "Se fueron" } })
    expect((await cancel(luis)).status).toBe(403)
    const res = await cancel(ctx.owner)
    expect(res.status).toBe(200)
    expect((await res.json()) as TabDetail).toMatchObject({
      status: "cancelled",
      cancelReason: "Se fueron",
      lines: [{ voidReason: "Se fueron" }],
    })

    // Una cuenta vacía la cierra cualquiera que atienda.
    const empty = (await open({ tableId: tableId(f, 0, 1) }, luis)).tab
    const closed = await h.call(`/api/tabs/${empty?.id}/cancel`, { cookie: luis, body: {} })
    expect(closed.status).toBe(200)
    expect(((await closed.json()) as TabDetail).status).toBe("cancelled")
    expect((await order(empty?.id ?? "", [{}], luis)).status).toBe(409)
  })
})
