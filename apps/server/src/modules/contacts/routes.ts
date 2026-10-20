import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  contactSchema,
  createContactSchema,
  updateContactSchema,
} from "@millhiore/contracts"
import type { Permission } from "@millhiore/domain"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { createContact, listContacts, updateContact } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const listRoute = createRoute({
  method: "get",
  path: "/api/contacts",
  tags: ["Contactos"],
  summary: "Clientes y proveedores",
  request: {
    query: z.object({
      search: z.string().max(80).optional(),
      kind: z.enum(["customer", "supplier"]).optional(),
      all: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: { 200: { description: "Contactos", content: json(z.array(contactSchema)) } },
})

const createRouteDef = createRoute({
  method: "post",
  path: "/api/contacts",
  tags: ["Contactos"],
  summary: "Crea un cliente o proveedor",
  request: { body: { content: json(createContactSchema), required: true } },
  responses: {
    201: { description: "Creado", content: json(contactSchema) },
    403: { description: "Sin permiso", ...err },
    409: { description: "Cédula o RIF repetido", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const updateRoute = createRoute({
  method: "patch",
  path: "/api/contacts/{id}",
  tags: ["Contactos"],
  summary: "Edita un contacto",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(updateContactSchema), required: true },
  },
  responses: {
    200: { description: "Guardado", content: json(contactSchema) },
    403: { description: "Falta contact.manage", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Cédula o RIF repetido", ...err },
  },
})

const CREATORS: readonly Permission[] = ["contact.manage", "sale.create", "purchase.create"]

export function registerContactRoutes(app: App, deps: AppDeps): void {
  app.openapi(listRoute, (c) => {
    actorOf(c)
    const q = c.req.valid("query")
    return c.json(
      listContacts(deps.db, { search: q.search, kind: q.kind, all: q.all === "true" }),
      200,
    )
  })

  // En caja (o al comprar) hace falta registrar al cliente o proveedor al vuelo: lo puede hacer
  // quien vende, compra o gestiona contactos. Editar contactos existentes exige contact.manage.
  app.openapi(createRouteDef, (c) => {
    const actor = actorOf(c)
    if (!CREATORS.some((p) => actor.permissions.has(p))) {
      throw new HttpError(403, "FORBIDDEN", "Falta el permiso contact.manage")
    }
    return c.json(createContact(deps.db, c.req.valid("json"), actor.userId, deps.now()), 201)
  })

  app.openapi(updateRoute, (c) => {
    const actor = requirePermission(c, "contact.manage")
    const { id } = c.req.valid("param")
    return c.json(updateContact(deps.db, id, c.req.valid("json"), actor.userId, deps.now()), 200)
  })
}
