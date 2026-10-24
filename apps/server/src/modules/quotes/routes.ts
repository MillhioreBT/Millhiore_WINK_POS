import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  createQuoteSchema,
  quoteDetailSchema,
  quoteStatusSchema,
  quoteSummarySchema,
} from "@millhiore/contracts"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { forbidden } from "../../http/errors"
import { cancelQuote, createQuote, listQuotes, quoteDetail } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const listRoute = createRoute({
  method: "get",
  path: "/api/quotes",
  tags: ["Ventas"],
  summary: "Cotizaciones, las más recientes primero",
  request: {
    query: z.object({
      status: quoteStatusSchema.optional(),
      search: z.string().max(80).optional(),
      from: z.coerce.number().int().optional(),
      to: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }),
  },
  responses: {
    200: { description: "Cotizaciones", content: json(z.array(quoteSummarySchema)) },
    403: { description: "Falta sale.create o report.view", ...err },
  },
})

const detailRoute = createRoute({
  method: "get",
  path: "/api/quotes/{id}",
  tags: ["Ventas"],
  summary: "Una cotización con sus productos",
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: {
    200: { description: "Cotización", content: json(quoteDetailSchema) },
    404: { description: "No existe", ...err },
  },
})

const createRouteDef = createRoute({
  method: "post",
  path: "/api/quotes",
  tags: ["Ventas"],
  summary: "Guarda una cotización (no mueve inventario ni dinero)",
  description:
    "Los precios quedan congelados durante su vigencia. Para venderla se manda la venta con " +
    "`quoteId`: la cotización queda convertida en la misma operación.",
  request: { body: { content: json(createQuoteSchema), required: true } },
  responses: {
    201: { description: "Guardada", content: json(quoteDetailSchema) },
    403: { description: "Falta sale.create", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const cancelRoute = createRoute({
  method: "post",
  path: "/api/quotes/{id}/cancel",
  tags: ["Ventas"],
  summary: "Anula una cotización abierta",
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: {
    200: { description: "Anulada", content: json(quoteDetailSchema) },
    403: { description: "Falta sale.create", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Ya no está abierta", ...err },
  },
})

export function registerQuoteRoutes(app: App, deps: AppDeps): void {
  /** Ver cotizaciones: quien vende o quien ve informes. */
  const canSee = (permissions: ReadonlySet<string>) =>
    permissions.has("sale.create") || permissions.has("report.view")

  app.openapi(listRoute, (c) => {
    const actor = actorOf(c)
    if (!canSee(actor.permissions)) throw forbidden("sale.create")
    return c.json(listQuotes(deps.db, c.req.valid("query")), 200)
  })

  app.openapi(detailRoute, (c) => {
    const actor = actorOf(c)
    if (!canSee(actor.permissions)) throw forbidden("sale.create")
    return c.json(quoteDetail(deps.db, c.req.valid("param").id), 200)
  })

  app.openapi(createRouteDef, (c) => {
    const actor = requirePermission(c, "sale.create")
    return c.json(createQuote(deps.db, c.req.valid("json"), actor.userId, deps.now()), 201)
  })

  app.openapi(cancelRoute, (c) => {
    const actor = requirePermission(c, "sale.create")
    return c.json(cancelQuote(deps.db, c.req.valid("param").id, actor.userId, deps.now()), 200)
  })
}
