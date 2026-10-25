import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  type PluginInfo,
  pluginLogSchema,
  pluginPageSchema,
  pluginSchema,
} from "@millhiore/contracts"
import { type Db, plugin } from "@millhiore/db"
import { asc, eq } from "drizzle-orm"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { forbidden, HttpError } from "../../http/errors"
import { contentType, MAX_ARCHIVE_BYTES } from "./archive"
import { PLUGIN_SDK } from "./sdk"
import { installPlugin, listPlugins, setPluginEnabled, uninstallPlugin } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })
const idParam = z.object({ id: z.string().min(1).max(40) })
const zip = { schema: { type: "string" as const, format: "binary" } }

/**
 * Lo que puede hacer la pantalla de un plugin: correr scripts y formularios en su marco, nada
 * más (sin la sesión de la app, sin hablar con ningún servidor salvo por la app, sin navegar).
 */
export const PLUGIN_PAGE_CSP = [
  "sandbox allow-scripts allow-forms",
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ")

const listRoute = createRoute({
  method: "get",
  path: "/api/plugins",
  tags: ["Plugins"],
  summary: "Los plugins instalados",
  responses: {
    200: { description: "Plugins", content: json(z.array(pluginSchema)) },
    403: { description: "Falta settings.manage", ...err },
  },
})

const installRoute = createRoute({
  method: "post",
  path: "/api/plugins",
  tags: ["Plugins"],
  summary: "Instala (o actualiza) un plugin desde su .zip",
  request: { body: { content: { "application/zip": zip, "application/octet-stream": zip } } },
  responses: {
    201: { description: "Instalado", content: json(pluginSchema) },
    403: { description: "Falta settings.manage", ...err },
    413: { description: "Pesa más de 5 MB", ...err },
    422: { description: "No es un plugin válido", ...err },
  },
})

const updateRoute = createRoute({
  method: "patch",
  path: "/api/plugins/{id}",
  tags: ["Plugins"],
  summary: "Enciende o apaga un plugin",
  request: {
    params: idParam,
    body: { content: json(z.object({ enabled: z.boolean() })), required: true },
  },
  responses: {
    200: { description: "Guardado", content: json(pluginSchema) },
    403: { description: "Falta settings.manage", ...err },
    404: { description: "No existe", ...err },
  },
})

const deleteRoute = createRoute({
  method: "delete",
  path: "/api/plugins/{id}",
  tags: ["Plugins"],
  summary: "Desinstala un plugin, con lo que guardó",
  request: { params: idParam },
  responses: {
    204: { description: "Desinstalado" },
    403: { description: "Falta settings.manage", ...err },
    404: { description: "No existe", ...err },
  },
})

const logsRoute = createRoute({
  method: "get",
  path: "/api/plugins/{id}/logs",
  tags: ["Plugins"],
  summary: "Lo último que registró el plugin (de lo más nuevo a lo más viejo)",
  request: { params: idParam },
  responses: {
    200: { description: "Registro", content: json(z.array(pluginLogSchema)) },
    403: { description: "Falta settings.manage", ...err },
  },
})

const pagesRoute = createRoute({
  method: "get",
  path: "/api/plugins/pages",
  tags: ["Plugins"],
  summary: "Las pantallas de plugins que puede usar quien consulta",
  responses: { 200: { description: "Pantallas", content: json(z.array(pluginPageSchema)) } },
})

/** Las pantallas de los plugins encendidos para alguien: si tiene alguno de sus permisos. */
function pagesFor(db: Pick<Db, "select">, permissions: ReadonlySet<string>) {
  return db
    .select({ id: plugin.id, manifest: plugin.manifest })
    .from(plugin)
    .where(eq(plugin.enabled, true))
    .orderBy(asc(plugin.name))
    .all()
    .filter(
      (p) =>
        p.manifest.page &&
        (permissions.has("settings.manage") ||
          p.manifest.permissions.length === 0 ||
          p.manifest.permissions.some((x) => permissions.has(x))),
    )
    .map((p) => ({
      id: p.id,
      title: p.manifest.page?.title ?? p.manifest.name,
      url: `/plugins/${p.id}/${p.manifest.page?.entry ?? ""}`,
    }))
}

export function registerPluginRoutes(app: App, deps: AppDeps): void {
  const manager = deps.plugins
  const info = (id: string): PluginInfo => {
    const found = listPlugins(deps.db, (x) => manager?.isRunning(x) ?? false).find(
      (p) => p.id === id,
    )
    if (!found) throw new HttpError(404, "NOT_FOUND", `No existe el plugin ${id}`)
    return found
  }

  app.openapi(listRoute, (c) => {
    requirePermission(c, "settings.manage")
    return c.json(
      listPlugins(deps.db, (id) => manager?.isRunning(id) ?? false),
      200,
    )
  })

  app.openapi(pagesRoute, (c) => c.json(pagesFor(deps.db, actorOf(c).permissions), 200))

  app.openapi(installRoute, async (c) => {
    const actor = requirePermission(c, "settings.manage")
    if (Number(c.req.header("content-length") ?? 0) > MAX_ARCHIVE_BYTES) {
      throw new HttpError(413, "PLUGIN_TOO_LARGE", "El plugin pesa más de 5 MB")
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const { row } = installPlugin(deps.db, bytes, actor.userId, deps.now())
    await manager?.reload(row.id)
    return c.json(info(row.id), 201)
  })

  app.openapi(updateRoute, async (c) => {
    const actor = requirePermission(c, "settings.manage")
    const { id } = c.req.valid("param")
    setPluginEnabled(deps.db, id, c.req.valid("json").enabled, actor.userId, deps.now())
    await manager?.reload(id)
    return c.json(info(id), 200)
  })

  app.openapi(deleteRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    const { id } = c.req.valid("param")
    manager?.unload(id)
    uninstallPlugin(deps.db, id, actor.userId, deps.now())
    return c.body(null, 204)
  })

  app.openapi(logsRoute, (c) => {
    requirePermission(c, "settings.manage")
    return c.json(manager?.logs(c.req.valid("param").id) ?? [], 200)
  })

  // Las rutas propias del plugin (`millhiore.route`): solo desde su pantalla o su código.
  app.all("/api/plugins/:id/run/*", async (c) => {
    const actor = actorOf(c)
    const id = c.req.param("id")
    if (actor.pluginId !== id) throw forbidden("plugin")
    const path = c.req.path.slice(`/api/plugins/${id}/run`.length) || "/"
    const method = c.req.method.toUpperCase()
    let body: unknown = null
    if (method !== "GET" && method !== "HEAD") body = await c.req.json().catch(() => null)
    const res = await manager?.route(id, method, path, {
      method,
      path,
      query: Object.fromEntries(new URL(c.req.url).searchParams),
      body,
      user: { id: actor.userId, name: actor.name, permissions: [...actor.permissions] },
    })
    if (!res) throw new HttpError(404, "NOT_FOUND", `El plugin no tiene ${method} ${path}`)
    return c.json(res.body as never, res.status as 200)
  })
}

/** Los archivos de las pantallas de los plugins y su SDK (fuera de /api: el marco no lleva sesión). */
export function registerPluginFiles(app: App, deps: AppDeps): void {
  app.get(
    "/plugins/sdk.js",
    () =>
      new Response(PLUGIN_SDK, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
        },
      }),
  )
  app.get("/plugins/:id/*", (c) => {
    const id = c.req.param("id")
    let path: string
    try {
      path = decodeURIComponent(c.req.path.slice(`/plugins/${id}/`.length))
    } catch {
      return c.text("No existe", 404)
    }
    const type = contentType(path)
    const file = type ? deps.plugins?.file(id, path) : null
    if (!file || !type) return c.text("No existe", 404)
    return new Response(new Uint8Array(file), {
      headers: {
        "content-type": type,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "content-security-policy": PLUGIN_PAGE_CSP,
        "referrer-policy": "no-referrer",
      },
    })
  })
}
