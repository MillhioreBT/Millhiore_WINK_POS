import { createRoute, z } from "@hono/zod-openapi"
import { apiErrorSchema } from "@millhiore/contracts"
import { auditLog, type Db, product, productImage } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"

const err = { content: { "application/json": { schema: apiErrorSchema } } }

/** La foto llega achicada del navegador (unos 150 KB); un mega es de sobra. */
export const MAX_IMAGE_BYTES = 1_000_000

export type ImageMime = (typeof productImage.$inferSelect)["mime"]

/** El formato por sus primeros bytes (no por lo que diga quien la manda); null si no es foto. */
export function imageMime(bytes: Uint8Array): ImageMime | null {
  const at = (i: number, ...expected: number[]) => expected.every((b, j) => bytes[i + j] === b)
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg"
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png"
  // RIFF....WEBP
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp"
  return null
}

export function productImageRow(db: Pick<Db, "select">, productId: string) {
  return db.select().from(productImage).where(eq(productImage.productId, productId)).get()
}

function requireProduct(db: Pick<Db, "select">, productId: string): void {
  if (!db.select({ id: product.id }).from(product).where(eq(product.id, productId)).get()) {
    throw new HttpError(404, "NOT_FOUND", `No existe el producto ${productId}`)
  }
}

function audit(
  db: Pick<Db, "insert">,
  actorId: string,
  now: number,
  action: string,
  id: string,
  data: unknown,
) {
  db.insert(auditLog)
    .values({
      id: uuidv7(now),
      at: now,
      actorId,
      action,
      entityType: "product",
      entityId: id,
      data,
    })
    .run()
}

/** Pone (o cambia) la foto del producto. Devuelve su versión nueva. */
export function setProductImage(
  db: Db,
  productId: string,
  bytes: Uint8Array,
  actorId: string,
  now: number,
): number {
  if (bytes.byteLength === 0) throw new HttpError(422, "INVALID_IMAGE", "Falta la foto")
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new HttpError(413, "IMAGE_TOO_LARGE", "La foto pesa más de 1 MB")
  }
  const mime = imageMime(bytes)
  if (!mime) throw new HttpError(422, "INVALID_IMAGE", "La foto tiene que ser JPEG, PNG o WebP")
  return db.transaction(
    (tx) => {
      requireProduct(tx, productId)
      const old = productImageRow(tx, productId)
      // La versión va en la dirección de la foto: nunca se repite, aunque cambie dos veces seguidas.
      const version = old ? Math.max(now, old.updatedAt + 1) : now
      const data = Buffer.from(bytes)
      tx.insert(productImage)
        .values({ productId, mime, data, updatedAt: version })
        .onConflictDoUpdate({
          target: productImage.productId,
          set: { mime, data, updatedAt: version },
        })
        .run()
      audit(tx, actorId, now, old ? "product.image.updated" : "product.image.added", productId, {
        bytes: bytes.byteLength,
        mime,
      })
      return version
    },
    { behavior: "immediate" },
  )
}

export function removeProductImage(db: Db, productId: string, actorId: string, now: number): void {
  db.transaction(
    (tx) => {
      requireProduct(tx, productId)
      const removed = tx
        .delete(productImage)
        .where(eq(productImage.productId, productId))
        .returning({ productId: productImage.productId })
        .all()
      if (removed.length) audit(tx, actorId, now, "product.image.removed", productId, null)
    },
    { behavior: "immediate" },
  )
}

/**
 * La foto tal como se guardó, con lo necesario para que el navegador la guarde (la versión va en
 * la dirección) y no la interprete como otra cosa.
 */
export function imageResponse(
  row: { mime: string; data: Uint8Array; updatedAt: number },
  version: string | undefined,
  scope: "public" | "private",
): Response {
  const fresh = version === String(row.updatedAt)
  return new Response(new Uint8Array(row.data), {
    headers: {
      "content-type": row.mime,
      "content-length": String(row.data.byteLength),
      "cache-control": fresh ? `${scope}, max-age=31536000, immutable` : "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  })
}

const params = z.object({ id: z.string().min(1) })
const binary = { schema: { type: "string" as const, format: "binary" } }

const putRoute = createRoute({
  method: "put",
  path: "/api/products/{id}/image",
  tags: ["Catálogo"],
  summary: "Pone o cambia la foto del producto (JPEG, PNG o WebP, hasta 1 MB)",
  request: {
    params,
    body: { content: { "image/jpeg": binary, "image/png": binary, "image/webp": binary } },
  },
  responses: {
    200: {
      description: "Guardada",
      content: { "application/json": { schema: z.object({ imageVersion: z.number().int() }) } },
    },
    403: { description: "Falta catalog.manage", ...err },
    404: { description: "No existe", ...err },
    413: { description: "Pesa más de 1 MB", ...err },
    422: { description: "No es una foto", ...err },
  },
})

const deleteRoute = createRoute({
  method: "delete",
  path: "/api/products/{id}/image",
  tags: ["Catálogo"],
  summary: "Quita la foto del producto",
  request: { params },
  responses: {
    204: { description: "Quitada" },
    403: { description: "Falta catalog.manage", ...err },
    404: { description: "No existe", ...err },
  },
})

const getRoute = createRoute({
  method: "get",
  path: "/api/products/{id}/image",
  tags: ["Catálogo"],
  summary: "La foto del producto",
  request: { params, query: z.object({ v: z.string().max(20).optional() }) },
  responses: {
    200: { description: "Foto", content: { "image/jpeg": binary } },
    404: { description: "No tiene foto", ...err },
  },
})

export function registerProductImageRoutes(app: App, deps: AppDeps): void {
  app.openapi(putRoute, async (c) => {
    const actor = requirePermission(c, "catalog.manage")
    const declared = Number(c.req.header("content-length") ?? 0)
    if (declared > MAX_IMAGE_BYTES) {
      throw new HttpError(413, "IMAGE_TOO_LARGE", "La foto pesa más de 1 MB")
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const { id } = c.req.valid("param")
    const imageVersion = setProductImage(deps.db, id, bytes, actor.userId, deps.now())
    return c.json({ imageVersion }, 200)
  })

  app.openapi(deleteRoute, (c) => {
    const actor = requirePermission(c, "catalog.manage")
    removeProductImage(deps.db, c.req.valid("param").id, actor.userId, deps.now())
    return c.body(null, 204)
  })

  app.openapi(getRoute, (c) => {
    actorOf(c)
    const row = productImageRow(deps.db, c.req.valid("param").id)
    if (!row) throw new HttpError(404, "NOT_FOUND", "El producto no tiene foto")
    return imageResponse(row, c.req.valid("query").v, "private") as never
  })
}
