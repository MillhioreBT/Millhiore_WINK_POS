import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  apiKeySchema,
  createApiKeySchema,
  createdApiKeySchema,
} from "@millhiore/contracts"
import { requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { createApiKey, listApiKeys, revokeApiKey } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const listRoute = createRoute({
  method: "get",
  path: "/api/api-keys",
  tags: ["Integraciones"],
  summary: "Claves de la API, sin su secreto",
  responses: {
    200: { description: "Claves", content: json(z.array(apiKeySchema)) },
    403: { description: "Falta settings.manage", ...err },
  },
})

const createKeyRoute = createRoute({
  method: "post",
  path: "/api/api-keys",
  tags: ["Integraciones"],
  summary: "Crea una clave con los permisos elegidos; su secreto se muestra solo esta vez",
  request: { body: { content: json(createApiKeySchema), required: true } },
  responses: {
    201: { description: "Creada", content: json(createdApiKeySchema) },
    403: { description: "Falta settings.manage o un permiso que se quiere dar", ...err },
  },
})

const revokeRoute = createRoute({
  method: "post",
  path: "/api/api-keys/{id}/revoke",
  tags: ["Integraciones"],
  summary: "Revoca una clave: deja de funcionar al instante",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Revocada", content: json(apiKeySchema) },
    403: { description: "Falta settings.manage", ...err },
    404: { description: "No existe", ...err },
  },
})

export function registerApiKeyRoutes(app: App, deps: AppDeps): void {
  app.openapi(listRoute, (c) => {
    requirePermission(c, "settings.manage")
    return c.json(listApiKeys(deps.db), 200)
  })

  app.openapi(createKeyRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    return c.json(createApiKey(deps.db, c.req.valid("json"), actor, deps.now()), 201)
  })

  app.openapi(revokeRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    return c.json(revokeApiKey(deps.db, c.req.valid("param").id, actor.userId, deps.now()), 200)
  })
}
