import { createRoute } from "@hono/zod-openapi"
import { apiErrorSchema, remoteStatusSchema, serveResultSchema } from "@millhiore/contracts"
import { auditLog } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { enableServe, tailscaleStatus } from "./tailscale"

const err = { content: { "application/json": { schema: apiErrorSchema } } }

const statusRoute = createRoute({
  method: "get",
  path: "/api/remote",
  tags: ["Equipos"],
  summary: "Cómo está el acceso remoto con Tailscale en esta PC",
  responses: {
    200: { description: "Estado", content: { "application/json": { schema: remoteStatusSchema } } },
    403: { description: "Falta settings.manage", ...err },
  },
})

const serveRoute = createRoute({
  method: "post",
  path: "/api/remote/tailscale/serve",
  tags: ["Equipos"],
  summary: "Sirve la app con HTTPS de Tailscale (solo para los equipos de la cuenta)",
  responses: {
    200: {
      description: "Resultado",
      content: { "application/json": { schema: serveResultSchema } },
    },
    403: { description: "Falta settings.manage", ...err },
  },
})

export function registerRemoteRoutes(app: App, deps: AppDeps): void {
  const port = deps.network?.httpPort ?? 3000
  const run = deps.remote?.run ?? null

  app.openapi(statusRoute, async (c) => {
    requirePermission(c, "settings.manage")
    const tailscale = await tailscaleStatus(run, port)
    // Entrar por la dirección de Tailscale con HTTPS: ese origen también es de confianza.
    if (tailscale.httpsUrl) deps.remote?.origins.add(tailscale.httpsUrl)
    return c.json({ port, tailscale }, 200)
  })

  app.openapi(serveRoute, async (c) => {
    const actor = requirePermission(c, "settings.manage")
    const result = await enableServe(run, port)
    const now = deps.now()
    deps.db
      .insert(auditLog)
      .values({
        id: uuidv7(now),
        at: now,
        actorId: actor.userId,
        action: "remote.tailscale.serve",
        entityType: "settings",
        entityId: "remote",
        data: { ok: result.ok, needsApproval: result.approveUrl !== null },
      })
      .run()
    if (result.ok) {
      const status = await tailscaleStatus(run, port)
      if (status.httpsUrl) deps.remote?.origins.add(status.httpsUrl)
    }
    return c.json(result, 200)
  })
}
