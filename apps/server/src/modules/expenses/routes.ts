import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  createExpenseCategorySchema,
  expenseBodySchema,
  expenseCategorySchema,
  expensesSchema,
  postedDocumentSchema,
  updateExpenseCategorySchema,
} from "@millhiore/contracts"
import type { Permission } from "@millhiore/domain"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { postingContext } from "../settings/service"
import {
  createExpenseCategory,
  listExpenseCategories,
  listExpenses,
  postExpense,
  updateExpenseCategory,
} from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

/** Ver los gastos: quien los registra, quien mira las finanzas o quien lee informes. */
const VIEWERS: readonly Permission[] = ["expense.create", "finance.view", "report.view"]

const categoriesRoute = createRoute({
  method: "get",
  path: "/api/expense-categories",
  tags: ["Gastos"],
  summary: "Categorías de gasto",
  request: { query: z.object({ all: z.enum(["true", "false"]).optional() }) },
  responses: {
    200: { description: "Categorías", content: json(z.array(expenseCategorySchema)) },
    403: { description: "Sin permiso", ...err },
  },
})

const createCategoryRoute = createRoute({
  method: "post",
  path: "/api/expense-categories",
  tags: ["Gastos"],
  summary: "Crea una categoría de gasto",
  request: { body: { content: json(createExpenseCategorySchema), required: true } },
  responses: {
    201: { description: "Creada", content: json(expenseCategorySchema) },
    403: { description: "Falta finance.manage", ...err },
    409: { description: "Nombre repetido", ...err },
  },
})

const updateCategoryRoute = createRoute({
  method: "patch",
  path: "/api/expense-categories/{id}",
  tags: ["Gastos"],
  summary: "Renombra, reordena o desactiva una categoría de gasto",
  description:
    "Desactivarla no borra nada: los gastos ya registrados la conservan, pero deja de ofrecerse.",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(updateExpenseCategorySchema), required: true },
  },
  responses: {
    200: { description: "Guardada", content: json(expenseCategorySchema) },
    403: { description: "Falta finance.manage", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Nombre repetido", ...err },
  },
})

const listRoute = createRoute({
  method: "get",
  path: "/api/expenses",
  tags: ["Gastos"],
  summary: "Gastos de un período, con el total y lo gastado por categoría",
  request: {
    query: z.object({
      /** Desde/hasta (ms Unix, hasta excluido). */
      from: z.coerce.number().int().optional(),
      to: z.coerce.number().int().optional(),
      categoryId: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
  },
  responses: {
    200: { description: "Gastos", content: json(expensesSchema) },
    403: { description: "Sin permiso", ...err },
  },
})

const postRoute = createRoute({
  method: "post",
  path: "/api/expenses",
  tags: ["Gastos"],
  summary: "Registra un gasto pagado al momento",
  description:
    "El dinero sale de las cuentas de los métodos indicados. Pagado en efectivo exige turno abierto en la terminal. Idempotente por `id`; para anularlo se usa `/api/documents/{id}/void`.",
  request: { body: { content: json(expenseBodySchema), required: true } },
  responses: {
    201: { description: "Registrado", content: json(postedDocumentSchema) },
    200: { description: "Ya estaba registrado", content: json(postedDocumentSchema) },
    403: { description: "Falta expense.create", ...err },
    409: { description: "Conflicto (id repetido, turno cerrado)", ...err },
    422: { description: "Gasto inválido", ...err },
  },
})

export function registerExpenseRoutes(app: App, deps: AppDeps): void {
  const checkView = (permissions: ReadonlySet<Permission>) => {
    if (!VIEWERS.some((p) => permissions.has(p))) {
      throw new HttpError(403, "FORBIDDEN", "Falta el permiso expense.create")
    }
  }

  app.openapi(categoriesRoute, (c) => {
    checkView(actorOf(c).permissions)
    return c.json(listExpenseCategories(deps.db, { all: c.req.valid("query").all === "true" }), 200)
  })

  app.openapi(createCategoryRoute, (c) => {
    const actor = requirePermission(c, "finance.manage")
    const { name } = c.req.valid("json")
    return c.json(createExpenseCategory(deps.db, name, actor.userId, deps.now()), 201)
  })

  app.openapi(updateCategoryRoute, (c) => {
    const actor = requirePermission(c, "finance.manage")
    const { id } = c.req.valid("param")
    return c.json(
      updateExpenseCategory(deps.db, id, c.req.valid("json"), actor.userId, deps.now()),
      200,
    )
  })

  app.openapi(listRoute, (c) => {
    checkView(actorOf(c).permissions)
    return c.json(listExpenses(deps.db, c.req.valid("query")), 200)
  })

  app.openapi(postRoute, (c) => {
    const actor = requirePermission(c, "expense.create")
    const result = postExpense(
      deps.db,
      c.req.valid("json"),
      postingContext(deps.db, deps.now(), actor.userId),
    )
    return result.duplicate ? c.json(result, 200) : c.json(result, 201)
  })
}
