import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  type Category,
  categorySchema,
  createCategorySchema,
  updateCategorySchema,
} from "@millhiore/contracts"
import { auditLog, category, type Db } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, asc, eq, sql } from "drizzle-orm"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const columns = {
  id: category.id,
  name: category.name,
  position: category.position,
  active: category.active,
  // Nombres explícitos: en una consulta de una sola tabla drizzle no califica las columnas y el
  // `id` de la subconsulta se confundiría con el del producto.
  productCount: sql<number>`(select count(*) from "product" as "p"
    where "p"."category_id" = "category"."id" and "p"."active" = 1)`,
}

export function listCategories(db: Db, opts: { all?: boolean } = {}): Category[] {
  return db
    .select(columns)
    .from(category)
    .where(opts.all ? undefined : eq(category.active, true))
    .orderBy(asc(category.position), asc(category.name))
    .all()
}

function categoryById(db: Db, id: string): Category {
  const row = db.select(columns).from(category).where(eq(category.id, id)).get()
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe la categoría ${id}`)
  return row
}

function duplicate(e: unknown): never {
  if (/UNIQUE/i.test(String((e as Error).cause ?? (e as Error).message))) {
    throw new HttpError(409, "DUPLICATE_NAME", "Ya existe una categoría con ese nombre")
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
      entityType: "category",
      entityId: id,
      data,
    })
    .run()
}

export function createCategory(db: Db, name: string, actorId: string, now: number): Category {
  const id = uuidv7(now)
  try {
    const last = db
      .select({ max: sql<number>`coalesce(max(${category.position}), 0)` })
      .from(category)
      .get()
    db.insert(category)
      .values({ id, name, position: (last?.max ?? 0) + 1 })
      .run()
  } catch (e) {
    duplicate(e)
  }
  const created = categoryById(db, id)
  audit(db, actorId, now, "category.created", id, created)
  return created
}

export function updateCategory(
  db: Db,
  id: string,
  patch: { name?: string | undefined; position?: number | undefined; active?: boolean | undefined },
  actorId: string,
  now: number,
): Category {
  const before = categoryById(db, id)
  const set = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.position !== undefined ? { position: patch.position } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
  }
  try {
    if (Object.keys(set).length) db.update(category).set(set).where(eq(category.id, id)).run()
  } catch (e) {
    duplicate(e)
  }
  const after = categoryById(db, id)
  audit(db, actorId, now, "category.updated", id, { before, after })
  return after
}

/** La categoría existe y está activa: se valida antes de asignarla a un producto. */
export function requireActiveCategory(db: Pick<Db, "select">, id: string): void {
  const row = db
    .select({ id: category.id })
    .from(category)
    .where(and(eq(category.id, id), eq(category.active, true)))
    .get()
  if (!row) throw new HttpError(422, "UNKNOWN_CATEGORY", `Categoría desconocida o inactiva: ${id}`)
}

const listRoute = createRoute({
  method: "get",
  path: "/api/categories",
  tags: ["Catálogo"],
  summary: "Categorías de productos",
  request: { query: z.object({ all: z.enum(["true", "false"]).optional() }) },
  responses: { 200: { description: "Categorías", content: json(z.array(categorySchema)) } },
})

const createRouteDef = createRoute({
  method: "post",
  path: "/api/categories",
  tags: ["Catálogo"],
  summary: "Crea una categoría",
  request: { body: { content: json(createCategorySchema), required: true } },
  responses: {
    201: { description: "Creada", content: json(categorySchema) },
    403: { description: "Falta catalog.manage", ...err },
    409: { description: "Nombre repetido", ...err },
  },
})

const updateRoute = createRoute({
  method: "patch",
  path: "/api/categories/{id}",
  tags: ["Catálogo"],
  summary: "Renombra, reordena o desactiva una categoría",
  description:
    "Desactivarla no borra nada: sus productos conservan la categoría, que deja de ofrecerse.",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(updateCategorySchema), required: true },
  },
  responses: {
    200: { description: "Guardada", content: json(categorySchema) },
    403: { description: "Falta catalog.manage", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Nombre repetido", ...err },
  },
})

export function registerCategoryRoutes(app: App, deps: AppDeps): void {
  app.openapi(listRoute, (c) => {
    actorOf(c)
    return c.json(listCategories(deps.db, { all: c.req.valid("query").all === "true" }), 200)
  })

  app.openapi(createRouteDef, (c) => {
    const actor = requirePermission(c, "catalog.manage")
    const { name } = c.req.valid("json")
    return c.json(createCategory(deps.db, name, actor.userId, deps.now()), 201)
  })

  app.openapi(updateRoute, (c) => {
    const actor = requirePermission(c, "catalog.manage")
    const { id } = c.req.valid("param")
    return c.json(updateCategory(deps.db, id, c.req.valid("json"), actor.userId, deps.now()), 200)
  })
}
