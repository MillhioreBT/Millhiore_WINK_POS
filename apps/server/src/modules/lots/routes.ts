import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  type LotRow,
  type Lots,
  lotSettingsSchema,
  lotsSchema,
  type UpdateLotBody,
  updateLotSchema,
} from "@millhiore/contracts"
import {
  auditLog,
  business,
  type Db,
  document,
  location,
  lot,
  lotBalance,
  variant,
} from "@millhiore/db"
import type { Permission } from "@millhiore/domain"
import { addDays, daysLeft, localDate, uuidv7 } from "@millhiore/domain"
import { and, asc, eq, gt, gte, isNotNull, lt, lte, sql } from "drizzle-orm"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { readSetting, writeSetting } from "../settings/service"

type Reader = Pick<Db, "select">

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const ALERT_KEY = "inventory.expiryAlertDays"

/** Con cuántos días de anticipación se avisa de lo que va a vencer (30 si no se ha elegido). */
export function expiryAlertDays(db: Reader): number {
  return readSetting<number>(db, ALERT_KEY) ?? 30
}

function todayOf(db: Reader, now: number): string {
  const tz = db.select({ tz: business.timezone }).from(business).get()?.tz ?? "America/Caracas"
  return localDate(now, tz)
}

export type LotStatus = "expiring" | "expired" | "all"

/**
 * Lotes con existencia, el que vence primero arriba. `expiring`: los que vencen dentro de los días
 * de aviso (sin los ya vencidos); `expired`: los vencidos.
 */
export function listLots(
  db: Reader,
  opts: {
    now: number
    status: LotStatus
    variantId?: string | undefined
    locationId?: string | undefined
  },
): Lots {
  const today = todayOf(db, opts.now)
  const alertDays = expiryAlertDays(db)
  const filters = [
    gt(lotBalance.qtyMilli, 0),
    opts.variantId ? eq(lot.variantId, opts.variantId) : undefined,
    opts.locationId ? eq(lotBalance.locationId, opts.locationId) : undefined,
    opts.status === "expired"
      ? and(isNotNull(lot.expiresOn), lt(lot.expiresOn, today))
      : opts.status === "expiring"
        ? and(
            isNotNull(lot.expiresOn),
            gte(lot.expiresOn, today),
            lte(lot.expiresOn, addDays(today, alertDays)),
          )
        : undefined,
  ].filter((f) => f !== undefined)
  const rows = db
    .select({
      lotId: lot.id,
      variantId: lot.variantId,
      productName: variant.name,
      sku: variant.sku,
      code: lot.code,
      expiresOn: lot.expiresOn,
      locationId: lotBalance.locationId,
      locationName: location.name,
      qtyMilli: lotBalance.qtyMilli,
      documentId: lot.documentId,
      documentNumber: document.number,
      createdAt: lot.createdAt,
    })
    .from(lotBalance)
    .innerJoin(lot, eq(lot.id, lotBalance.lotId))
    .innerJoin(variant, eq(variant.id, lot.variantId))
    .innerJoin(location, eq(location.id, lotBalance.locationId))
    .innerJoin(document, eq(document.id, lot.documentId))
    .where(and(...filters))
    .orderBy(sql`${lot.expiresOn} is null`, asc(lot.expiresOn), asc(variant.name))
    .limit(1000)
    .all()
  return {
    today,
    alertDays,
    rows: rows.map((r): LotRow => ({ ...r, daysLeft: daysLeft(r.expiresOn, today) })),
  }
}

/** Cuántos lotes con existencia vencen pronto y cuántos ya vencieron (para Inicio). */
export function expiryCounts(
  db: Reader,
  now: number,
): { alertDays: number; expiringLots: number; expiredLots: number } {
  const count = (status: LotStatus) =>
    new Set(listLots(db, { now, status }).rows.map((r) => r.lotId)).size
  return {
    alertDays: expiryAlertDays(db),
    expiringLots: count("expiring"),
    expiredLots: count("expired"),
  }
}

/**
 * Corrige el código o la fecha de un lote mal anotado. Lo ya movido no cambia; queda en la
 * bitácora con lo que tenía antes.
 */
export function updateLot(
  db: Db,
  id: string,
  patch: UpdateLotBody,
  actorId: string,
  now: number,
): { id: string; code: string | null; expiresOn: string | null } {
  return db.transaction(
    (tx) => {
      const before = tx
        .select({ id: lot.id, code: lot.code, expiresOn: lot.expiresOn })
        .from(lot)
        .where(eq(lot.id, id))
        .get()
      if (!before) throw new HttpError(404, "NOT_FOUND", `No existe el lote ${id}`)
      const set = {
        ...(patch.code !== undefined ? { code: patch.code || null } : {}),
        ...(patch.expiresOn !== undefined ? { expiresOn: patch.expiresOn } : {}),
      }
      if (Object.keys(set).length) tx.update(lot).set(set).where(eq(lot.id, id)).run()
      const after = { ...before, ...set }
      tx.insert(auditLog)
        .values({
          id: uuidv7(now),
          at: now,
          actorId,
          action: "lot.updated",
          entityType: "lot",
          entityId: id,
          data: { before, after },
        })
        .run()
      return after
    },
    { behavior: "immediate" },
  )
}

/** Ver lotes: quien mira o ajusta el inventario. */
const VIEWERS: readonly Permission[] = ["inventory.view", "inventory.adjust"]

const listRoute = createRoute({
  method: "get",
  path: "/api/lots",
  tags: ["Inventario"],
  summary: "Lotes con existencia y su vencimiento",
  description:
    "Uno por lote y ubicación, el que vence primero arriba. `status=expiring`: vencen dentro de los días de aviso; `expired`: ya vencidos.",
  request: {
    query: z.object({
      status: z.enum(["expiring", "expired", "all"]).default("all"),
      variantId: z.string().min(1).optional(),
      locationId: z.string().min(1).optional(),
    }),
  },
  responses: {
    200: { description: "Lotes", content: json(lotsSchema) },
    403: { description: "Sin permiso", ...err },
  },
})

const updateRoute = createRoute({
  method: "patch",
  path: "/api/lots/{id}",
  tags: ["Inventario"],
  summary: "Corrige el código o el vencimiento de un lote",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(updateLotSchema), required: true },
  },
  responses: {
    200: {
      description: "Guardado",
      content: json(
        z.object({ id: z.string(), code: z.string().nullable(), expiresOn: z.string().nullable() }),
      ),
    },
    403: { description: "Falta inventory.adjust", ...err },
    404: { description: "No existe", ...err },
  },
})

const getSettingsRoute = createRoute({
  method: "get",
  path: "/api/settings/lots",
  tags: ["Ajustes"],
  summary: "Con cuántos días se avisa de lo que va a vencer",
  responses: { 200: { description: "Ajustes", content: json(lotSettingsSchema) } },
})

const putSettingsRoute = createRoute({
  method: "put",
  path: "/api/settings/lots",
  tags: ["Ajustes"],
  summary: "Cambia los días de aviso de vencimiento",
  request: { body: { content: json(lotSettingsSchema), required: true } },
  responses: {
    200: { description: "Guardados", content: json(lotSettingsSchema) },
    403: { description: "Falta inventory.adjust", ...err },
  },
})

export function registerLotRoutes(app: App, deps: AppDeps): void {
  app.openapi(listRoute, (c) => {
    const { permissions } = actorOf(c)
    if (!VIEWERS.some((p) => permissions.has(p))) {
      throw new HttpError(403, "FORBIDDEN", "Falta el permiso inventory.view")
    }
    return c.json(listLots(deps.db, { ...c.req.valid("query"), now: deps.now() }), 200)
  })

  app.openapi(updateRoute, (c) => {
    const actor = requirePermission(c, "inventory.adjust")
    const { id } = c.req.valid("param")
    return c.json(updateLot(deps.db, id, c.req.valid("json"), actor.userId, deps.now()), 200)
  })

  app.openapi(getSettingsRoute, (c) => {
    actorOf(c)
    return c.json({ alertDays: expiryAlertDays(deps.db) }, 200)
  })

  app.openapi(putSettingsRoute, (c) => {
    const actor = requirePermission(c, "inventory.adjust")
    const { alertDays } = c.req.valid("json")
    const now = deps.now()
    deps.db.transaction(
      (tx) => {
        const before = expiryAlertDays(tx)
        writeSetting(tx, ALERT_KEY, alertDays)
        tx.insert(auditLog)
          .values({
            id: uuidv7(now),
            at: now,
            actorId: actor.userId,
            action: "settings.lots.updated",
            entityType: "settings",
            entityId: ALERT_KEY,
            data: { before, after: alertDays },
          })
          .run()
      },
      { behavior: "immediate" },
    )
    return c.json({ alertDays }, 200)
  })
}
