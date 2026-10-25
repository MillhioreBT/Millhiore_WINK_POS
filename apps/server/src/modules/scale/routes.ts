import { createRoute, type z } from "@hono/zod-openapi"
import { apiErrorSchema, type ScaleSettings, scaleSettingsSchema } from "@millhiore/contracts"
import { auditLog, business, currency, type Db } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { readSetting, writeSetting } from "../settings/service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const SCALE_KEY = "scale"

/**
 * Lo más común en las balanzas que imprimen etiquetas: cualquier prefijo de uso interno (20 a
 * 29), 5 dígitos de PLU y el peso en gramos. Si trae el precio, en la moneda legal.
 */
export function scaleSettings(db: Pick<Db, "select">): ScaleSettings {
  const legal = db.select({ c: business.legalCurrency }).from(business).get()?.c ?? "VES"
  return {
    prefixes: ["20", "21", "22", "23", "24", "25", "26", "27", "28", "29"],
    pluDigits: 5,
    value: "weight",
    priceCurrency: legal,
    ...(readSetting<Partial<ScaleSettings>>(db, SCALE_KEY) ?? {}),
  }
}

const getRoute = createRoute({
  method: "get",
  path: "/api/settings/scale",
  tags: ["Ajustes"],
  summary: "Cómo se leen las etiquetas que imprime la balanza",
  responses: { 200: { description: "Ajustes", content: json(scaleSettingsSchema) } },
})

const putRoute = createRoute({
  method: "put",
  path: "/api/settings/scale",
  tags: ["Ajustes"],
  summary: "Cambia los prefijos, los dígitos del PLU y si la etiqueta trae el peso o el precio",
  request: { body: { content: json(scaleSettingsSchema), required: true } },
  responses: {
    200: { description: "Guardados", content: json(scaleSettingsSchema) },
    403: { description: "Falta settings.manage", ...err },
    422: { description: "Moneda desconocida", ...err },
  },
})

export function registerScaleRoutes(app: App, deps: AppDeps): void {
  app.openapi(getRoute, (c) => {
    actorOf(c)
    return c.json(scaleSettings(deps.db), 200)
  })

  app.openapi(putRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    const input = c.req.valid("json")
    const after = { ...input, prefixes: [...new Set(input.prefixes)].sort() }
    const now = deps.now()
    deps.db.transaction(
      (tx) => {
        const known = tx
          .select({ code: currency.code })
          .from(currency)
          .where(eq(currency.code, after.priceCurrency))
          .get()
        if (!known) {
          throw new HttpError(422, "UNKNOWN_CURRENCY", `Moneda desconocida: ${after.priceCurrency}`)
        }
        const before = scaleSettings(tx)
        writeSetting(tx, SCALE_KEY, after)
        tx.insert(auditLog)
          .values({
            id: uuidv7(now),
            at: now,
            actorId: actor.userId,
            action: "settings.scale.updated",
            entityType: "settings",
            entityId: SCALE_KEY,
            data: { before, after },
          })
          .run()
      },
      { behavior: "immediate" },
    )
    return c.json(after, 200)
  })
}
