import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  type Bootstrap,
  createPriceListSchema,
  type PriceList,
  priceListSchema,
  updatePriceListSchema,
} from "@millhiore/contracts"
import { auditLog, type Db, priceList, priceListPrice } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, asc, eq, sql } from "drizzle-orm"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const columns = {
  id: priceList.id,
  name: priceList.name,
  adjustBp: priceList.adjustBp,
  position: priceList.position,
  active: priceList.active,
  // Nombres explícitos: en una consulta de una sola tabla drizzle no califica las columnas.
  priceCount: sql<number>`(select count(*) from "price_list_price" as "lp"
    where "lp"."price_list_id" = "price_list"."id")`,
  customerCount: sql<number>`(select count(*) from "contact" as "c"
    where "c"."price_list_id" = "price_list"."id" and "c"."active" = 1)`,
}

export function listPriceLists(db: Db, opts: { all?: boolean } = {}): PriceList[] {
  return db
    .select(columns)
    .from(priceList)
    .where(opts.all ? undefined : eq(priceList.active, true))
    .orderBy(asc(priceList.position), asc(priceList.name))
    .all()
}

function priceListById(db: Db, id: string): PriceList {
  const row = db.select(columns).from(priceList).where(eq(priceList.id, id)).get()
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe la lista de precios ${id}`)
  return row
}

/** Las listas activas con los precios propios de cada producto, para la caja. */
export function priceListsForPos(db: Db): Bootstrap["priceLists"] {
  const lists = db
    .select({ id: priceList.id, name: priceList.name, adjustBp: priceList.adjustBp })
    .from(priceList)
    .where(eq(priceList.active, true))
    .orderBy(asc(priceList.position), asc(priceList.name))
    .all()
  const prices = db.select().from(priceListPrice).all()
  return lists.map((l) => ({
    ...l,
    prices: prices
      .filter((p) => p.priceListId === l.id)
      .map((p) => ({
        variantId: p.variantId,
        priceMinor: p.priceMinor,
        priceCurrency: p.priceCurrency,
      })),
  }))
}

/** La lista existe y está activa: se valida antes de asignarla a un cliente o fijar un precio. */
export function requireActivePriceList(db: Pick<Db, "select">, id: string): void {
  const row = db
    .select({ id: priceList.id })
    .from(priceList)
    .where(and(eq(priceList.id, id), eq(priceList.active, true)))
    .get()
  if (!row) {
    throw new HttpError(422, "UNKNOWN_PRICE_LIST", `Lista de precios desconocida o inactiva: ${id}`)
  }
}

/**
 * Fija (o quita, con null) el precio propio de una variante en cada lista indicada, en la moneda
 * de su precio base. Las listas que no se mencionan no cambian. Devuelve los precios de antes y
 * de después para la bitácora del producto.
 */
export function setListPrices(
  tx: Tx,
  variantId: string,
  currency: string,
  prices: readonly { priceListId: string; priceMinor: number | null }[],
): { before: Record<string, number | null>; after: Record<string, number | null> } {
  const before: Record<string, number | null> = {}
  const after: Record<string, number | null> = {}
  const seen = new Set<string>()
  for (const p of prices) {
    if (seen.has(p.priceListId)) {
      throw new HttpError(422, "DUPLICATE_PRICE_LIST", "Una lista aparece dos veces")
    }
    seen.add(p.priceListId)
    requireActivePriceList(tx, p.priceListId)
    const key = and(
      eq(priceListPrice.priceListId, p.priceListId),
      eq(priceListPrice.variantId, variantId),
    )
    const old = tx.select().from(priceListPrice).where(key).get()
    before[p.priceListId] = old?.priceMinor ?? null
    after[p.priceListId] = p.priceMinor
    if (p.priceMinor === null) {
      if (old) tx.delete(priceListPrice).where(key).run()
    } else {
      tx.insert(priceListPrice)
        .values({
          priceListId: p.priceListId,
          variantId,
          priceMinor: p.priceMinor,
          priceCurrency: currency,
        })
        .onConflictDoUpdate({
          target: [priceListPrice.priceListId, priceListPrice.variantId],
          set: { priceMinor: p.priceMinor, priceCurrency: currency },
        })
        .run()
    }
  }
  return { before, after }
}

function duplicate(e: unknown): never {
  if (/UNIQUE/i.test(String((e as Error).cause ?? (e as Error).message))) {
    throw new HttpError(409, "DUPLICATE_NAME", "Ya existe una lista con ese nombre")
  }
  throw e
}

function audit(db: Db, actorId: string, now: number, action: string, id: string, data: unknown) {
  db.insert(auditLog)
    .values({
      id: uuidv7(now),
      at: now,
      actorId,
      action,
      entityType: "price-list",
      entityId: id,
      data,
    })
    .run()
}

const listRoute = createRoute({
  method: "get",
  path: "/api/price-lists",
  tags: ["Catálogo"],
  summary: "Listas de precios (al mayor, revendedores…)",
  request: { query: z.object({ all: z.enum(["true", "false"]).optional() }) },
  responses: { 200: { description: "Listas", content: json(z.array(priceListSchema)) } },
})

const createRouteDef = createRoute({
  method: "post",
  path: "/api/price-lists",
  tags: ["Catálogo"],
  summary: "Crea una lista de precios",
  request: { body: { content: json(createPriceListSchema), required: true } },
  responses: {
    201: { description: "Creada", content: json(priceListSchema) },
    403: { description: "Falta catalog.manage", ...err },
    409: { description: "Nombre repetido", ...err },
  },
})

const updateRoute = createRoute({
  method: "patch",
  path: "/api/price-lists/{id}",
  tags: ["Catálogo"],
  summary: "Renombra, cambia el ajuste, reordena o desactiva una lista",
  description:
    "Desactivarla no borra sus precios: la caja deja de ofrecerla y sus clientes compran a precio base.",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(updatePriceListSchema), required: true },
  },
  responses: {
    200: { description: "Guardada", content: json(priceListSchema) },
    403: { description: "Falta catalog.manage", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Nombre repetido", ...err },
  },
})

export function registerPriceListRoutes(app: App, deps: AppDeps): void {
  app.openapi(listRoute, (c) => {
    actorOf(c)
    return c.json(listPriceLists(deps.db, { all: c.req.valid("query").all === "true" }), 200)
  })

  app.openapi(createRouteDef, (c) => {
    const actor = requirePermission(c, "catalog.manage")
    const body = c.req.valid("json")
    const now = deps.now()
    const id = uuidv7(now)
    try {
      const last = deps.db
        .select({ max: sql<number>`coalesce(max(${priceList.position}), 0)` })
        .from(priceList)
        .get()
      deps.db
        .insert(priceList)
        .values({ id, name: body.name, adjustBp: body.adjustBp, position: (last?.max ?? 0) + 1 })
        .run()
    } catch (e) {
      duplicate(e)
    }
    const created = priceListById(deps.db, id)
    audit(deps.db, actor.userId, now, "price-list.created", id, created)
    return c.json(created, 201)
  })

  app.openapi(updateRoute, (c) => {
    const actor = requirePermission(c, "catalog.manage")
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")
    const before = priceListById(deps.db, id)
    const set = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.adjustBp !== undefined ? { adjustBp: patch.adjustBp } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    }
    try {
      if (Object.keys(set).length) {
        deps.db.update(priceList).set(set).where(eq(priceList.id, id)).run()
      }
    } catch (e) {
      duplicate(e)
    }
    const after = priceListById(deps.db, id)
    audit(deps.db, actor.userId, deps.now(), "price-list.updated", id, { before, after })
    return c.json(after, 200)
  })
}
