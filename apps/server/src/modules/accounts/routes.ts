import { createRoute, z } from "@hono/zod-openapi"
import {
  accountSchema,
  apiErrorSchema,
  createAccountSchema,
  postedDocumentSchema,
  transferBodySchema,
  transferRowSchema,
  updateAccountSchema,
} from "@millhiore/contracts"
import type { Permission } from "@millhiore/domain"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { postingContext } from "../settings/service"
import { createAccount, listAccounts, listTransfers, postTransfer, updateAccount } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

/** Ver las cuentas: quien las administra o mira las finanzas y los informes. */
const VIEWERS: readonly Permission[] = ["finance.manage", "finance.view", "report.view"]

const listRoute = createRoute({
  method: "get",
  path: "/api/accounts",
  tags: ["Cuentas"],
  summary: "Cuentas de dinero con su saldo",
  description:
    "Donde vive el dinero: efectivo, bancos, pago móvil, billeteras. El saldo del efectivo es lo que debería haber en la gaveta.",
  request: { query: z.object({ all: z.enum(["true", "false"]).optional() }) },
  responses: {
    200: { description: "Cuentas", content: json(z.array(accountSchema)) },
    403: { description: "Sin permiso", ...err },
  },
})

const createRouteDef = createRoute({
  method: "post",
  path: "/api/accounts",
  tags: ["Cuentas"],
  summary: "Crea una cuenta (banco, pago móvil o billetera)",
  description: "Crea también el método de pago con el mismo nombre para cobrar y pagar con ella.",
  request: { body: { content: json(createAccountSchema), required: true } },
  responses: {
    201: { description: "Creada", content: json(accountSchema) },
    403: { description: "Falta finance.manage", ...err },
    409: { description: "Nombre repetido", ...err },
  },
})

const updateRoute = createRoute({
  method: "patch",
  path: "/api/accounts/{id}",
  tags: ["Cuentas"],
  summary: "Renombra o desactiva una cuenta",
  description:
    "Una cuenta de efectivo, o una con dinero, no se desactiva: primero se transfiere su saldo.",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(updateAccountSchema), required: true },
  },
  responses: {
    200: { description: "Guardada", content: json(accountSchema) },
    403: { description: "Falta finance.manage", ...err },
    404: { description: "No existe", ...err },
    409: { description: "No se puede desactivar o nombre repetido", ...err },
  },
})

const listTransfersRoute = createRoute({
  method: "get",
  path: "/api/transfers",
  tags: ["Cuentas"],
  summary: "Transferencias entre cuentas",
  request: {
    query: z.object({
      /** Desde/hasta (ms Unix, hasta excluido). */
      from: z.coerce.number().int().optional(),
      to: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
  },
  responses: {
    200: { description: "Transferencias", content: json(z.array(transferRowSchema)) },
    403: { description: "Sin permiso", ...err },
  },
})

const transferRoute = createRoute({
  method: "post",
  path: "/api/transfers",
  tags: ["Cuentas"],
  summary: "Transfiere dinero de una cuenta a otra",
  description:
    "Con cambio de moneda si las cuentas lo son distintas (se indica cuánto sale y cuánto entra). En la misma moneda entra exactamente lo que sale. Si toca el efectivo exige turno abierto. Idempotente por `id`; para anularla se usa `/api/documents/{id}/void`.",
  request: { body: { content: json(transferBodySchema), required: true } },
  responses: {
    201: { description: "Registrada", content: json(postedDocumentSchema) },
    200: { description: "Ya estaba registrada", content: json(postedDocumentSchema) },
    403: { description: "Falta finance.manage", ...err },
    409: { description: "Conflicto (turno cerrado, id repetido)", ...err },
    422: { description: "Transferencia inválida", ...err },
  },
})

export function registerAccountRoutes(app: App, deps: AppDeps): void {
  const checkView = (permissions: ReadonlySet<Permission>) => {
    if (!VIEWERS.some((p) => permissions.has(p))) {
      throw new HttpError(403, "FORBIDDEN", "Falta el permiso finance.manage")
    }
  }

  app.openapi(listRoute, (c) => {
    checkView(actorOf(c).permissions)
    return c.json(listAccounts(deps.db, { all: c.req.valid("query").all === "true" }), 200)
  })

  app.openapi(createRouteDef, (c) => {
    const actor = requirePermission(c, "finance.manage")
    return c.json(createAccount(deps.db, c.req.valid("json"), actor.userId, deps.now()), 201)
  })

  app.openapi(updateRoute, (c) => {
    const actor = requirePermission(c, "finance.manage")
    const { id } = c.req.valid("param")
    return c.json(updateAccount(deps.db, id, c.req.valid("json"), actor.userId, deps.now()), 200)
  })

  app.openapi(listTransfersRoute, (c) => {
    checkView(actorOf(c).permissions)
    return c.json(listTransfers(deps.db, c.req.valid("query")), 200)
  })

  app.openapi(transferRoute, (c) => {
    const actor = requirePermission(c, "finance.manage")
    const result = postTransfer(
      deps.db,
      c.req.valid("json"),
      postingContext(deps.db, deps.now(), actor.userId),
    )
    return result.duplicate ? c.json(result, 200) : c.json(result, 201)
  })
}
