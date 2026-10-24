import { createRoute } from "@hono/zod-openapi"
import { apiErrorSchema, debtBodySchema, postedDocumentSchema } from "@millhiore/contracts"
import { permissionToPost } from "@millhiore/domain"
import { requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { postingContext } from "../settings/service"
import { postDebt } from "./service"

const postRoute = createRoute({
  method: "post",
  path: "/api/debts",
  tags: ["Cuentas por cobrar", "Cuentas por pagar"],
  summary: "Anotar una deuda sin venta, compra o gasto detrás",
  description:
    "Lo que un cliente ya debía (`DEBT_IN`, exige `finance.manage`) o lo que se le debe a un proveedor (`DEBT_OUT`, exige `payable.manage`): un saldo de antes de usar el sistema o un préstamo. Se cobra con `PAYMENT_IN` o se paga con `PAYMENT_OUT` como cualquier otra. Se anula con `POST /api/documents/{id}/void` mientras no tenga cobros o pagos.",
  request: {
    body: { required: true, content: { "application/json": { schema: debtBodySchema } } },
  },
  responses: {
    200: {
      description: "Ya estaba anotada (mismo id)",
      content: { "application/json": { schema: postedDocumentSchema } },
    },
    201: {
      description: "Deuda anotada",
      content: { "application/json": { schema: postedDocumentSchema } },
    },
    403: {
      description: "Sin permiso",
      content: { "application/json": { schema: apiErrorSchema } },
    },
    409: {
      description: "Conflicto (turno cerrado, id usado por otro documento…)",
      content: { "application/json": { schema: apiErrorSchema } },
    },
    422: {
      description: "Datos inválidos",
      content: { "application/json": { schema: apiErrorSchema } },
    },
  },
})

export function registerDebtRoutes(app: App, deps: AppDeps): void {
  app.openapi(postRoute, (c) => {
    const body = c.req.valid("json")
    const permission = permissionToPost(body.type) ?? "finance.manage"
    const actor = requirePermission(c, permission)
    const result = postDebt(deps.db, body, postingContext(deps.db, deps.now(), actor.userId))
    return result.duplicate ? c.json(result, 200) : c.json(result, 201)
  })
}
