import { createRoute, z } from "@hono/zod-openapi"
import { apiErrorSchema, setupSchema, setupStatusSchema } from "@millhiore/contracts"
import type { App, AppDeps } from "../../http/context"
import { isConfigured, runSetup } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }

const statusRoute = createRoute({
  method: "get",
  path: "/api/setup/status",
  tags: ["Configuración"],
  summary: "¿Ya se hizo la configuración inicial?",
  responses: {
    200: { description: "Estado", content: { "application/json": { schema: setupStatusSchema } } },
  },
})

const setupRoute = createRoute({
  method: "post",
  path: "/api/setup",
  tags: ["Configuración"],
  summary: "Asistente inicial: crea negocio, caja, cuentas, roles y el usuario dueño",
  description: "Solo funciona una vez, sobre una instalación vacía.",
  request: { body: { content: { "application/json": { schema: setupSchema } }, required: true } },
  responses: {
    201: {
      description: "Configurado",
      content: {
        "application/json": { schema: z.object({ businessId: z.string(), ownerId: z.string() }) },
      },
    },
    409: { description: "Ya estaba configurado", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

export function registerSetupRoutes(app: App, deps: AppDeps): void {
  app.openapi(statusRoute, (c) => c.json({ configured: isConfigured(deps.db) }, 200))

  app.openapi(setupRoute, async (c) => {
    const result = await runSetup(deps.auth, deps.db, c.req.valid("json"), deps.now())
    deps.afterSetup?.()
    return c.json(result, 201)
  })
}
