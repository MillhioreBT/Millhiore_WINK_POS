import { createRoute, z } from "@hono/zod-openapi"
import { apiErrorSchema, auditEntrySchema } from "@millhiore/contracts"
import { requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { listAudit } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }

const listRoute = createRoute({
  method: "get",
  path: "/api/audit",
  tags: ["Bitácora"],
  summary: "Bitácora de acciones sensibles",
  description:
    "Quién hizo qué y cuándo: ventas, anulaciones, cambios de precios, de usuarios, de ajustes. Lo más reciente primero. Solo lectura: nadie puede editarla.",
  request: {
    query: z.object({
      from: z.coerce.number().int().optional(),
      to: z.coerce.number().int().optional(),
      action: z.string().max(64).optional(),
      actorId: z.string().max(64).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
  },
  responses: {
    200: {
      description: "Entradas",
      content: { "application/json": { schema: z.array(auditEntrySchema) } },
    },
    403: { description: "Falta audit.view", ...err },
  },
})

export function registerAuditRoutes(app: App, deps: AppDeps): void {
  app.openapi(listRoute, (c) => {
    requirePermission(c, "audit.view")
    return c.json(listAudit(deps.db, c.req.valid("query")), 200)
  })
}
