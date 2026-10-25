import { createRoute, z } from "@hono/zod-openapi"
import {
  addTabLinesSchema,
  apiErrorSchema,
  cancelTabSchema,
  diningFloorSchema,
  diningLayoutSchema,
  moveTabSchema,
  openTabSchema,
  tabDetailSchema,
  tabStatusSchema,
  tabSummarySchema,
  updateTabSchema,
  voidTabLineSchema,
} from "@millhiore/contracts"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { forbidden } from "../../http/errors"
import { printInBackground } from "../kitchen/routes"
import {
  addTabLines,
  cancelTab,
  diningFloor,
  hasPending,
  listTabs,
  moveTab,
  openTab,
  saveLayout,
  tabDetail,
  updateTab,
  voidTabLine,
} from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })
const tabParam = z.object({ id: z.string().min(1) })
const tabResponses = {
  200: { description: "La cuenta", content: json(tabDetailSchema) },
  403: { description: "Falta table.serve", ...err },
  404: { description: "No existe", ...err },
  409: { description: "La cuenta ya no está abierta o cambió", ...err },
  422: { description: "Datos inválidos", ...err },
}

const floorRoute = createRoute({
  method: "get",
  path: "/api/dining",
  tags: ["Restaurante"],
  summary: "Las salas con sus mesas (y la cuenta abierta de cada una) y las cuentas sin mesa",
  responses: {
    200: { description: "Plano", content: json(diningFloorSchema) },
    403: { description: "Falta table.serve o sale.create", ...err },
  },
})

const layoutRoute = createRoute({
  method: "put",
  path: "/api/dining/layout",
  tags: ["Restaurante"],
  summary: "Guarda las salas y sus mesas, en orden",
  description:
    "Las que traen id se renombran, las nuevas se crean y las que faltan se desactivan (una mesa " +
    "con la cuenta abierta no se puede quitar).",
  request: { body: { content: json(diningLayoutSchema), required: true } },
  responses: {
    200: { description: "Plano", content: json(diningFloorSchema) },
    403: { description: "Falta settings.manage", ...err },
    409: { description: "Una mesa que se quita tiene la cuenta abierta", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const listRoute = createRoute({
  method: "get",
  path: "/api/tabs",
  tags: ["Restaurante"],
  summary: "Cuentas, las más recientes primero",
  request: {
    query: z.object({
      status: tabStatusSchema.optional(),
      from: z.coerce.number().int().optional(),
      to: z.coerce.number().int().optional(),
    }),
  },
  responses: {
    200: { description: "Cuentas", content: json(z.array(tabSummarySchema)) },
    403: { description: "Falta table.serve o sale.create", ...err },
  },
})

const detailRoute = createRoute({
  method: "get",
  path: "/api/tabs/{id}",
  tags: ["Restaurante"],
  summary: "Una cuenta con todo lo que se pidió",
  request: { params: tabParam },
  responses: tabResponses,
})

const openRoute = createRoute({
  method: "post",
  path: "/api/tabs",
  tags: ["Restaurante"],
  summary: "Abre una cuenta en una mesa libre o sin mesa (con un nombre)",
  request: { body: { content: json(openTabSchema), required: true } },
  responses: { ...tabResponses, 201: { description: "Abierta", content: json(tabDetailSchema) } },
})

const updateRoute = createRoute({
  method: "patch",
  path: "/api/tabs/{id}",
  tags: ["Restaurante"],
  summary: "Cambia el nombre, las personas, la nota o quién atiende",
  request: { params: tabParam, body: { content: json(updateTabSchema), required: true } },
  responses: tabResponses,
})

const linesRoute = createRoute({
  method: "post",
  path: "/api/tabs/{id}/lines",
  tags: ["Restaurante"],
  summary: "Agrega un pedido a la cuenta, con el precio de hoy",
  description: "Cada línea trae su id (UUIDv7): reenviar el mismo pedido no lo repite.",
  request: { params: tabParam, body: { content: json(addTabLinesSchema), required: true } },
  responses: tabResponses,
})

const voidLineRoute = createRoute({
  method: "post",
  path: "/api/tabs/{id}/lines/{lineId}/void",
  tags: ["Restaurante"],
  summary: "Anula (todo o parte de) un producto ya pedido, con el motivo",
  request: {
    params: z.object({ id: z.string().min(1), lineId: z.string().min(1) }),
    body: { content: json(voidTabLineSchema), required: true },
  },
  responses: { ...tabResponses, 403: { description: "Falta sale.void", ...err } },
})

const moveRoute = createRoute({
  method: "post",
  path: "/api/tabs/{id}/move",
  tags: ["Restaurante"],
  summary: "Pasa la cuenta, o algunos productos, a otra mesa o cuenta",
  description:
    "Si la mesa de destino está ocupada, las cuentas se juntan. Devuelve la cuenta de destino.",
  request: { params: tabParam, body: { content: json(moveTabSchema), required: true } },
  responses: tabResponses,
})

const cancelRoute = createRoute({
  method: "post",
  path: "/api/tabs/{id}/cancel",
  tags: ["Restaurante"],
  summary: "Cierra una cuenta sin cobrarla",
  description: "Si le queda algo por cobrar, se anula con el motivo: eso exige sale.void.",
  request: { params: tabParam, body: { content: json(cancelTabSchema), required: true } },
  responses: { ...tabResponses, 403: { description: "Falta table.serve o sale.void", ...err } },
})

export function registerDiningRoutes(app: App, deps: AppDeps): void {
  /** Ver las mesas: quien atiende o quien cobra. */
  const canSee = (permissions: ReadonlySet<string>) =>
    permissions.has("table.serve") || permissions.has("sale.create")

  app.openapi(floorRoute, (c) => {
    if (!canSee(actorOf(c).permissions)) throw forbidden("table.serve")
    return c.json(diningFloor(deps.db), 200)
  })

  app.openapi(layoutRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    return c.json(saveLayout(deps.db, c.req.valid("json"), actor.userId, deps.now()), 200)
  })

  app.openapi(listRoute, (c) => {
    if (!canSee(actorOf(c).permissions)) throw forbidden("table.serve")
    return c.json(listTabs(deps.db, c.req.valid("query")), 200)
  })

  app.openapi(detailRoute, (c) => {
    if (!canSee(actorOf(c).permissions)) throw forbidden("table.serve")
    return c.json(tabDetail(deps.db, c.req.valid("param").id), 200)
  })

  app.openapi(openRoute, (c) => {
    const actor = requirePermission(c, "table.serve")
    return c.json(openTab(deps.db, c.req.valid("json"), actor.userId, deps.now()), 201)
  })

  app.openapi(updateRoute, (c) => {
    const actor = requirePermission(c, "table.serve")
    const { id } = c.req.valid("param")
    return c.json(updateTab(deps.db, id, c.req.valid("json"), actor.userId, deps.now()), 200)
  })

  app.openapi(linesRoute, (c) => {
    const actor = requirePermission(c, "table.serve")
    const { id } = c.req.valid("param")
    const tab = addTabLines(deps.db, id, c.req.valid("json"), actor.userId, deps.now())
    printInBackground(deps)
    return c.json(tab, 200)
  })

  // Quitar algo que ya se pidió es como anular una venta: no lo hace cualquiera.
  app.openapi(voidLineRoute, (c) => {
    const actor = requirePermission(c, "sale.void")
    const { id, lineId } = c.req.valid("param")
    const tab = voidTabLine(deps.db, id, lineId, c.req.valid("json"), actor.userId, deps.now())
    printInBackground(deps)
    return c.json(tab, 200)
  })

  app.openapi(moveRoute, (c) => {
    const actor = requirePermission(c, "table.serve")
    const { id } = c.req.valid("param")
    return c.json(moveTab(deps.db, id, c.req.valid("json"), actor.userId, deps.now()), 200)
  })

  app.openapi(cancelRoute, (c) => {
    const actor = requirePermission(c, "table.serve")
    const { id } = c.req.valid("param")
    if (hasPending(deps.db, id)) requirePermission(c, "sale.void")
    const { reason } = c.req.valid("json")
    const tab = cancelTab(deps.db, id, reason ?? null, actor.userId, deps.now())
    printInBackground(deps)
    return c.json(tab, 200)
  })
}
