import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  createStockReasonSchema,
  stockAdjustmentsSchema,
  stockReasonSchema,
  updateStockReasonSchema,
} from "@millhiore/contracts"
import type { Permission } from "@millhiore/domain"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { createStockReason, listAdjustments, listStockReasons, updateStockReason } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

/** Ver motivos y ajustes: quien los registra o mira el inventario. */
const VIEWERS: readonly Permission[] = ["inventory.view", "inventory.adjust"]

const reasonsRoute = createRoute({
  method: "get",
  path: "/api/stock-reasons",
  tags: ["Inventario"],
  summary: "Motivos de ajuste de inventario",
  description:
    "Merma, vencido, uso interno, sobrante o faltante de un conteo… Una razón de salida solo admite cantidades negativas; una de entrada, positivas.",
  request: { query: z.object({ all: z.enum(["true", "false"]).optional() }) },
  responses: {
    200: { description: "Motivos", content: json(z.array(stockReasonSchema)) },
    403: { description: "Sin permiso", ...err },
  },
})

const createReasonRoute = createRoute({
  method: "post",
  path: "/api/stock-reasons",
  tags: ["Inventario"],
  summary: "Crea un motivo de ajuste",
  request: { body: { content: json(createStockReasonSchema), required: true } },
  responses: {
    201: { description: "Creado", content: json(stockReasonSchema) },
    403: { description: "Falta inventory.adjust", ...err },
    409: { description: "Nombre repetido", ...err },
  },
})

const updateReasonRoute = createRoute({
  method: "patch",
  path: "/api/stock-reasons/{id}",
  tags: ["Inventario"],
  summary: "Renombra, reordena o desactiva un motivo",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(updateStockReasonSchema), required: true },
  },
  responses: {
    200: { description: "Guardado", content: json(stockReasonSchema) },
    403: { description: "Falta inventory.adjust", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Nombre repetido", ...err },
  },
})

const adjustmentsRoute = createRoute({
  method: "get",
  path: "/api/stock-adjustments",
  tags: ["Inventario"],
  summary: "Ajustes de inventario de un período, con su valor por motivo",
  description:
    "Una fila por producto ajustado, con el valor de la mercancía (último costo al registrar, en moneda legal) y el total por motivo, netos de anulaciones. Sin `cost.view`, los valores van vacíos.",
  request: {
    query: z.object({
      /** Desde/hasta (ms Unix, hasta excluido). */
      from: z.coerce.number().int().optional(),
      to: z.coerce.number().int().optional(),
      reasonId: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(300),
    }),
  },
  responses: {
    200: { description: "Ajustes", content: json(stockAdjustmentsSchema) },
    403: { description: "Sin permiso", ...err },
  },
})

export function registerInventoryRoutes(app: App, deps: AppDeps): void {
  const checkView = (permissions: ReadonlySet<Permission>) => {
    if (!VIEWERS.some((p) => permissions.has(p))) {
      throw new HttpError(403, "FORBIDDEN", "Falta el permiso inventory.view")
    }
  }

  app.openapi(reasonsRoute, (c) => {
    checkView(actorOf(c).permissions)
    return c.json(listStockReasons(deps.db, { all: c.req.valid("query").all === "true" }), 200)
  })

  app.openapi(createReasonRoute, (c) => {
    const actor = requirePermission(c, "inventory.adjust")
    return c.json(createStockReason(deps.db, c.req.valid("json"), actor.userId, deps.now()), 201)
  })

  app.openapi(updateReasonRoute, (c) => {
    const actor = requirePermission(c, "inventory.adjust")
    const { id } = c.req.valid("param")
    return c.json(
      updateStockReason(deps.db, id, c.req.valid("json"), actor.userId, deps.now()),
      200,
    )
  })

  app.openapi(adjustmentsRoute, (c) => {
    const { permissions } = actorOf(c)
    checkView(permissions)
    return c.json(
      listAdjustments(deps.db, { ...c.req.valid("query"), seeCost: permissions.has("cost.view") }),
      200,
    )
  })
}
