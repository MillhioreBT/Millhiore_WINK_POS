import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  cancelOrderSchema,
  createOrderSchema,
  orderStatusSchema,
  placedOrderSchema,
  webOrderSchema,
} from "@millhiore/contracts"
import { requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { clientKey, RateLimiter } from "../../http/rateLimit"
import { closeOrder, countNewOrders, listOrders, orderById, placeOrder } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })
const idParam = z.object({ id: z.string().min(1) })

const placeRoute = createRoute({
  method: "post",
  path: "/api/public/orders",
  tags: ["Pedidos"],
  summary: "Un cliente pide desde el catálogo en línea (sin sesión)",
  description:
    "Los precios los pone el servidor con el catálogo de ese momento. Si se repite el mismo `id`, devuelve el pedido que ya quedó.",
  security: [],
  request: { body: { content: json(createOrderSchema), required: true } },
  responses: {
    201: { description: "Anotado", content: json(placedOrderSchema) },
    404: { description: "El catálogo o los pedidos están apagados", ...err },
    409: { description: "Algo se acabó", ...err },
    422: { description: "Datos inválidos", ...err },
    429: { description: "Demasiados pedidos", ...err },
  },
})

const listRoute = createRoute({
  method: "get",
  path: "/api/orders",
  tags: ["Pedidos"],
  summary: "Los pedidos del catálogo, del más nuevo al más viejo",
  request: {
    query: z.object({ status: z.union([orderStatusSchema, z.literal("all")]).optional() }),
  },
  responses: {
    200: { description: "Pedidos", content: json(z.array(webOrderSchema)) },
    403: { description: "Falta sale.create", ...err },
  },
})

const countRoute = createRoute({
  method: "get",
  path: "/api/orders/count",
  tags: ["Pedidos"],
  summary: "Cuántos pedidos esperan (para el aviso del menú)",
  responses: {
    200: { description: "Cuántos", content: json(z.object({ new: z.number().int() })) },
    403: { description: "Falta sale.create", ...err },
  },
})

const getRoute = createRoute({
  method: "get",
  path: "/api/orders/{id}",
  tags: ["Pedidos"],
  summary: "Un pedido",
  request: { params: idParam },
  responses: {
    200: { description: "Pedido", content: json(webOrderSchema) },
    403: { description: "Falta sale.create", ...err },
    404: { description: "No existe", ...err },
  },
})

const doneRoute = createRoute({
  method: "post",
  path: "/api/orders/{id}/done",
  tags: ["Pedidos"],
  summary: "Lo marca atendido sin cobrarlo en la caja (se cobró de otra forma)",
  request: { params: idParam },
  responses: {
    200: { description: "Atendido", content: json(webOrderSchema) },
    403: { description: "Falta sale.create", ...err },
    409: { description: "Ya no está nuevo", ...err },
  },
})

const cancelRoute = createRoute({
  method: "post",
  path: "/api/orders/{id}/cancel",
  tags: ["Pedidos"],
  summary: "Descarta un pedido, con el motivo",
  request: { params: idParam, body: { content: json(cancelOrderSchema), required: true } },
  responses: {
    200: { description: "Descartado", content: json(webOrderSchema) },
    403: { description: "Falta sale.create", ...err },
    409: { description: "Ya no está nuevo", ...err },
  },
})

/** Pedir desde el catálogo: lo ve cualquiera, con un límite por visitante. */
export function registerPublicOrderRoutes(app: App, deps: AppDeps): void {
  const orders = new RateLimiter(10, 10 * 60_000)
  app.openapi(placeRoute, (c) => {
    if (!orders.allow(clientKey(c), deps.now())) {
      throw new HttpError(429, "RATE_LIMITED", "Demasiados pedidos seguidos: espera unos minutos")
    }
    return c.json(placeOrder(deps.db, c.req.valid("json"), deps.now()), 201)
  })
}

export function registerOrderRoutes(app: App, deps: AppDeps): void {
  app.openapi(listRoute, (c) => {
    requirePermission(c, "sale.create")
    return c.json(listOrders(deps.db, c.req.valid("query").status ?? "new"), 200)
  })

  app.openapi(countRoute, (c) => {
    requirePermission(c, "sale.create")
    return c.json({ new: countNewOrders(deps.db) }, 200)
  })

  app.openapi(getRoute, (c) => {
    requirePermission(c, "sale.create")
    return c.json(orderById(deps.db, c.req.valid("param").id), 200)
  })

  app.openapi(doneRoute, (c) => {
    const actor = requirePermission(c, "sale.create")
    const order = closeOrder(
      deps.db,
      c.req.valid("param").id,
      { status: "done" },
      actor.userId,
      deps.now(),
    )
    return c.json(order, 200)
  })

  app.openapi(cancelRoute, (c) => {
    const actor = requirePermission(c, "sale.create")
    const order = closeOrder(
      deps.db,
      c.req.valid("param").id,
      { status: "cancelled", reason: c.req.valid("json").reason ?? null },
      actor.userId,
      deps.now(),
    )
    return c.json(order, 200)
  })
}
