import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  publicCatalogSchema,
  type StorefrontStatus,
  serveResultSchema,
  storefrontStatusSchema,
  updateStorefrontSchema,
} from "@millhiore/contracts"
import { auditLog } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { clientKey, RateLimiter } from "../../http/rateLimit"
import { imageResponse } from "../catalog/images"
import { reachable } from "../network/routes"
import { registerPublicOrderRoutes } from "../orders/routes"
import { disableFunnel, enableFunnel, funnelUrl, tailscaleStatus } from "../remote/tailscale"
import {
  publicCatalog,
  publicImage,
  requireStorefront,
  storefrontCounts,
  storefrontSettings,
  updateStorefrontSettings,
} from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const statusRoute = createRoute({
  method: "get",
  path: "/api/storefront",
  tags: ["Catálogo en línea"],
  summary: "Cómo se ve el catálogo en línea, por dónde se abre y si está publicado",
  responses: {
    200: { description: "Estado", content: json(storefrontStatusSchema) },
    403: { description: "Falta settings.manage", ...err },
  },
})

const updateRoute = createRoute({
  method: "put",
  path: "/api/storefront",
  tags: ["Catálogo en línea"],
  summary: "Cambia cómo se ve el catálogo en línea",
  request: { body: { content: json(updateStorefrontSchema), required: true } },
  responses: {
    200: { description: "Guardado", content: json(storefrontStatusSchema) },
    403: { description: "Falta settings.manage", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const publishRoute = createRoute({
  method: "post",
  path: "/api/storefront/publish",
  tags: ["Catálogo en línea"],
  summary: "Publica en internet solo el catálogo, con Tailscale Funnel",
  responses: {
    200: { description: "Resultado", content: json(serveResultSchema) },
    403: { description: "Falta settings.manage", ...err },
    409: { description: "El catálogo está apagado", ...err },
  },
})

const unpublishRoute = createRoute({
  method: "post",
  path: "/api/storefront/unpublish",
  tags: ["Catálogo en línea"],
  summary: "Deja de publicar el catálogo en internet",
  responses: {
    200: { description: "Resultado", content: json(serveResultSchema) },
    403: { description: "Falta settings.manage", ...err },
  },
})

const publicRoute = createRoute({
  method: "get",
  path: "/api/public/catalog",
  tags: ["Catálogo en línea"],
  summary: "El catálogo para el público (sin sesión)",
  description:
    "Productos que salen en el catálogo con su foto, su descripción y su precio para el público (con el IVA), en las dos monedas a la tasa del día, y si hay o no. Nunca costos, códigos ni cantidades.",
  security: [],
  responses: {
    200: { description: "Catálogo", content: json(publicCatalogSchema) },
    404: { description: "El catálogo está apagado", ...err },
    429: { description: "Demasiadas consultas", ...err },
  },
})

const publicImageRoute = createRoute({
  method: "get",
  path: "/api/public/catalog/images/{id}",
  tags: ["Catálogo en línea"],
  summary: "La foto de un producto del catálogo (sin sesión)",
  security: [],
  request: {
    params: z.object({ id: z.string().min(1).max(64) }),
    query: z.object({ v: z.string().max(20).optional() }),
  },
  responses: {
    200: { description: "Foto", content: { "image/jpeg": { schema: {} } } },
    404: { description: "No existe o no sale en el catálogo", ...err },
    429: { description: "Demasiadas consultas", ...err },
  },
})

const tooMany = () =>
  new HttpError(429, "RATE_LIMITED", "Demasiadas consultas: espera un momento y vuelve a intentar")

/** Lo que ve cualquiera, con un límite por cliente para que nadie tumbe la caja. */
export function registerPublicStorefrontRoutes(app: App, deps: AppDeps): void {
  registerPublicOrderRoutes(app, deps)
  const pages = new RateLimiter(60, 60_000)
  const images = new RateLimiter(600, 60_000)

  app.openapi(publicRoute, (c) => {
    if (!pages.allow(clientKey(c), deps.now())) throw tooMany()
    c.header("cache-control", "no-cache")
    return c.json(publicCatalog(deps.db, deps.now()), 200)
  })

  app.openapi(publicImageRoute, (c) => {
    if (!images.allow(clientKey(c), deps.now())) throw tooMany()
    const row = publicImage(deps.db, c.req.valid("param").id)
    if (!row) throw new HttpError(404, "NOT_FOUND", "Esa foto no está en el catálogo")
    return imageResponse(row, c.req.valid("query").v, "public") as never
  })
}

export function registerStorefrontRoutes(app: App, deps: AppDeps): void {
  const run = deps.remote?.run ?? null
  const port = deps.network?.catalogPort ?? null

  const status = async (): Promise<StorefrontStatus> => {
    // Primero las IP: un celular Android no siempre resuelve los nombres .local.
    const hosts = reachable(deps.network?.hosts ?? []).sort(
      (a, b) => Number(!/^\d/.test(a)) - Number(!/^\d/.test(b)),
    )
    const tailscale = await tailscaleStatus(run, deps.network?.httpPort ?? 3000)
    return {
      settings: storefrontSettings(deps.db),
      port,
      urls: port ? hosts.map((h) => `http://${h}:${port}`) : [],
      publicUrl: port && tailscale.state === "running" ? await funnelUrl(run, port) : null,
      tailscale: tailscale.state,
      ...storefrontCounts(deps.db),
    }
  }

  const audit = (actorId: string, action: string, data: unknown) => {
    const now = deps.now()
    deps.db
      .insert(auditLog)
      .values({
        id: uuidv7(now),
        at: now,
        actorId,
        action,
        entityType: "settings",
        entityId: "storefront",
        data,
      })
      .run()
  }

  app.openapi(statusRoute, async (c) => {
    requirePermission(c, "settings.manage")
    return c.json(await status(), 200)
  })

  app.openapi(updateRoute, async (c) => {
    const actor = requirePermission(c, "settings.manage")
    updateStorefrontSettings(deps.db, c.req.valid("json"), actor.userId, deps.now())
    return c.json(await status(), 200)
  })

  app.openapi(publishRoute, async (c) => {
    const actor = requirePermission(c, "settings.manage")
    try {
      requireStorefront(deps.db)
    } catch {
      throw new HttpError(409, "CATALOG_OFF", "Enciende antes el catálogo en línea")
    }
    if (!port) {
      throw new HttpError(
        409,
        "CATALOG_PORT_OFF",
        "El puerto del catálogo está apagado (CATALOG=off)",
      )
    }
    const result = await enableFunnel(run, port)
    audit(actor.userId, "storefront.published", {
      ok: result.ok,
      needsApproval: result.approveUrl !== null,
    })
    return c.json(result, 200)
  })

  app.openapi(unpublishRoute, async (c) => {
    const actor = requirePermission(c, "settings.manage")
    const result = await disableFunnel(run)
    audit(actor.userId, "storefront.unpublished", { ok: result.ok })
    return c.json(result, 200)
  })
}
