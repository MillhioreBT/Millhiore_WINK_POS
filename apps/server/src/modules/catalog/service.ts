import type { CatalogItem, CreateProductBody, UpdateProductBody } from "@millhiore/contracts"
import {
  auditLog,
  business,
  currency,
  type Db,
  lot,
  lotBalance,
  product,
  stockBalance,
  tax,
  variant,
} from "@millhiore/db"
import { localDate, uuidv7 } from "@millhiore/domain"
import { and, asc, eq, gt, inArray, like, or, sql } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { requireActiveCategory } from "./categories"
import { setListPrices } from "./priceLists"

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
  tracksLots: product.tracksLots,
  active: product.active,
  costMinor: variant.costMinor,
  costCurrency: variant.costCurrency,
  stockMilli: sql<number>`coalesce((select sum(${stockBalance.qtyMilli}) from ${stockBalance}
    where ${stockBalance.variantId} = ${variant.id}), 0)`,
  minStockMilli: variant.minStockMilli,
}

type Row = Omit<CatalogItem, "stockByLocation" | "expiry">

/**
 * Agrega a cada producto lo que hay en cada ubicación (la caja vende de la suya) y, si lleva
 * lotes, su próximo vencimiento y lo vencido en cada ubicación.
 */
function withStock(db: Db | Tx, rows: Row[], now: number): CatalogItem[] {
  const ids = rows.map((r) => r.variantId)
  const byVariant = new Map<string, Record<string, number>>()
  const balances =
    ids.length === 0
      ? []
      : db
          .select()
          .from(stockBalance)
          .where(ids.length > 500 ? undefined : inArray(stockBalance.variantId, ids))
          .all()
  for (const b of balances) {
    const entry = byVariant.get(b.variantId) ?? {}
    entry[b.locationId] = b.qtyMilli
    byVariant.set(b.variantId, entry)
  }
  const withLots = rows.filter((r) => r.tracksLots).map((r) => r.variantId)
  const lots =
    withLots.length === 0
      ? []
      : db
          .select({
            variantId: lot.variantId,
            expiresOn: lot.expiresOn,
            locationId: lotBalance.locationId,
            qtyMilli: lotBalance.qtyMilli,
          })
          .from(lotBalance)
          .innerJoin(lot, eq(lot.id, lotBalance.lotId))
          .where(
            and(
              gt(lotBalance.qtyMilli, 0),
              withLots.length > 500 ? undefined : inArray(lot.variantId, withLots),
            ),
          )
          .all()
  const tz = db.select({ tz: business.timezone }).from(business).get()?.tz ?? "America/Caracas"
  const today = localDate(now, tz)
  const expiryOf = (variantId: string): CatalogItem["expiry"] => {
    const own = lots.filter((l) => l.variantId === variantId)
    const expiredByLocation: Record<string, number> = {}
    let nextExpiresOn: string | null = null
    for (const l of own) {
      if (l.expiresOn === null) continue
      if (l.expiresOn < today) {
        expiredByLocation[l.locationId] = (expiredByLocation[l.locationId] ?? 0) + l.qtyMilli
      } else if (nextExpiresOn === null || l.expiresOn < nextExpiresOn) {
        nextExpiresOn = l.expiresOn
      }
    }
    return { nextExpiresOn, expiredByLocation }
  }
  return rows.map((r) => ({
    ...r,
    stockByLocation: byVariant.get(r.variantId) ?? {},
    expiry: r.tracksLots ? expiryOf(r.variantId) : null,
  }))
}

/** Productos con su variante de venta y la existencia total, ordenados por nombre. */
export function listItems(
  db: Db | Tx,
  opts: {
    search?: string | undefined
    includeInactive?: boolean | undefined
    /** Para saber qué lotes ya vencieron. */
    now?: number | undefined
  } = {},
): CatalogItem[] {
  const term = opts.search?.trim()
  const filters = [
    opts.includeInactive ? undefined : eq(product.active, true),
    term
      ? or(like(product.name, `%${term}%`), eq(variant.sku, term), eq(variant.barcode, term))
      : undefined,
  ].filter((f) => f !== undefined)
  return withStock(
    db,
    db
      .select(itemColumns)
      .from(product)
      .innerJoin(variant, eq(variant.productId, product.id))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(product.name))
      .all(),
    opts.now ?? Date.now(),
  )
}

function itemById(db: Db | Tx, productId: string): CatalogItem {
  const row = db
    .select(itemColumns)
    .from(product)
    .innerJoin(variant, eq(variant.productId, product.id))
    .where(eq(product.id, productId))
    .get()
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe el producto ${productId}`)
  return withStock(db, [row], Date.now())[0] ?? { ...row, stockByLocation: {}, expiry: null }
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
      if (input.tracksLots && input.kind !== "good") {
        throw new HttpError(422, "INVALID_LOTS", "Un servicio no lleva lotes")
      }
      const productId = uuidv7(now)
      const variantId = uuidv7(now)
      try {
        tx.insert(product)
          .values({
            id: productId,
            name: input.name,
            kind: input.kind,
            tracksStock: input.kind === "good",
            tracksLots: input.kind === "good" && input.tracksLots,
            taxId: input.taxId ?? null,
            categoryId: input.categoryId ?? null,
            createdAt: now,
          })
          .run()
        tx.insert(variant)
          .values({
            id: variantId,
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
      const listPrices = input.listPrices?.length
        ? setListPrices(tx, variantId, input.priceCurrency, input.listPrices).after
        : undefined
      const item = itemById(tx, productId)
      audit(tx, actorId, now, "product.created", productId, { ...item, listPrices })
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
      if (patch.tracksLots && !before.tracksStock) {
        throw new HttpError(422, "INVALID_LOTS", "Un servicio no lleva lotes")
      }
      const productSet = {
        ...(patch.tracksLots !== undefined ? { tracksLots: patch.tracksLots } : {}),
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
      // Los precios propios por lista van en la moneda del precio base (la nueva, si cambió).
      const listPrices = patch.listPrices?.length
        ? setListPrices(
            tx,
            before.variantId,
            patch.priceCurrency ?? before.priceCurrency,
            patch.listPrices,
          )
        : undefined
      const after = itemById(tx, productId)
      audit(tx, actorId, now, "product.updated", productId, {
        before: listPrices ? { ...before, listPrices: listPrices.before } : before,
        after: listPrices ? { ...after, listPrices: listPrices.after } : after,
      })
      return after
    },
    { behavior: "immediate" },
  )
}
