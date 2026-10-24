import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  type CreateDiscountCodeBody,
  createDiscountCodeSchema,
  type DiscountCode,
  discountCodeSchema,
  type UpdateDiscountCodeBody,
  updateDiscountCodeSchema,
} from "@millhiore/contracts"
import { auditLog, business, currency, type Db, discountCode } from "@millhiore/db"
import { localDate, uuidv7 } from "@millhiore/domain"
import { asc, eq } from "drizzle-orm"
import { requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { discountCodeUses } from "../../posting/post"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Pick<Db, "select">

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

function withUses(db: Reader, row: typeof discountCode.$inferSelect): DiscountCode {
  const { createdAt: _, ...rest } = row
  return { ...rest, uses: discountCodeUses(db, row.id) }
}

export function listDiscountCodes(db: Reader, opts: { all?: boolean } = {}): DiscountCode[] {
  return db
    .select()
    .from(discountCode)
    .where(opts.all ? undefined : eq(discountCode.active, true))
    .orderBy(asc(discountCode.code))
    .all()
    .map((r) => withUses(db, r))
}

function byId(db: Reader, id: string): DiscountCode {
  const row = db.select().from(discountCode).where(eq(discountCode.id, id)).get()
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe el código ${id}`)
  return withUses(db, row)
}

/** El código y sus valores, ya normalizados y validados en conjunto. */
function normalize(tx: Tx, input: CreateDiscountCodeBody, exceptId?: string) {
  const code = input.code.trim().toUpperCase()
  const taken = tx
    .select({ id: discountCode.id })
    .from(discountCode)
    .where(eq(discountCode.code, code))
    .get()
  if (taken && taken.id !== exceptId) {
    throw new HttpError(409, "DUPLICATE_CODE", `Ya existe el código ${code}`)
  }
  if (input.kind === "percent" && !input.rateBp) {
    throw new HttpError(422, "INVALID_CODE", "Indica el porcentaje del descuento")
  }
  if (input.kind === "amount") {
    if (!input.amountMinor || !input.currency) {
      throw new HttpError(422, "INVALID_CODE", "Indica el monto y la moneda del descuento")
    }
    if (!tx.select().from(currency).where(eq(currency.code, input.currency)).get()) {
      throw new HttpError(422, "INVALID_CODE", `Moneda desconocida: ${input.currency}`)
    }
  }
  if (input.validFrom && input.validUntil && input.validFrom > input.validUntil) {
    throw new HttpError(422, "INVALID_CODE", "La fecha de inicio es posterior a la de fin")
  }
  return {
    code,
    kind: input.kind,
    rateBp: input.kind === "percent" ? (input.rateBp ?? 0) : 0,
    amountMinor: input.kind === "amount" ? (input.amountMinor ?? 0) : 0,
    currency: input.kind === "amount" ? (input.currency ?? null) : null,
    maxUses: input.maxUses ?? null,
    validFrom: input.validFrom ?? null,
    validUntil: input.validUntil ?? null,
    note: input.note?.trim() || null,
  }
}

function audit(tx: Tx, actorId: string, now: number, action: string, id: string, data: unknown) {
  tx.insert(auditLog)
    .values({
      id: uuidv7(now),
      at: now,
      actorId,
      action,
      entityType: "discount_code",
      entityId: id,
      data,
    })
    .run()
}

export function createDiscountCode(
  db: Db,
  input: CreateDiscountCodeBody,
  actorId: string,
  now: number,
): DiscountCode {
  return db.transaction(
    (tx) => {
      const id = uuidv7(now)
      tx.insert(discountCode)
        .values({ id, ...normalize(tx, input), createdAt: now })
        .run()
      const created = byId(tx, id)
      audit(tx, actorId, now, "discount-code.created", id, created)
      return created
    },
    { behavior: "immediate" },
  )
}

export function updateDiscountCode(
  db: Db,
  id: string,
  patch: UpdateDiscountCodeBody,
  actorId: string,
  now: number,
): DiscountCode {
  return db.transaction(
    (tx) => {
      const before = byId(tx, id)
      const merged = {
        code: patch.code ?? before.code,
        kind: patch.kind ?? before.kind,
        rateBp: patch.rateBp ?? before.rateBp,
        amountMinor: patch.amountMinor ?? before.amountMinor,
        ...((patch.currency ?? before.currency)
          ? { currency: patch.currency ?? before.currency ?? "" }
          : {}),
        maxUses: patch.maxUses === undefined ? before.maxUses : patch.maxUses,
        validFrom: patch.validFrom === undefined ? before.validFrom : patch.validFrom,
        validUntil: patch.validUntil === undefined ? before.validUntil : patch.validUntil,
        note: patch.note === undefined ? before.note : patch.note,
      }
      tx.update(discountCode)
        .set({
          ...normalize(tx, merged, id),
          ...(patch.active !== undefined ? { active: patch.active } : {}),
        })
        .where(eq(discountCode.id, id))
        .run()
      const after = byId(tx, id)
      audit(tx, actorId, now, "discount-code.updated", id, { before, after })
      return after
    },
    { behavior: "immediate" },
  )
}

/**
 * El código que dice el cliente en la caja: activo, vigente hoy y con usos disponibles. Si no,
 * un error que explica por qué.
 */
export function checkDiscountCode(db: Reader, text: string, now: number): DiscountCode {
  const code = text.trim().toUpperCase()
  const row = db.select().from(discountCode).where(eq(discountCode.code, code)).get()
  if (!row?.active) throw new HttpError(404, "UNKNOWN_CODE", `El código ${code} no existe`)
  const tz = db.select({ tz: business.timezone }).from(business).get()?.tz ?? "America/Caracas"
  const today = localDate(now, tz)
  if (row.validFrom && today < row.validFrom) {
    throw new HttpError(409, "CODE_NOT_YET", `El código ${code} vale desde el ${row.validFrom}`)
  }
  if (row.validUntil && today > row.validUntil) {
    throw new HttpError(409, "CODE_EXPIRED", `El código ${code} venció el ${row.validUntil}`)
  }
  const found = withUses(db, row)
  if (found.maxUses !== null && found.uses >= found.maxUses) {
    throw new HttpError(409, "CODE_USED_UP", `El código ${code} ya se usó todas las veces`)
  }
  return found
}

const listRoute = createRoute({
  method: "get",
  path: "/api/discount-codes",
  tags: ["Catálogo"],
  summary: "Códigos de descuento, con cuántas veces se han usado",
  request: { query: z.object({ all: z.enum(["true", "false"]).optional() }) },
  responses: {
    200: { description: "Códigos", content: json(z.array(discountCodeSchema)) },
    403: { description: "Falta sale.discount", ...err },
  },
})

const checkRoute = createRoute({
  method: "get",
  path: "/api/discount-codes/check",
  tags: ["Catálogo"],
  summary: "Valida el código que dice el cliente en la caja",
  request: { query: z.object({ code: z.string().trim().min(1).max(30) }) },
  responses: {
    200: { description: "Vale", content: json(discountCodeSchema) },
    403: { description: "Falta sale.create", ...err },
    404: { description: "No existe o está desactivado", ...err },
    409: { description: "Fuera de fecha o sin usos", ...err },
  },
})

const createRouteDef = createRoute({
  method: "post",
  path: "/api/discount-codes",
  tags: ["Catálogo"],
  summary: "Crea un código de descuento",
  request: { body: { content: json(createDiscountCodeSchema), required: true } },
  responses: {
    201: { description: "Creado", content: json(discountCodeSchema) },
    403: { description: "Falta sale.discount", ...err },
    409: { description: "Código repetido", ...err },
    422: { description: "Valores inválidos", ...err },
  },
})

const updateRoute = createRoute({
  method: "patch",
  path: "/api/discount-codes/{id}",
  tags: ["Catálogo"],
  summary: "Cambia o desactiva un código de descuento",
  description: "Las ventas que ya lo usaron no cambian.",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(updateDiscountCodeSchema), required: true },
  },
  responses: {
    200: { description: "Guardado", content: json(discountCodeSchema) },
    403: { description: "Falta sale.discount", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Código repetido", ...err },
    422: { description: "Valores inválidos", ...err },
  },
})

export function registerDiscountCodeRoutes(app: App, deps: AppDeps): void {
  app.openapi(listRoute, (c) => {
    requirePermission(c, "sale.discount")
    return c.json(listDiscountCodes(deps.db, { all: c.req.valid("query").all === "true" }), 200)
  })

  app.openapi(checkRoute, (c) => {
    requirePermission(c, "sale.create")
    return c.json(checkDiscountCode(deps.db, c.req.valid("query").code, deps.now()), 200)
  })

  app.openapi(createRouteDef, (c) => {
    const actor = requirePermission(c, "sale.discount")
    return c.json(createDiscountCode(deps.db, c.req.valid("json"), actor.userId, deps.now()), 201)
  })

  app.openapi(updateRoute, (c) => {
    const actor = requirePermission(c, "sale.discount")
    const { id } = c.req.valid("param")
    return c.json(
      updateDiscountCode(deps.db, id, c.req.valid("json"), actor.userId, deps.now()),
      200,
    )
  })
}
