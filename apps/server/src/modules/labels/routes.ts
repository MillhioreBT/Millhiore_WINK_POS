import { createRoute, type z } from "@hono/zod-openapi"
import { apiErrorSchema, type LabelSettings, labelSettingsSchema } from "@millhiore/contracts"
import { auditLog, type Db } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { readSetting, writeSetting } from "../settings/service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const LABELS_KEY = "labels"

/** Lo más común: rollo de 50 × 25 mm con el precio en la moneda de referencia. */
const DEFAULT_LABELS: LabelSettings = {
  paper: "roll",
  widthMm: 50,
  heightMm: 25,
  price: "reference",
  showBusiness: false,
  showSku: false,
}

export function labelSettings(db: Pick<Db, "select">): LabelSettings {
  return { ...DEFAULT_LABELS, ...(readSetting<Partial<LabelSettings>>(db, LABELS_KEY) ?? {}) }
}

const getRoute = createRoute({
  method: "get",
  path: "/api/settings/labels",
  tags: ["Ajustes"],
  summary: "Cómo se imprimen las etiquetas con código de barras",
  responses: { 200: { description: "Ajustes", content: json(labelSettingsSchema) } },
})

const putRoute = createRoute({
  method: "put",
  path: "/api/settings/labels",
  tags: ["Ajustes"],
  summary: "Cambia el papel, el tamaño y lo que lleva cada etiqueta",
  request: { body: { content: json(labelSettingsSchema), required: true } },
  responses: {
    200: { description: "Guardados", content: json(labelSettingsSchema) },
    403: { description: "Falta catalog.manage", ...err },
  },
})

export function registerLabelRoutes(app: App, deps: AppDeps): void {
  app.openapi(getRoute, (c) => {
    actorOf(c)
    return c.json(labelSettings(deps.db), 200)
  })

  app.openapi(putRoute, (c) => {
    const actor = requirePermission(c, "catalog.manage")
    const after = c.req.valid("json")
    const now = deps.now()
    deps.db.transaction(
      (tx) => {
        const before = labelSettings(tx)
        writeSetting(tx, LABELS_KEY, after)
        tx.insert(auditLog)
          .values({
            id: uuidv7(now),
            at: now,
            actorId: actor.userId,
            action: "settings.labels.updated",
            entityType: "settings",
            entityId: LABELS_KEY,
            data: { before, after },
          })
          .run()
      },
      { behavior: "immediate" },
    )
    return c.json(after, 200)
  })
}
