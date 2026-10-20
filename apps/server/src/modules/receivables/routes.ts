import { createRoute, z } from "@hono/zod-openapi"
import { apiErrorSchema, receivablesSchema, statementSchema } from "@millhiore/contracts"
import type { Permission } from "@millhiore/domain"
import { actorOf } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { receivables, statement } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }

/** Ver lo que deben los clientes: quien cobra, quien fía o quien mira informes y finanzas. */
const VIEWERS: readonly Permission[] = [
  "payment.receive",
  "sale.credit",
  "finance.view",
  "report.view",
]

const listRoute = createRoute({
  method: "get",
  path: "/api/receivables",
  tags: ["Fiado"],
  summary: "Cuánto debe cada cliente (cuentas por cobrar)",
  responses: {
    200: {
      description: "Deudas pendientes",
      content: { "application/json": { schema: receivablesSchema } },
    },
    403: { description: "Sin permiso", ...err },
  },
})

const statementRoute = createRoute({
  method: "get",
  path: "/api/contacts/{id}/statement",
  tags: ["Fiado"],
  summary: "Estado de cuenta de un cliente",
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: {
    200: {
      description: "Estado de cuenta",
      content: { "application/json": { schema: statementSchema } },
    },
    403: { description: "Sin permiso", ...err },
    404: { description: "No existe el contacto", ...err },
  },
})

export function registerReceivableRoutes(app: App, deps: AppDeps): void {
  const check = (permissions: ReadonlySet<Permission>) => {
    if (!VIEWERS.some((p) => permissions.has(p))) {
      throw new HttpError(403, "FORBIDDEN", "Falta el permiso payment.receive")
    }
  }

  app.openapi(listRoute, (c) => {
    check(actorOf(c).permissions)
    return c.json(receivables(deps.db, deps.now()), 200)
  })

  app.openapi(statementRoute, (c) => {
    check(actorOf(c).permissions)
    return c.json(statement(deps.db, c.req.valid("param").id, deps.now()), 200)
  })
}
