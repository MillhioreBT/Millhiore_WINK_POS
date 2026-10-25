import { beforeEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { PluginInfo, PluginLog } from "@millhiore/contracts"
import { auditLog, pluginEvent, pluginKv } from "@millhiore/db"
import { strToU8, zipSync } from "fflate"
import { drainOutbox } from "../../events/outbox"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"
import { readArchive } from "./archive"

const EXAMPLE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "examples",
  "plugins",
  "ventas-del-dia",
)

/** El plugin de ejemplo, comprimido como lo haría quien lo publica. */
function exampleZip(): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  for (const name of readdirSync(EXAMPLE)) files[name] = readFileSync(join(EXAMPLE, name))
  return zipSync(files)
}

const manifest = (over: Record<string, unknown> = {}) => ({
  id: "prueba",
  name: "Prueba",
  version: "1.0.0",
  permissions: ["inventory.view"],
  events: ["sale.posted"],
  network: [],
  server: "server.js",
  ...over,
})

function pluginZip(
  code: string,
  over: Record<string, unknown> = {},
  extra: Record<string, string> = {},
) {
  return zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest(over))),
    "server.js": strToU8(code),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)])),
  })
}

let h: Harness
let s: Awaited<ReturnType<typeof setUp>>
beforeEach(async () => {
  h = harness({
    plugins: {
      // Internet de mentira: solo responde a api.ejemplo.com.
      fetcher: (async (url: URL | string) =>
        String(url).startsWith("https://api.ejemplo.com/")
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response("no", { status: 500 })) as unknown as typeof fetch,
      limits: { memory: 8 * 1024 * 1024, cpuMs: 300, callMs: 3_000 },
    },
  })
  s = await setUp(h)
})

const install = async (zip: Uint8Array, cookie = s.owner) =>
  h.call("/api/plugins", {
    method: "POST",
    cookie,
    raw: zip,
    headers: { "content-type": "application/zip" },
  })

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error

const logs = async (id: string) =>
  (await (await h.call(`/api/plugins/${id}/logs`, { cookie: s.owner })).json()) as PluginLog[]

/** Una venta, repartida a los plugins y entregada. */
async function sellAndDeliver() {
  const res = await h.call("/api/documents", {
    cookie: s.owner,
    body: saleBody(s.terminalId, s.methodUsd),
  })
  expect(res.status).toBe(201)
  drainOutbox(h.db, h.clock.now)
  return h.plugins?.deliver()
}

describe("paquete de un plugin", () => {
  test("valida el .zip, el manifiesto y lo que nombra", () => {
    const bad = (bytes: Uint8Array) => {
      try {
        readArchive(bytes)
        return "ok"
      } catch (e) {
        return (e as Error).message
      }
    }
    expect(bad(strToU8("no soy un zip"))).toMatch(/zip válido/)
    expect(bad(zipSync({ "leeme.txt": strToU8("hola") }))).toMatch(/Falta manifest.json/)
    expect(bad(pluginZip("", { id: "Con Espacios" }))).toMatch(/manifest.json: id/)
    expect(bad(pluginZip("", { permissions: ["user.manage"] }))).toMatch(/permissions/)
    expect(bad(pluginZip("", { server: "otro.js" }))).toMatch(/Falta otro.js/)
    expect(bad(pluginZip("", { network: ["http://x.com"] }))).toMatch(/network/)
    expect(
      bad(
        zipSync({
          "manifest.json": strToU8(JSON.stringify(manifest())),
          "server.js": strToU8(""),
          "../fuera.js": strToU8(""),
        }),
      ),
    ).toMatch(/Ruta inválida/)
    // Comprimido con su carpeta: también vale.
    const nested = zipSync({
      "mi-plugin/manifest.json": strToU8(JSON.stringify(manifest())),
      "mi-plugin/server.js": strToU8("// nada"),
    })
    expect(readArchive(nested).manifest.id).toBe("prueba")
    expect(readArchive(exampleZip()).manifest.page?.entry).toBe("index.html")
  })
})

describe("plugins", () => {
  test("se instala desde su .zip, recibe eventos, guarda lo suyo y responde en su ruta", async () => {
    const res = await install(exampleZip())
    expect(res.status).toBe(201)
    const info = (await res.json()) as PluginInfo
    expect(info).toMatchObject({
      id: "ventas-del-dia",
      version: "1.0.0",
      running: true,
      enabled: true,
      permissions: ["report.view"],
      page: { title: "Ventas del día", url: "/plugins/ventas-del-dia/index.html" },
      installedByName: "Dueña",
    })
    expect(await sellAndDeliver()).toBe(1)
    expect(h.db.select().from(pluginKv).all()).toEqual([
      expect.objectContaining({ pluginId: "ventas-del-dia", key: "ventas", value: 1 }),
    ])
    expect((await logs("ventas-del-dia")).map((l) => l.message)).toContain("Venta C1-000001")

    // Desde su pantalla: la app lo marca con la cabecera; sin ella, su ruta no existe para nadie.
    const route = (headers: Record<string, string>) =>
      h.call("/api/plugins/ventas-del-dia/run/resumen", { cookie: s.owner, headers })
    expect((await route({})).status).toBe(403)
    const ok = await route({ "x-millhiore-plugin": "ventas-del-dia" })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ desdeQueSeInstalo: 1, hoy: 1, moneda: "VES" })
    expect((await route({ "x-millhiore-plugin": "otro" })).status).toBe(403)
    // Sus tareas corren a su hora.
    h.clock.now += 61 * 60_000
    expect(await h.plugins?.runTasks()).toBe(1)
    expect((await logs("ventas-del-dia"))[0]?.message).toBe("Sigo contando")

    const actions = h.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .all()
      .map((r) => r.action)
    expect(actions).toContain("plugin.installed")
  })

  test("su código no ve archivos, ni la red, ni el proceso; su CPU y su memoria tienen tope", async () => {
    const res = await install(
      pluginZip(`
        millhiore.on("sale.posted", async () => {
          millhiore.log([typeof require, typeof process, typeof Bun, typeof fetch, typeof XMLHttpRequest, typeof globalThis.__dispatch].join(","))
          const mode = await millhiore.storage.get("modo")
          if (mode === "bucle") while (true) {}
          if (mode === "memoria") { const a = []; while (true) a.push(new Uint8Array(1000000)) }
        })
      `),
    )
    expect(res.status).toBe(201)
    await sellAndDeliver()
    expect((await logs("prueba")).map((l) => l.message)).toContain(
      "undefined,undefined,undefined,undefined,undefined,object",
    )
    // Un bucle sin fin se corta y el evento se reintenta más tarde.
    h.db
      .insert(pluginKv)
      .values({ pluginId: "prueba", key: "modo", value: "bucle", updatedAt: 0 })
      .run()
    await sellAndDeliver()
    const failed = h.db
      .select()
      .from(pluginEvent)
      .all()
      .find((e) => e.status === "pending")
    expect(failed?.attempts).toBe(1)
    expect(failed?.lastError).toMatch(/interrupted/)
    expect(failed?.nextAttemptAt).toBe(h.clock.now + 60_000)
    const list = (await (await h.call("/api/plugins", { cookie: s.owner })).json()) as PluginInfo[]
    expect(list[0]?.lastError).toMatch(/interrupted/)
    expect(list[0]?.pendingEvents).toBe(1)
    // Y uno que se come la memoria también.
    h.db.update(pluginKv).set({ value: "memoria" }).run()
    h.clock.now += 61_000
    await h.plugins?.deliver()
    expect(
      h.db
        .select()
        .from(pluginEvent)
        .all()
        .find((e) => e.status === "pending")?.lastError,
    ).toMatch(/out of memory/)
  })

  test("la API solo con lo que pidió (y lo que tiene quien lo instaló); internet solo a lo declarado", async () => {
    await install(
      pluginZip(
        `
        millhiore.route("GET", "/probar", async () => {
          const out = {}
          for (const [k, p] of [["productos", "/api/products"], ["informe", "/api/reports/day"], ["usuarios", "/api/users"], ["plugins", "/api/plugins"], ["yo", "/api/me"]]) {
            out[k] = (await millhiore.api("GET", p)).status
          }
          const tryFetch = async (url) => { try { return (await millhiore.fetch(url)).status } catch (e) { return e.message } }
          out.declarado = await tryFetch("https://api.ejemplo.com/hola")
          out.otro = await tryFetch("https://otro.com/hola")
          out.http = await tryFetch("http://api.ejemplo.com/hola")
          return { body: out }
        })
      `,
        { network: ["api.ejemplo.com"], events: [] },
      ),
    )
    const res = await h.call("/api/plugins/prueba/run/probar", {
      cookie: s.owner,
      headers: { "x-millhiore-plugin": "prueba" },
    })
    expect(await res.json()).toEqual({
      productos: 200,
      informe: 403,
      usuarios: 403,
      plugins: 403,
      yo: 403,
      declarado: 200,
      otro: "otro.com no está entre los equipos que el plugin declaró",
      http: "Solo se llama por HTTPS",
    })
  })

  test("su pantalla, por la app, tiene lo que el plugin pide y la persona tiene", async () => {
    await install(exampleZip())
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    const bridged = (cookie: string, path: string) =>
      h.call(path, { cookie, headers: { "x-millhiore-plugin": "ventas-del-dia" } })
    // El dueño, por la pantalla del plugin, llega a los informes (lo pide el plugin) pero no a
    // la bitácora (no la pide).
    expect((await bridged(s.owner, "/api/reports/day")).status).toBe(200)
    expect((await bridged(s.owner, "/api/audit")).status).toBe(403)
    expect((await bridged(s.owner, "/api/me")).status).toBe(403)
    // El cajero no tiene informes: tampoco por el plugin. Y no ve su pantalla en el menú.
    expect((await bridged(cashier, "/api/reports/day")).status).toBe(403)
    const pages = (await (
      await h.call("/api/plugins/pages", { cookie: cashier })
    ).json()) as unknown[]
    expect(pages).toEqual([])
    expect(await (await h.call("/api/plugins/pages", { cookie: s.owner })).json()).toEqual([
      { id: "ventas-del-dia", title: "Ventas del día", url: "/plugins/ventas-del-dia/index.html" },
    ])
    // Instalar exige settings.manage.
    expect((await install(exampleZip(), cashier)).status).toBe(403)
  })

  test("sus archivos se sirven aislados; apagado no corre ni recibe, y al encenderlo se pone al día", async () => {
    await install(exampleZip())
    const page = await h.call("/plugins/ventas-del-dia/index.html")
    expect(page.status).toBe(200)
    expect(page.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts allow-forms",
    )
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'none'")
    expect((await h.call("/plugins/sdk.js")).headers.get("content-type")).toContain("javascript")
    expect((await h.call("/plugins/ventas-del-dia/manifest.json")).status).toBe(200)
    expect((await h.call("/plugins/ventas-del-dia/no-existe.js")).status).toBe(404)
    expect((await h.call("/plugins/ventas-del-dia/..%2Fsecreto")).status).toBe(404)

    const off = await h.call("/api/plugins/ventas-del-dia", {
      method: "PATCH",
      cookie: s.owner,
      body: { enabled: false },
    })
    expect(((await off.json()) as PluginInfo).running).toBe(false)
    expect((await h.call("/plugins/ventas-del-dia/index.html")).status).toBe(404)
    // Apagado no recibe lo que pasa mientras tanto.
    await sellAndDeliver()
    expect(h.db.select().from(pluginEvent).all()).toHaveLength(0)
    await h.call("/api/plugins/ventas-del-dia", {
      method: "PATCH",
      cookie: s.owner,
      body: { enabled: true },
    })
    expect(await sellAndDeliver()).toBe(1)
  })

  test("se actualiza con un .zip nuevo y se desinstala con lo que guardó", async () => {
    await install(
      pluginZip("millhiore.on('sale.posted', async () => { await millhiore.storage.set('x', 1) })"),
    )
    await sellAndDeliver()
    const upd = await install(pluginZip("// nada", { version: "1.1.0" }))
    expect(((await upd.json()) as PluginInfo).version).toBe("1.1.0")
    const del = await h.call("/api/plugins/prueba", { method: "DELETE", cookie: s.owner })
    expect(del.status).toBe(204)
    expect(h.db.select().from(pluginKv).all()).toEqual([])
    expect(await (await h.call("/api/plugins", { cookie: s.owner })).json()).toEqual([])
    const actions = h.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .all()
      .map((r) => r.action)
    expect(actions).toEqual(
      expect.arrayContaining(["plugin.installed", "plugin.updated", "plugin.removed"]),
    )
    // Un plugin roto al cargar queda con su error, sin tumbar nada.
    const broken = await install(pluginZip("esto no es javascript ("))
    const info = (await broken.json()) as PluginInfo
    expect(info.running).toBe(false)
    expect(info.lastError).toMatch(/No arrancó: SyntaxError/)
    const err = await install(strToU8("x"))
    expect((await errorCode(err)).code).toBe("INVALID_PLUGIN")
  })
})
