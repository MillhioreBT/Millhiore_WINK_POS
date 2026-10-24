import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  createSaleChargeSchema,
  type SaleCharge,
  type SaleChargeInfo,
  saleChargeSchema,
  updateSaleChargeSchema,
} from "@millhiore/contracts"
import { auditLog, currency, type Db, saleCharge, tax } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { asc, eq, sql } from "drizzle-orm"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const columns = {
  id: saleCharge.id,
  name: saleCharge.name,
  kind: saleCharge.kind,
  rateBp: saleCharge.rateBp,
  amountMinor: saleCharge.amountMinor,
  currency: saleCharge.currency,
  taxId: saleCharge.taxId,
  auto: saleCharge.auto,
  position: saleCharge.position,
  active: saleCharge.active,
}

export function listCharges(db: Db, opts: { all?: boolean } = {}): SaleCharge[] {
  return db
    .select(columns)
    .from(saleCharge)
    .where(opts.all ? undefined : eq(saleCharge.active, true))
    .orderBy(asc(saleCharge.position), asc(saleCharge.name))
    .all()
}

/** Los recargos activos, para la caja. */
export function chargesForPos(db: Db): SaleChargeInfo[] {
  return listCharges(db).map(({ position: _p, active: _a, ...info }) => info)
}

function chargeById(db: Db, id: string): SaleCharge {
  const row = db.select(columns).from(saleCharge).where(eq(saleCharge.id, id)).get()
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe el recargo ${id}`)
  return row
}

function checkReferences(
  db: Db,
  input: { taxId?: string | null | undefined; currency?: string | null | undefined },
) {
  if (input.taxId) {
    const t = db.select().from(tax).where(eq(tax.id, input.taxId)).get()
    if (!t?.active) throw new HttpError(422, "UNKNOWN_TAX", `Impuesto desconocido: ${input.taxId}`)
  }
  if (input.currency) {
    const c = db.select().from(currency).where(eq(currency.code, input.currency)).get()
    if (!c) throw new HttpError(422, "UNKNOWN_CURRENCY", `Moneda desconocida: ${input.currency}`)
  }
}

function duplicate(e: unknown): never {
  const text = String((e as Error).cause ?? (e as Error).message)
  if (/UNIQUE/i.test(text)) {
    throw new HttpError(409, "DUPLICATE_NAME", "Ya existe un recargo con ese nombre")
  }
  if (/CHECK/i.test(text)) {
    throw new HttpError(422, "INVALID_CHARGE", "Un porcentaje va de 0,01 % a 100 %")
  }
  throw e
}

function audit(db: Db, actorId: string, now: number, action: string, id: string, data: unknown) {
  db.insert(auditLog)
    .values({ id: uuidv7(now), at: now, actorId, action, entityType: "charge", entityId: id, data })
    .run()
}

const listRoute = createRoute({
  method: "get",
  path: "/api/charges",
  tags: ["Ventas"],
  summary: "Recargos de venta (delivery, servicio…)",
  request: { query: z.object({ all: z.enum(["true", "false"]).optional() }) },
  responses: { 200: { description: "Recargos", content: json(z.array(saleChargeSchema)) } },
})

const createRouteDef = createRoute({
  method: "post",
  path: "/api/charges",
  tags: ["Ventas"],
  summary: "Crea un recargo de venta",
  description:
    "Fijo (un monto, p. ej. delivery) o porcentual (sobre el subtotal sin IVA, p. ej. servicio). " +
    "Con IVA o sin él; con `auto` se agrega solo a cada venta.",
  request: { body: { content: json(createSaleChargeSchema), required: true } },
  responses: {
    201: { description: "Creado", content: json(saleChargeSchema) },
    403: { description: "Falta settings.manage", ...err },
    409: { description: "Nombre repetido", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const updateRoute = createRoute({
  method: "patch",
  path: "/api/charges/{id}",
  tags: ["Ventas"],
  summary: "Cambia, reordena o desactiva un recargo",
  description: "Las ventas ya hechas conservan el recargo con que se cobraron.",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(updateSaleChargeSchema), required: true },
  },
  responses: {
    200: { description: "Guardado", content: json(saleChargeSchema) },
    403: { description: "Falta settings.manage", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Nombre repetido", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

export function registerChargeRoutes(app: App, deps: AppDeps): void {
  app.openapi(listRoute, (c) => {
    actorOf(c)
    return c.json(listCharges(deps.db, { all: c.req.valid("query").all === "true" }), 200)
  })

  app.openapi(createRouteDef, (c) => {
    const actor = requirePermission(c, "settings.manage")
    const body = c.req.valid("json")
    const now = deps.now()
    checkReferences(deps.db, body)
    const id = uuidv7(now)
    try {
      const last = deps.db
        .select({ max: sql<number>`coalesce(max(${saleCharge.position}), 0)` })
        .from(saleCharge)
        .get()
      deps.db
        .insert(saleCharge)
        .values({
          id,
          name: body.name,
          kind: body.kind,
          rateBp: body.kind === "percent" ? body.rateBp : 0,
          amountMinor: body.kind === "fixed" ? body.amountMinor : 0,
          currency: body.kind === "fixed" ? (body.currency ?? null) : null,
          taxId: body.taxId ?? null,
          auto: body.auto,
          position: (last?.max ?? 0) + 1,
        })
        .run()
    } catch (e) {
      duplicate(e)
    }
    const created = chargeById(deps.db, id)
    audit(deps.db, actor.userId, now, "charge.created", id, created)
    return c.json(created, 201)
  })

  app.openapi(updateRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")
    const before = chargeById(deps.db, id)
    checkReferences(deps.db, patch)
    // El tipo no cambia: un porcentaje no se vuelve un monto (sería otro recargo).
    const set = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.rateBp !== undefined && before.kind === "percent" ? { rateBp: patch.rateBp } : {}),
      ...(patch.amountMinor !== undefined && before.kind === "fixed"
        ? { amountMinor: patch.amountMinor }
        : {}),
      ...(patch.currency !== undefined && before.kind === "fixed"
        ? { currency: patch.currency }
        : {}),
      ...(patch.taxId !== undefined ? { taxId: patch.taxId ?? null } : {}),
      ...(patch.auto !== undefined ? { auto: patch.auto } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    }
    try {
      if (Object.keys(set).length) {
        deps.db.update(saleCharge).set(set).where(eq(saleCharge.id, id)).run()
      }
    } catch (e) {
      duplicate(e)
    }
    const after = chargeById(deps.db, id)
    audit(deps.db, actor.userId, deps.now(), "charge.updated", id, { before, after })
    return c.json(after, 200)
  })
}
