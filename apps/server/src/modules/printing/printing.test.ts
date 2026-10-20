import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Bootstrap, PrinterSettings } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"

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
const DRAWER = [0x1b, 0x70, 0, 25, 250]
const hasDrawer = (bytes: Uint8Array) =>
  [...bytes].some((_, i) => DRAWER.every((b, j) => bytes[i + j] === b))

let h: Harness
let printer: ReturnType<typeof fakePrinter>
beforeEach(() => {
  h = harness()
  printer = fakePrinter()
})
afterEach(() => printer.stop())

async function configure(cookie: string, patch: Partial<PrinterSettings>) {
  const res = await h.call("/api/settings/printer", { method: "PUT", cookie, body: patch })
  expect(res.status).toBe(200)
  return (await res.json()) as PrinterSettings
}

describe("impresora térmica de red", () => {
  test("por defecto imprime el navegador; la caja ve el modo en bootstrap", async () => {
    const { owner } = await setUp(h)
    const boot = (await (await h.call("/api/bootstrap", { cookie: owner })).json()) as Bootstrap
    expect(boot.printer).toEqual({
      mode: "browser",
      paperWidth: 80,
      autoPrint: false,
      openDrawer: false,
    })
    const res = await h.call("/api/print/test", { cookie: owner, body: {} })
    expect(res.status).toBe(409)
  })

  test("página de prueba con la configuración del formulario, sin guardarla", async () => {
    const { owner } = await setUp(h)
    const res = await h.call("/api/print/test", {
      cookie: owner,
      body: { mode: "network", host: "127.0.0.1", port: printer.port, paperWidth: 58 },
    })
    expect(res.status).toBe(200)
    await Bun.sleep(50)
    expect(printer.jobs).toHaveLength(1)
    expect(text(printer.jobs[0] ?? new Uint8Array())).toContain("Papel de 58 mm")
    expect(
      ((await (await h.call("/api/settings/printer", { cookie: owner })).json()) as PrinterSettings)
        .mode,
    ).toBe("browser")
  })

  test("recibo de una venta en efectivo: abre la gaveta solo si se pide y está activado", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    await configure(owner, {
      mode: "network",
      host: "127.0.0.1",
      port: printer.port,
      openDrawer: true,
    })
    const sale = (await (
      await h.call("/api/documents", { cookie: owner, body: saleBody(terminalId, methodUsd) })
    ).json()) as { id: string; number: string }

    const first = await h.call(`/api/print/documents/${sale.id}`, {
      cookie: owner,
      body: { openDrawer: true },
    })
    expect(await first.json()).toEqual({ ok: true, drawerOpened: true })
    // Reimpresión desde el historial: sin gaveta.
    const reprint = await h.call(`/api/print/documents/${sale.id}`, { cookie: owner, body: {} })
    expect(await reprint.json()).toEqual({ ok: true, drawerOpened: false })
    await Bun.sleep(50)
    expect(printer.jobs).toHaveLength(2)
    expect(hasDrawer(printer.jobs[0] ?? new Uint8Array())).toBe(true)
    expect(hasDrawer(printer.jobs[1] ?? new Uint8Array())).toBe(false)
    expect(text(printer.jobs[0] ?? new Uint8Array())).toContain(sale.number)

    const drawer = await h.call("/api/print/drawer", { cookie: owner, body: {} })
    expect(drawer.status).toBe(200)
  })

  test("errores claros: falta la IP, la impresora no contesta, documento ajeno", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    const missing = await h.call("/api/settings/printer", {
      method: "PUT",
      cookie: owner,
      body: { mode: "network", host: null },
    })
    expect(missing.status).toBe(422)
    const badDevice = await h.call("/api/settings/printer", {
      method: "PUT",
      cookie: owner,
      body: { mode: "device", device: "/etc/passwd" },
    })
    expect(badDevice.status).toBe(422)

    printer.stop()
    await configure(owner, { mode: "network", host: "127.0.0.1", port: printer.port })
    const sale = (await (
      await h.call("/api/documents", { cookie: owner, body: saleBody(terminalId, methodUsd) })
    ).json()) as { id: string }
    const down = await h.call(`/api/print/documents/${sale.id}`, { cookie: owner, body: {} })
    expect(down.status).toBe(502)

    expect(
      (await h.call(`/api/print/documents/${uuidv7()}`, { cookie: owner, body: {} })).status,
    ).toBe(404)
  })
})
