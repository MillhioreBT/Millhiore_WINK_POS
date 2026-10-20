import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  paymentMethodRowSchema,
  updatePaymentMethodSchema,
} from "@millhiore/contracts"
import type { Permission } from "@millhiore/domain"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { listPaymentMethods, updatePaymentMethod } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

/** Ver los métodos: quien los administra o mira las finanzas. */
const VIEWERS: readonly Permission[] = ["finance.manage", "finance.view", "settings.manage"]

const listRoute = createRoute({
  method: "get",
  path: "/api/payment-methods",
  tags: ["Cuentas"],
  summary: "Métodos de pago con su comisión",
  description:
    "Con qué se cobra y se paga, la cuenta donde cae el dinero y la comisión que descuenta el banco o el punto de venta (puntos básicos del monto).",
  responses: {
    200: { description: "Métodos", content: json(z.array(paymentMethodRowSchema)) },
    403: { description: "Sin permiso", ...err },
  },
})

const updateRoute = createRoute({
  method: "patch",
  path: "/api/payment-methods/{id}",
  tags: ["Cuentas"],
  summary: "Cambia la comisión de un método de pago",
  description:
    "La comisión se descuenta de cada venta y abono cobrados con el método: la cuenta recibe el cobro menos la comisión. Lo ya cobrado no cambia.",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(updatePaymentMethodSchema), required: true },
  },
  responses: {
    200: { description: "Guardado", content: json(paymentMethodRowSchema) },
    403: { description: "Falta finance.manage", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Su cuenta está desactivada", ...err },
  },
})

export function registerPaymentMethodRoutes(app: App, deps: AppDeps): void {
  app.openapi(listRoute, (c) => {
    if (!VIEWERS.some((p) => actorOf(c).permissions.has(p))) {
      throw new HttpError(403, "FORBIDDEN", "Falta el permiso finance.manage")
    }
    return c.json(listPaymentMethods(deps.db), 200)
  })

  app.openapi(updateRoute, (c) => {
    const actor = requirePermission(c, "finance.manage")
    const { id } = c.req.valid("param")
    return c.json(
      updatePaymentMethod(deps.db, id, c.req.valid("json"), actor.userId, deps.now()),
      200,
    )
  })
}
