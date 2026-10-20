import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  createRecurringExpenseSchema,
  recurringExpenseSchema,
  updateRecurringExpenseSchema,
} from "@millhiore/contracts"
import type { Permission } from "@millhiore/domain"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { createRecurring, generateDueRecurring, listRecurring, updateRecurring } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

/** Ver los gastos recurrentes: quien registra gastos, o mira las finanzas o los informes. */
const VIEWERS: readonly Permission[] = ["expense.create", "finance.view", "report.view"]

const listRoute = createRoute({
  method: "get",
  path: "/api/recurring-expenses",
  tags: ["Gastos"],
  summary: "Gastos recurrentes (alquiler, internet, sueldos…)",
  description:
    "Los que ya vencieron salen primero. Los automáticos se registran solos a deber al vencer (cada hora el servidor revisa); los demás esperan a que alguien los registre.",
  responses: {
    200: { description: "Recurrentes", content: json(z.array(recurringExpenseSchema)) },
    403: { description: "Sin permiso", ...err },
  },
})

const createRouteDef = createRoute({
  method: "post",
  path: "/api/recurring-expenses",
  tags: ["Gastos"],
  summary: "Crea un gasto recurrente",
  request: { body: { content: json(createRecurringExpenseSchema), required: true } },
  responses: {
    201: { description: "Creado", content: json(recurringExpenseSchema) },
    403: { description: "Falta expense.create", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const updateRoute = createRoute({
  method: "patch",
  path: "/api/recurring-expenses/{id}",
  tags: ["Gastos"],
  summary: "Cambia, pausa o reactiva un gasto recurrente",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(updateRecurringExpenseSchema), required: true },
  },
  responses: {
    200: { description: "Guardado", content: json(recurringExpenseSchema) },
    403: { description: "Falta expense.create", ...err },
    404: { description: "No existe", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

export function registerRecurringRoutes(app: App, deps: AppDeps): void {
  /**
   * Un automático que ya venció se registra al guardarlo, sin esperar a la revisión de cada hora;
   * devuelve el recurrente ya con su siguiente vencimiento.
   */
  const settle = (id: string) => {
    generateDueRecurring(deps.db, deps.now())
    const row = listRecurring(deps.db, deps.now()).find((r) => r.id === id)
    if (!row) throw new HttpError(404, "NOT_FOUND", `No existe el gasto recurrente ${id}`)
    return row
  }

  app.openapi(listRoute, (c) => {
    if (!VIEWERS.some((p) => actorOf(c).permissions.has(p))) {
      throw new HttpError(403, "FORBIDDEN", "Falta el permiso expense.create")
    }
    return c.json(listRecurring(deps.db, deps.now()), 200)
  })

  app.openapi(createRouteDef, (c) => {
    const actor = requirePermission(c, "expense.create")
    const created = createRecurring(deps.db, c.req.valid("json"), actor.userId, deps.now())
    return c.json(settle(created.id), 201)
  })

  app.openapi(updateRoute, (c) => {
    const actor = requirePermission(c, "expense.create")
    const { id } = c.req.valid("param")
    updateRecurring(deps.db, id, c.req.valid("json"), actor.userId, deps.now())
    return c.json(settle(id), 200)
  })
}
