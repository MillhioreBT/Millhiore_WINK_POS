import type { CatalogItem, CreateProductBody, UpdateProductBody } from "@millhiore/contracts"
import { auditLog, currency, type Db, product, stockBalance, tax, variant } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, asc, eq, like, or, sql } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { requireActiveCategory } from "./categories"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

const itemColumns = {
  productId: product.id,
  variantId: variant.id,
  name: product.name,
  kind: product.kind,
  sku: variant.sku,
  barcode: variant.barcode,
  priceMinor: variant.priceMinor,
  priceCurrency: variant.priceCurrency,
  taxId: product.taxId,
  categoryId: product.categoryId,
  tracksStock: product.tracksStock,
  active: product.active,
  costMinor: variant.costMinor,
  costCurrency: variant.costCurrency,
  stockMilli: sql<number>`coalesce((select sum(${stockBalance.qtyMilli}) from ${stockBalance}
    where ${stockBalance.variantId} = ${variant.id}), 0)`,
  minStockMilli: variant.minStockMilli,
}

/** Productos con su variante de venta y la existencia total, ordenados por nombre. */
export function listItems(
  db: Db | Tx,
  opts: { search?: string | undefined; includeInactive?: boolean | undefined } = {},
): CatalogItem[] {
  const term = opts.search?.trim()
  const filters = [
    opts.includeInactive ? undefined : eq(product.active, true),
    term
      ? or(like(product.name, `%${term}%`), eq(variant.sku, term), eq(variant.barcode, term))
      : undefined,
  ].filter((f) => f !== undefined)
  return db
    .select(itemColumns)
    .from(product)
    .innerJoin(variant, eq(variant.productId, product.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(product.name))
    .all()
}

function itemById(db: Db | Tx, productId: string): CatalogItem {
  const row = db
    .select(itemColumns)
    .from(product)
    .innerJoin(variant, eq(variant.productId, product.id))
    .where(eq(product.id, productId))
    .get()
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe el producto ${productId}`)
  return row
}

function checkReferences(
  tx: Tx,
  input: { taxId?: string | null; priceCurrency?: string; categoryId?: string | null },
) {
  if (input.categoryId) requireActiveCategory(tx, input.categoryId)
  if (input.taxId) {
    const t = tx.select().from(tax).where(eq(tax.id, input.taxId)).get()
    if (!t?.active) throw new HttpError(422, "UNKNOWN_TAX", `Impuesto desconocido: ${input.taxId}`)
  }
  if (input.priceCurrency) {
    const c = tx.select().from(currency).where(eq(currency.code, input.priceCurrency)).get()
    if (!c)
      throw new HttpError(422, "UNKNOWN_CURRENCY", `Moneda desconocida: ${input.priceCurrency}`)
  }
}

/** SKU legible cuando no se indica: P00001, P00002… */
function nextSku(tx: Tx): string {
  const n = tx.all<{ n: number }>(sql`select count(*) as n from variant`)[0]?.n ?? 0
  for (let i = n + 1; ; i++) {
    const sku = `P${String(i).padStart(5, "0")}`
    if (!tx.select({ id: variant.id }).from(variant).where(eq(variant.sku, sku)).get()) return sku
  }
}

/** SQLite rechaza SKU o código de barras repetidos con UNIQUE: se traduce a un 409 claro. */
function duplicateCode(e: unknown): never {
  const text = String((e as Error).cause ?? (e as Error).message)
  if (/UNIQUE/i.test(text)) {
    const field = /barcode/.test(text) ? "código de barras" : "SKU"
    throw new HttpError(409, "DUPLICATE_CODE", `Ya existe otro producto con ese ${field}`)
  }
  throw e
}

function audit(tx: Tx, actorId: string, now: number, action: string, id: string, data: unknown) {
  tx.insert(auditLog)
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

export function createProduct(
  db: Db,
  input: CreateProductBody,
  actorId: string,
  now: number,
): CatalogItem {
  return db.transaction(
    (tx) => {
      checkReferences(tx, {
        ...(input.taxId ? { taxId: input.taxId } : {}),
        ...(input.categoryId ? { categoryId: input.categoryId } : {}),
        priceCurrency: input.priceCurrency,
      })
      const productId = uuidv7(now)
      try {
        tx.insert(product)
          .values({
            id: productId,
            name: input.name,
            kind: input.kind,
            tracksStock: input.kind === "good",
            taxId: input.taxId ?? null,
            categoryId: input.categoryId ?? null,
            createdAt: now,
          })
          .run()
        tx.insert(variant)
          .values({
            id: uuidv7(now),
            productId,
            sku: input.sku ?? nextSku(tx),
            barcode: input.barcode ?? null,
            name: input.name,
            priceMinor: input.priceMinor,
            priceCurrency: input.priceCurrency,
            minStockMilli: input.kind === "good" ? (input.minStockMilli ?? null) : null,
            createdAt: now,
          })
          .run()
      } catch (e) {
        duplicateCode(e)
      }
      const item = itemById(tx, productId)
      audit(tx, actorId, now, "product.created", productId, item)
      return item
    },
    { behavior: "immediate" },
  )
}

/** Edita el producto y su variante de venta. Los cambios de precio quedan en la auditoría. */
export function updateProduct(
  db: Db,
  productId: string,
  patch: UpdateProductBody,
  actorId: string,
  now: number,
): CatalogItem {
  return db.transaction(
    (tx) => {
      const before = itemById(tx, productId)
      checkReferences(tx, {
        ...(patch.taxId ? { taxId: patch.taxId } : {}),
        ...(patch.categoryId ? { categoryId: patch.categoryId } : {}),
        ...(patch.priceCurrency ? { priceCurrency: patch.priceCurrency } : {}),
      })
      const productSet = {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.taxId !== undefined ? { taxId: patch.taxId } : {}),
        ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
      }
      const variantSet = {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.sku !== undefined ? { sku: patch.sku } : {}),
        ...(patch.barcode !== undefined ? { barcode: patch.barcode } : {}),
        ...(patch.priceMinor !== undefined ? { priceMinor: patch.priceMinor } : {}),
        ...(patch.priceCurrency !== undefined ? { priceCurrency: patch.priceCurrency } : {}),
        ...(patch.minStockMilli !== undefined && before.tracksStock
          ? { minStockMilli: patch.minStockMilli }
          : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
      }
      try {
        if (Object.keys(productSet).length) {
          tx.update(product).set(productSet).where(eq(product.id, productId)).run()
        }
        if (Object.keys(variantSet).length) {
          tx.update(variant).set(variantSet).where(eq(variant.id, before.variantId)).run()
        }
      } catch (e) {
        duplicateCode(e)
      }
      const after = itemById(tx, productId)
      audit(tx, actorId, now, "product.updated", productId, { before, after })
      return after
    },
    { behavior: "immediate" },
  )
}
