import { createRoute } from "@hono/zod-openapi"
import { apiErrorSchema, payablesSchema } from "@millhiore/contracts"
import type { Permission } from "@millhiore/domain"
import { actorOf } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { payables } from "./service"

/** Ver lo que se le debe a los proveedores: quien paga, o quien mira las finanzas o los informes. */
const VIEWERS: readonly Permission[] = ["payable.manage", "finance.view", "report.view"]

const listRoute = createRoute({
  method: "get",
  path: "/api/payables",
  tags: ["Cuentas por pagar"],
  summary: "Cuánto se le debe a cada proveedor (cuentas por pagar)",
  description:
    "Compras y gastos dejados a deber con saldo pendiente, con la antigüedad de saldos. Se pagan con un documento `PAYMENT_OUT` en `/api/documents`.",
  responses: {
    200: {
      description: "Deudas pendientes",
      content: { "application/json": { schema: payablesSchema } },
    },
    403: {
      description: "Sin permiso",
      content: { "application/json": { schema: apiErrorSchema } },
    },
  },
})

export function registerPayableRoutes(app: App, deps: AppDeps): void {
  app.openapi(listRoute, (c) => {
    if (!VIEWERS.some((p) => actorOf(c).permissions.has(p))) {
      throw new HttpError(403, "FORBIDDEN", "Falta el permiso payable.manage")
    }
    return c.json(payables(deps.db, deps.now()), 200)
  })
}
