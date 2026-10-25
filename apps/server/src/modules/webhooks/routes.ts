import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  createWebhookSchema,
  updateWebhookSchema,
  webhookDeliverySchema,
  webhookSchema,
} from "@millhiore/contracts"
import { requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import {
  createWebhook,
  listDeliveries,
  listWebhooks,
  pingWebhook,
  retryDelivery,
  updateWebhook,
} from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })
const forbidden = { 403: { description: "Falta settings.manage", ...err } }
const idParam = z.object({ id: z.string() })

const listRoute = createRoute({
  method: "get",
  path: "/api/webhooks",
  tags: ["Integraciones"],
  summary: "Webhooks, con su último aviso",
  responses: {
    200: { description: "Webhooks", content: json(z.array(webhookSchema)) },
    ...forbidden,
  },
})

const createHookRoute = createRoute({
  method: "post",
  path: "/api/webhooks",
  tags: ["Integraciones"],
  summary: "Crea un webhook: la dirección y los eventos que recibe; su secreto se genera",
  request: { body: { content: json(createWebhookSchema), required: true } },
  responses: { 201: { description: "Creado", content: json(webhookSchema) }, ...forbidden },
})

const updateRoute = createRoute({
  method: "patch",
  path: "/api/webhooks/{id}",
  tags: ["Integraciones"],
  summary: "Cambia la dirección, los eventos o lo apaga",
  request: { params: idParam, body: { content: json(updateWebhookSchema), required: true } },
  responses: {
    200: { description: "Guardado", content: json(webhookSchema) },
    ...forbidden,
    404: { description: "No existe", ...err },
  },
})

const pingRoute = createRoute({
  method: "post",
  path: "/api/webhooks/{id}/ping",
  tags: ["Integraciones"],
  summary: "Manda un aviso de prueba («ping»)",
  request: { params: idParam },
  responses: {
    201: { description: "En camino", content: json(webhookDeliverySchema) },
    ...forbidden,
    404: { description: "No existe", ...err },
  },
})

const deliveriesRoute = createRoute({
  method: "get",
  path: "/api/webhooks/{id}/deliveries",
  tags: ["Integraciones"],
  summary: "Los últimos avisos de un webhook, con sus intentos",
  request: { params: idParam },
  responses: {
    200: { description: "Avisos", content: json(z.array(webhookDeliverySchema)) },
    ...forbidden,
    404: { description: "No existe", ...err },
  },
})

const retryRoute = createRoute({
  method: "post",
  path: "/api/webhooks/deliveries/{id}/retry",
  tags: ["Integraciones"],
  summary: "Vuelve a intentar ya un aviso que falló",
  request: { params: idParam },
  responses: {
    204: { description: "En camino" },
    ...forbidden,
    404: { description: "No existe", ...err },
  },
})

export function registerWebhookRoutes(app: App, deps: AppDeps): void {
  app.openapi(listRoute, (c) => {
    requirePermission(c, "settings.manage")
    return c.json(listWebhooks(deps.db), 200)
  })

  app.openapi(createHookRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    return c.json(createWebhook(deps.db, c.req.valid("json"), actor.userId, deps.now()), 201)
  })

  app.openapi(updateRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    const { id } = c.req.valid("param")
    return c.json(updateWebhook(deps.db, id, c.req.valid("json"), actor.userId, deps.now()), 200)
  })

  app.openapi(pingRoute, (c) => {
    requirePermission(c, "settings.manage")
    return c.json(pingWebhook(deps.db, c.req.valid("param").id, deps.now()), 201)
  })

  app.openapi(deliveriesRoute, (c) => {
    requirePermission(c, "settings.manage")
    return c.json(listDeliveries(deps.db, c.req.valid("param").id), 200)
  })

  app.openapi(retryRoute, (c) => {
    requirePermission(c, "settings.manage")
    retryDelivery(deps.db, c.req.valid("param").id, deps.now())
    return c.body(null, 204)
  })
}
