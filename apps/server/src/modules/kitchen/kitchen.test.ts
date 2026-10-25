import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type {
  CatalogItem,
  KitchenStation,
  KitchenTicket,
  ModifierGroup,
  TabDetail,
} from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"
import { printPending } from "./service"

/** Impresora de red falsa: guarda lo que le llega por el puerto. */
function fakePrinter() {
  const jobs: Uint8Array[] = []
  let current: number[] = []
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(_s, chunk) {
        current.push(...chunk)
      },
      close() {
        jobs.push(Uint8Array.from(current))
        current = []
      },
    },
  })
  return { port: server.port, jobs, stop: () => server.stop(true) }
}

const text = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes)

let h: Harness
let ctx: Awaited<ReturnType<typeof setUp>>
let printer: ReturnType<typeof fakePrinter>
beforeEach(async () => {
  h = harness()
  ctx = await setUp(h)
  printer = fakePrinter()
})
afterEach(() => printer.stop())

async function json<T>(res: Response, status = 200): Promise<T> {
  if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

/**
 * Cocina (todo lo que no va a otra estación, con impresora de red) y barra (las bebidas, solo en
 * pantalla). Hamburguesa sin categoría y jugo en «Bebidas».
 */
async function restaurant() {
  await h.call("/api/settings/features", {
    method: "PUT",
    cookie: ctx.owner,
    body: { kitchen: true, tables: true, modifiers: true },
  })
  const bebidas = await json<{ id: string }>(
    await h.call("/api/categories", { cookie: ctx.owner, body: { name: "Bebidas" } }),
    201,
  )
  const cocina = await json<KitchenStation>(
    await h.call("/api/kitchen/stations", {
      cookie: ctx.owner,
      body: {
        name: "Cocina",
        categoryIds: null,
        printer: {
          mode: "network",
          host: "127.0.0.1",
          port: printer.port,
          share: null,
          device: null,
          paperWidth: 80,
        },
      },
    }),
    201,
  )
  const barra = await json<KitchenStation>(
    await h.call("/api/kitchen/stations", {
      cookie: ctx.owner,
      body: { name: "Barra", categoryIds: [bebidas.id], printer: null, targetMinutes: 5 },
    }),
    201,
  )
  const extras = await json<ModifierGroup>(
    await h.call("/api/modifier-groups", {
      cookie: ctx.owner,
      body: {
        name: "Extras",
        modifiers: [{ name: "Queso", priceMinor: 100, priceCurrency: "USD" }],
      },
    }),
    201,
  )
  const burger = await json<CatalogItem>(
    await h.call("/api/products", {
      cookie: ctx.owner,
      body: {
        name: "Hamburguesa",
        kind: "service",
        priceMinor: 500,
        priceCurrency: "USD",
        modifierGroupIds: [extras.id],
      },
    }),
    201,
  )
  const juice = await json<CatalogItem>(
    await h.call("/api/products", {
      cookie: ctx.owner,
      body: {
        name: "Jugo",
        kind: "service",
        priceMinor: 150,
        priceCurrency: "USD",
        categoryId: bebidas.id,
      },
    }),
    201,
  )
  const queso = extras.modifiers[0]?.id ?? ""
  return { cocina, barra, burger, juice, queso }
}

const tickets = async (stationId?: string, status = "pending") =>
  json<KitchenTicket[]>(
    await h.call(
      `/api/kitchen/tickets?status=${status}${stationId ? `&stationId=${stationId}` : ""}`,
      {
        cookie: ctx.owner,
      },
    ),
  )

async function openTab(label: string) {
  return json<TabDetail>(
    await h.call("/api/tabs", { cookie: ctx.owner, body: { id: uuidv7(), label } }),
    201,
  )
}

describe("comandas a cocina", () => {
  test("cada estación recibe lo suyo, con opciones e indicaciones; la impresora la imprime", async () => {
    const r = await restaurant()
    const tab = await openTab("Juan")
    await json<TabDetail>(
      await h.call(`/api/tabs/${tab.id}/lines`, {
        cookie: ctx.owner,
        body: {
          lines: [
            {
              id: uuidv7(),
              variantId: r.burger.variantId,
              qtyMilli: 2000,
              modifierIds: [r.queso],
              note: "sin cebolla",
            },
            { id: uuidv7(), variantId: r.juice.variantId, qtyMilli: 1000 },
          ],
        },
      }),
    )
    const all = await tickets()
    expect(all.map((t) => [t.stationName, t.number, t.source, t.lines.map((l) => l.name)])).toEqual(
      [
        ["Cocina", 1, "Juan", ["Hamburguesa"]],
        ["Barra", 2, "Juan", ["Jugo"]],
      ],
    )
    expect(all[0]?.lines[0]).toMatchObject({
      qtyMilli: 2000,
      note: "sin cebolla",
      modifiers: [{ name: "Queso" }],
    })
    expect(all[0]?.createdBy).toBe("Dueña")
    // La cuenta sabe qué está en la cocina.
    const detail = await json<TabDetail>(await h.call(`/api/tabs/${tab.id}`, { cookie: ctx.owner }))
    expect(detail.lines.map((l) => l.kitchen)).toEqual(["pending", "pending"])

    // Se imprime en la cocina (la barra no tiene impresora).
    await printPending(h.db, Date.now())
    await Bun.sleep(50)
    expect(printer.jobs).toHaveLength(1)
    const job = text(printer.jobs[0] ?? new Uint8Array())
    expect(job).toContain("JUAN")
    // El «×» sale en la página de códigos de la impresora (PC850), no en latin1.
    expect(job).toMatch(/2 . Hamburguesa/)
    expect(job).toContain("+ Queso")
    // No se vuelve a imprimir.
    await printPending(h.db, Date.now())
    await Bun.sleep(50)
    expect(printer.jobs).toHaveLength(1)

    // La cocina la marca lista; se puede deshacer.
    const ticket = all[0]
    if (!ticket) throw new Error("sin comanda")
    const ready = await json<KitchenTicket>(
      await h.call(`/api/kitchen/tickets/${ticket.id}/ready`, { cookie: ctx.owner, body: {} }),
    )
    expect(ready.status).toBe("ready")
    expect((await tickets(r.cocina.id)).length).toBe(0)
    expect((await tickets(r.cocina.id, "ready")).map((t) => t.id)).toEqual([ticket.id])
    const after = await json<TabDetail>(await h.call(`/api/tabs/${tab.id}`, { cookie: ctx.owner }))
    expect(after.lines.map((l) => l.kitchen)).toEqual(["ready", "pending"])
    await h.call(`/api/kitchen/tickets/${ticket.id}/unready`, { cookie: ctx.owner, body: {} })
    expect((await tickets(r.cocina.id)).length).toBe(1)
  })

  test("anular lo pedido le avisa a la cocina", async () => {
    const r = await restaurant()
    const tab = await openTab("Ana")
    const ordered = await json<TabDetail>(
      await h.call(`/api/tabs/${tab.id}/lines`, {
        cookie: ctx.owner,
        body: { lines: [{ id: uuidv7(), variantId: r.burger.variantId, qtyMilli: 2000 }] },
      }),
    )
    const line = ordered.lines[0]
    if (!line) throw new Error("no pidió")
    await json<TabDetail>(
      await h.call(`/api/tabs/${tab.id}/lines/${line.id}/void`, {
        cookie: ctx.owner,
        body: { qtyMilli: 1000, reason: "No la quiso" },
      }),
    )
    const cocina = await tickets(r.cocina.id)
    expect(cocina.map((t) => [t.kind, t.lines[0]?.qtyMilli, t.lines[0]?.note])).toEqual([
      ["order", 2000, null],
      ["void", 1000, "No la quiso"],
    ])
    await printPending(h.db, Date.now())
    await Bun.sleep(50)
    expect(text(printer.jobs[1] ?? new Uint8Array())).toContain("*** ANULAR ***")
  })

  test("lo vendido en la caja va a las estaciones que lo reciben", async () => {
    const r = await restaurant()
    const sell = () =>
      h.call("/api/documents", {
        cookie: ctx.owner,
        body: saleBody(ctx.terminalId, ctx.methodUsd, {
          lines: [
            {
              variantId: r.burger.variantId,
              qtyMilli: 1000,
              unitPriceMinor: 600,
              modifierIds: [r.queso],
            },
            { variantId: r.juice.variantId, qtyMilli: 1000, unitPriceMinor: 150 },
          ],
          payments: [
            { id: uuidv7(), paymentMethodId: ctx.methodUsd, currency: "USD", amountMinor: 750 },
          ],
        }),
      })
    const sale = await json<{ number: string }>(await sell(), 201)
    expect((await tickets()).map((t) => [t.stationName, t.source])).toEqual([
      ["Cocina", `Venta ${sale.number}`],
      ["Barra", `Venta ${sale.number}`],
    ])
    // La barra deja de recibir lo de la caja.
    await h.call(`/api/kitchen/stations/${r.barra.id}`, {
      method: "PUT",
      cookie: ctx.owner,
      body: { name: "Barra", categoryIds: r.barra.categoryIds, printer: null, counterSales: false },
    })
    await json(await sell(), 201)
    expect((await tickets(r.barra.id)).length).toBe(1)
    expect((await tickets(r.cocina.id)).length).toBe(2)
    // Apagada la función, no hay comandas.
    await h.call("/api/settings/features", {
      method: "PUT",
      cookie: ctx.owner,
      body: { kitchen: false },
    })
    await json(await sell(), 201)
    expect((await tickets()).length).toBe(3)
  })

  test("si la impresora no responde queda el aviso y se reimprime", async () => {
    const r = await restaurant()
    printer.stop()
    const tab = await openTab("Luis")
    await h.call(`/api/tabs/${tab.id}/lines`, {
      cookie: ctx.owner,
      body: { lines: [{ id: uuidv7(), variantId: r.burger.variantId, qtyMilli: 1000 }] },
    })
    await printPending(h.db, Date.now())
    const [failed] = await tickets(r.cocina.id)
    expect(failed?.printError).toBeTruthy()
    printer = fakePrinter()
    await h.call(`/api/kitchen/stations/${r.cocina.id}`, {
      method: "PUT",
      cookie: ctx.owner,
      body: {
        name: "Cocina",
        categoryIds: null,
        printer: {
          mode: "network",
          host: "127.0.0.1",
          port: printer.port,
          share: null,
          device: null,
          paperWidth: 58,
        },
      },
    })
    const again = await json<KitchenTicket>(
      await h.call(`/api/kitchen/tickets/${failed?.id}/reprint`, { cookie: ctx.owner, body: {} }),
    )
    expect(again.printError).toBeNull()
    expect(again.printedAt).not.toBeNull()
    await Bun.sleep(50)
    expect(printer.jobs).toHaveLength(1)
  })

  test("la cocina ve y marca; no configura", async () => {
    const r = await restaurant()
    await h.call("/api/users", {
      cookie: ctx.owner,
      body: { name: "Rosa", username: "rosa", password: "otra-clave-1", roleId: "kitchen" },
    })
    const rosa = await h.login("rosa", "otra-clave-1")
    const tab = await openTab("Mesa de prueba")
    await h.call(`/api/tabs/${tab.id}/lines`, {
      cookie: ctx.owner,
      body: { lines: [{ id: uuidv7(), variantId: r.juice.variantId, qtyMilli: 1000 }] },
    })
    const list = await json<KitchenTicket[]>(await h.call("/api/kitchen/tickets", { cookie: rosa }))
    expect(list).toHaveLength(1)
    const ready = await h.call(`/api/kitchen/tickets/${list[0]?.id}/ready`, {
      cookie: rosa,
      body: {},
    })
    expect(ready.status).toBe(200)
    const station = await h.call("/api/kitchen/stations", {
      cookie: rosa,
      body: { name: "Parrilla", categoryIds: null, printer: null },
    })
    expect(station.status).toBe(403)
    expect((await h.call("/api/tabs", { cookie: rosa })).status).toBe(403)
  })
})
