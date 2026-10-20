import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  businessProfileSchema,
  creditSettingsSchema,
  fiscalSettingsSchema,
  securitySettingsSchema,
  surchargeSchema,
  taxSchema,
} from "@millhiore/contracts"
import { surcharge, tax } from "@millhiore/db"
import { asc } from "drizzle-orm"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import {
  autoLockMinutes,
  businessProfile,
  creditEnabled,
  fiscalSettings,
  updateBusinessProfile,
  updateCreditSettings,
  updateFiscalSettings,
  updateSecuritySettings,
  updateSurcharge,
  updateTax,
} from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const rateBpSchema = z.number().int().min(0).max(10_000)
const ratePatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  /** Centésimas de punto porcentual: 1600 = 16 %. */
  rateBp: rateBpSchema.optional(),
  active: z.boolean().optional(),
})

const getFiscalRoute = createRoute({
  method: "get",
  path: "/api/settings/fiscal",
  tags: ["Impuestos"],
  summary: "Condición fiscal del negocio y si los precios incluyen IVA",
  responses: { 200: { description: "Configuración fiscal", content: json(fiscalSettingsSchema) } },
})

const putFiscalRoute = createRoute({
  method: "put",
  path: "/api/settings/fiscal",
  tags: ["Impuestos"],
  summary: "Cambia la condición fiscal",
  description:
    "Pasar a sujeto pasivo especial activa el IGTF en los métodos de cobro en divisas; dejar de serlo lo retira.",
  request: { body: { content: json(fiscalSettingsSchema.partial()), required: true } },
  responses: {
    200: { description: "Guardada", content: json(fiscalSettingsSchema) },
    403: { description: "Falta settings.manage", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const getCreditRoute = createRoute({
  method: "get",
  path: "/api/settings/credit",
  tags: ["Fiado"],
  summary: "Si el negocio vende a crédito (fiado)",
  responses: { 200: { description: "Configuración", content: json(creditSettingsSchema) } },
})

const putCreditRoute = createRoute({
  method: "put",
  path: "/api/settings/credit",
  tags: ["Fiado"],
  summary: "Activa o desactiva el fiado",
  description: "Desactivarlo no borra lo que ya se debe: solo impide fiar ventas nuevas.",
  request: { body: { content: json(creditSettingsSchema), required: true } },
  responses: {
    200: { description: "Guardada", content: json(creditSettingsSchema) },
    403: { description: "Falta settings.manage", ...err },
  },
})

const getSecurityRoute = createRoute({
  method: "get",
  path: "/api/settings/security",
  tags: ["Seguridad"],
  summary: "Bloqueo automático de la pantalla",
  responses: { 200: { description: "Configuración", content: json(securitySettingsSchema) } },
})

const putSecurityRoute = createRoute({
  method: "put",
  path: "/api/settings/security",
  tags: ["Seguridad"],
  summary: "Cambia los minutos sin uso tras los que se bloquea la pantalla",
  request: { body: { content: json(securitySettingsSchema), required: true } },
  responses: {
    200: { description: "Guardada", content: json(securitySettingsSchema) },
    403: { description: "Falta settings.manage", ...err },
  },
})

const getBusinessRoute = createRoute({
  method: "get",
  path: "/api/settings/business",
  tags: ["Negocio"],
  summary: "Nombre, RIF, dirección, teléfono y mensaje del recibo",
  responses: { 200: { description: "Datos del negocio", content: json(businessProfileSchema) } },
})

const putBusinessRoute = createRoute({
  method: "put",
  path: "/api/settings/business",
  tags: ["Negocio"],
  summary: "Cambia los datos del negocio",
  request: { body: { content: json(businessProfileSchema.partial()), required: true } },
  responses: {
    200: { description: "Guardados", content: json(businessProfileSchema) },
    403: { description: "Falta settings.manage", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const listTaxesRoute = createRoute({
  method: "get",
  path: "/api/taxes",
  tags: ["Impuestos"],
  summary: "Alícuotas de IVA",
  responses: { 200: { description: "Impuestos", content: json(z.array(taxSchema)) } },
})

const patchTaxRoute = createRoute({
  method: "patch",
  path: "/api/taxes/{id}",
  tags: ["Impuestos"],
  summary: "Cambia una alícuota de IVA (los documentos ya emitidos no cambian)",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(ratePatchSchema), required: true },
  },
  responses: {
    200: { description: "Guardado", content: json(taxSchema) },
    403: { description: "Falta settings.manage", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Es el impuesto por defecto", ...err },
    422: { description: "Alícuota inválida", ...err },
  },
})

const listSurchargesRoute = createRoute({
  method: "get",
  path: "/api/surcharges",
  tags: ["Impuestos"],
  summary: "Recargos por método de cobro (IGTF)",
  responses: { 200: { description: "Recargos", content: json(z.array(surchargeSchema)) } },
})

const patchSurchargeRoute = createRoute({
  method: "patch",
  path: "/api/surcharges/{id}",
  tags: ["Impuestos"],
  summary: "Cambia la alícuota o el estado de un recargo",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(ratePatchSchema), required: true },
  },
  responses: {
    200: { description: "Guardado", content: json(surchargeSchema) },
    403: { description: "Falta settings.manage", ...err },
    404: { description: "No existe", ...err },
    422: { description: "Alícuota inválida", ...err },
  },
})

export function registerSettingsRoutes(app: App, deps: AppDeps): void {
  // Lectura para cualquier usuario con sesión: la caja necesita estos datos para mostrar totales.
  app.openapi(getFiscalRoute, (c) => {
    actorOf(c)
    return c.json(fiscalSettings(deps.db), 200)
  })

  app.openapi(putFiscalRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    const patch = c.req.valid("json")
    return c.json(updateFiscalSettings(deps.db, patch, actor.userId, deps.now()), 200)
  })

  app.openapi(getCreditRoute, (c) => {
    actorOf(c)
    return c.json({ enabled: creditEnabled(deps.db) }, 200)
  })

  app.openapi(putCreditRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    const { enabled } = c.req.valid("json")
    return c.json(updateCreditSettings(deps.db, enabled, actor.userId, deps.now()), 200)
  })

  app.openapi(getSecurityRoute, (c) => {
    actorOf(c)
    return c.json({ autoLockMinutes: autoLockMinutes(deps.db) }, 200)
  })

  app.openapi(putSecurityRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    const { autoLockMinutes: minutes } = c.req.valid("json")
    return c.json(updateSecuritySettings(deps.db, minutes, actor.userId, deps.now()), 200)
  })

  app.openapi(getBusinessRoute, (c) => {
    actorOf(c)
    return c.json(businessProfile(deps.db), 200)
  })

  app.openapi(putBusinessRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    const patch = c.req.valid("json")
    return c.json(updateBusinessProfile(deps.db, patch, actor.userId, deps.now()), 200)
  })

  app.openapi(listTaxesRoute, (c) => {
    actorOf(c)
    return c.json(deps.db.select().from(tax).orderBy(asc(tax.code)).all(), 200)
  })

  app.openapi(patchTaxRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    const { id } = c.req.valid("param")
    return c.json(updateTax(deps.db, id, c.req.valid("json"), actor.userId, deps.now()), 200)
  })

  app.openapi(listSurchargesRoute, (c) => {
    actorOf(c)
    return c.json(deps.db.select().from(surcharge).orderBy(asc(surcharge.code)).all(), 200)
  })

  app.openapi(patchSurchargeRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    const { id } = c.req.valid("param")
    return c.json(updateSurcharge(deps.db, id, c.req.valid("json"), actor.userId, deps.now()), 200)
  })
}
