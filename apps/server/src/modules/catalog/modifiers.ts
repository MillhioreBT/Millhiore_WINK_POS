import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  type Bootstrap,
  type ModifierGroup,
  modifierGroupSchema,
  type SaveModifierGroupBody,
  saveModifierGroupSchema,
} from "@millhiore/contracts"
import {
  auditLog,
  currency,
  type Db,
  modifier,
  modifierGroup,
  productModifierGroup,
} from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Pick<Db, "select">

/** Los grupos activos que ofrece cada producto, en su orden. */
export function modifierGroupIdsByProduct(
  db: Reader,
  productIds?: readonly string[],
): Map<string, string[]> {
  const rows = db
    .select({ productId: productModifierGroup.productId, groupId: productModifierGroup.groupId })
    .from(productModifierGroup)
    .innerJoin(modifierGroup, eq(modifierGroup.id, productModifierGroup.groupId))
    .where(
      and(
        eq(modifierGroup.active, true),
        productIds && productIds.length <= 500
          ? inArray(productModifierGroup.productId, [...productIds])
          : undefined,
      ),
    )
    .orderBy(asc(productModifierGroup.position))
    .all()
  const out = new Map<string, string[]>()
  for (const r of rows) {
    const list = out.get(r.productId)
    if (list) list.push(r.groupId)
    else out.set(r.productId, [r.groupId])
  }
  return out
}

/** Deja al producto con esos grupos, en ese orden (activos y sin repetir). */
export function setProductModifierGroups(
  tx: Tx,
  productId: string,
  groupIds: readonly string[],
): void {
  if (new Set(groupIds).size !== groupIds.length) {
    throw new HttpError(422, "DUPLICATE_GROUP", "Un grupo de opciones está repetido")
  }
  if (groupIds.length) {
    const known = tx
      .select({ id: modifierGroup.id })
      .from(modifierGroup)
      .where(and(inArray(modifierGroup.id, [...groupIds]), eq(modifierGroup.active, true)))
      .all()
    if (known.length !== groupIds.length) {
      throw new HttpError(422, "UNKNOWN_GROUP", "Grupo de opciones desconocido o inactivo")
    }
  }
  tx.delete(productModifierGroup).where(eq(productModifierGroup.productId, productId)).run()
  groupIds.forEach((groupId, position) => {
    tx.insert(productModifierGroup).values({ productId, groupId, position }).run()
  })
}

/** Todos los grupos (también los desactivados), con sus opciones y cuántos productos los usan. */
export function listModifierGroups(db: Reader): ModifierGroup[] {
  const groups = db
    .select({
      id: modifierGroup.id,
      name: modifierGroup.name,
      minSelect: modifierGroup.minSelect,
      maxSelect: modifierGroup.maxSelect,
      active: modifierGroup.active,
      // Nombres explícitos: en una consulta de una sola tabla drizzle no califica las columnas.
      productCount: sql<number>`(select count(*) from "product_modifier_group" as "pmg"
        inner join "product" as "p" on "p"."id" = "pmg"."product_id"
        where "pmg"."group_id" = "modifier_group"."id" and "p"."active" = 1)`,
    })
    .from(modifierGroup)
    .orderBy(asc(modifierGroup.position), asc(modifierGroup.createdAt))
    .all()
  const options = db.select().from(modifier).orderBy(asc(modifier.position), asc(modifier.id)).all()
  return groups.map((g) => ({
    ...g,
    modifiers: options
      .filter((m) => m.groupId === g.id)
      .map((m) => ({
        id: m.id,
        name: m.name,
        priceMinor: m.priceMinor,
        priceCurrency: m.priceCurrency,
        active: m.active,
      })),
  }))
}

/** Lo que la caja necesita: los grupos activos con sus opciones activas. */
export function activeModifierGroups(db: Reader): Bootstrap["modifierGroups"] {
  return listModifierGroups(db)
    .filter((g) => g.active)
    .map(({ active: _, productCount: __, modifiers, ...g }) => ({
      ...g,
      modifiers: modifiers.filter((m) => m.active).map(({ active: ___, ...m }) => m),
    }))
}

/**
 * Crea un grupo (sin `id`) o lo deja como viene: las opciones con id se editan, las nuevas se
 * crean y las que faltan se desactivan (lo vendido conserva su nombre y su precio).
 */
export function saveModifierGroup(
  db: Db,
  id: string | null,
  body: SaveModifierGroupBody,
  actorId: string,
  now: number,
): ModifierGroup {
  return db.transaction(
    (tx) => {
      const before = id ? listModifierGroups(tx).find((g) => g.id === id) : undefined
      if (id && !before) throw new HttpError(404, "NOT_FOUND", `No existe el grupo ${id}`)
      const names = body.modifiers.map((m) => m.name.trim().toLocaleLowerCase("es"))
      if (new Set(names).size !== names.length) {
        throw new HttpError(422, "DUPLICATE_NAME", "Dos opciones del grupo se llaman igual")
      }
      for (const m of body.modifiers) {
        if (!m.priceMinor || !m.priceCurrency) continue
        if (!tx.select().from(currency).where(eq(currency.code, m.priceCurrency)).get()) {
          throw new HttpError(422, "UNKNOWN_CURRENCY", `Moneda desconocida: ${m.priceCurrency}`)
        }
      }
      const groupId = id ?? uuidv7(now)
      const values = {
        name: body.name.trim(),
        minSelect: body.minSelect,
        maxSelect: body.maxSelect,
        active: body.active,
      }
      if (id) {
        tx.update(modifierGroup).set(values).where(eq(modifierGroup.id, id)).run()
      } else {
        const count = tx.select({ n: sql<number>`count(*)` }).from(modifierGroup).get()?.n ?? 0
        tx.insert(modifierGroup)
          .values({ id: groupId, ...values, position: count, createdAt: now })
          .run()
      }
      const existing = new Map(
        tx
          .select()
          .from(modifier)
          .where(eq(modifier.groupId, groupId))
          .all()
          .map((m) => [m.id, m]),
      )
      const kept = new Set<string>()
      body.modifiers.forEach((m, position) => {
        const row = {
          name: m.name.trim(),
          priceMinor: m.priceMinor,
          priceCurrency: m.priceMinor ? (m.priceCurrency ?? null) : null,
          position,
          active: true,
        }
        if (m.id && existing.has(m.id)) {
          kept.add(m.id)
          tx.update(modifier).set(row).where(eq(modifier.id, m.id)).run()
        } else {
          tx.insert(modifier)
            .values({ id: uuidv7(now), groupId, ...row })
            .run()
        }
      })
      for (const m of existing.values()) {
        if (m.active && !kept.has(m.id)) {
          tx.update(modifier).set({ active: false }).where(eq(modifier.id, m.id)).run()
        }
      }
      const after = listModifierGroups(tx).find((g) => g.id === groupId)
      if (!after) throw new HttpError(500, "INTERNAL", "No se guardó el grupo")
      tx.insert(auditLog)
        .values({
          id: uuidv7(now),
          at: now,
          actorId,
          action: id ? "modifier-group.updated" : "modifier-group.created",
          entityType: "modifier_group",
          entityId: groupId,
          data: id ? { before, after } : after,
        })
        .run()
      return after
    },
    { behavior: "immediate" },
  )
}

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const listRoute = createRoute({
  method: "get",
  path: "/api/modifier-groups",
  tags: ["Catálogo"],
  summary: "Grupos de opciones y extras, también los desactivados",
  responses: {
    200: { description: "Grupos", content: json(z.array(modifierGroupSchema)) },
    403: { description: "Falta catalog.manage", ...err },
  },
})

const createRouteDef = createRoute({
  method: "post",
  path: "/api/modifier-groups",
  tags: ["Catálogo"],
  summary: "Crea un grupo de opciones (término, extras…)",
  request: { body: { content: json(saveModifierGroupSchema), required: true } },
  responses: {
    201: { description: "Creado", content: json(modifierGroupSchema) },
    403: { description: "Falta catalog.manage", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const saveRoute = createRoute({
  method: "put",
  path: "/api/modifier-groups/{id}",
  tags: ["Catálogo"],
  summary: "Deja el grupo y sus opciones como vienen",
  description:
    "Las opciones que faltan se desactivan: lo ya vendido conserva su nombre y su precio.",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(saveModifierGroupSchema), required: true },
  },
  responses: {
    200: { description: "Guardado", content: json(modifierGroupSchema) },
    403: { description: "Falta catalog.manage", ...err },
    404: { description: "No existe", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

export function registerModifierRoutes(app: App, deps: AppDeps): void {
  app.openapi(listRoute, (c) => {
    requirePermission(c, "catalog.manage")
    return c.json(listModifierGroups(deps.db), 200)
  })

  app.openapi(createRouteDef, (c) => {
    const actor = requirePermission(c, "catalog.manage")
    return c.json(
      saveModifierGroup(deps.db, null, c.req.valid("json"), actor.userId, deps.now()),
      201,
    )
  })

  app.openapi(saveRoute, (c) => {
    const actor = requirePermission(c, "catalog.manage")
    const { id } = c.req.valid("param")
    return c.json(
      saveModifierGroup(deps.db, id, c.req.valid("json"), actor.userId, deps.now()),
      200,
    )
  })
}
