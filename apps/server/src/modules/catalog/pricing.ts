import type { BulkPriceBody, BulkPriceResult } from "@millhiore/contracts"
import { auditLog, category, currency, type Db, product, tax, variant } from "@millhiore/db"
import {
  type Currency,
  convertExact,
  exchangeRate,
  markupPrice,
  percentPrice,
  roundingStep,
  uuidv7,
} from "@millhiore/domain"
import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { getBusinessPair, rateAt } from "../rates/service"
import { fiscalSettings } from "../settings/service"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** Un monto convertido sin redondear (lo que devuelve `convertExact`). */
type ExactMinor = ReturnType<typeof convertExact>["amountMinor"]

/** Cuántos cambios se devuelven para mostrar; los conteos siempre son de todos. */
const MAX_ROWS = 500

interface Change {
  productId: string
  variantId: string
  name: string
  sku: string
  currency: string
  beforeMinor: number
  afterMinor: number
}

/** Los productos del alcance pedido: los indicados, los de una categoría o todos los activos. */
function selectRows(tx: Tx, body: BulkPriceBody) {
  if (body.categoryId && body.categoryId !== "none") {
    const exists = tx
      .select({ id: category.id })
      .from(category)
      .where(eq(category.id, body.categoryId))
      .get()
    if (!exists) throw new HttpError(404, "NOT_FOUND", "No existe esa categoría")
  }
  const filters = [
    body.variantIds ? inArray(variant.id, body.variantIds) : eq(product.active, true),
    body.categoryId === "none"
      ? isNull(product.categoryId)
      : body.categoryId
        ? eq(product.categoryId, body.categoryId)
        : undefined,
  ].filter((f) => f !== undefined)
  return tx
    .select({
      productId: product.id,
      variantId: variant.id,
      name: product.name,
      sku: variant.sku,
      taxId: product.taxId,
      priceMinor: variant.priceMinor,
      priceCurrency: variant.priceCurrency,
      costMinor: variant.costMinor,
      costCurrency: variant.costCurrency,
    })
    .from(product)
    .innerJoin(variant, eq(variant.productId, product.id))
    .where(and(...filters))
    .orderBy(asc(product.name))
    .all()
}

function compute(tx: Tx, body: BulkPriceBody, now: number) {
  const fiscal = fiscalSettings(tx)
  const currencies = new Map<string, Currency>(
    tx
      .select()
      .from(currency)
      .all()
      .map((c) => [c.code, { code: c.code, decimals: c.decimals }]),
  )
  // El IVA solo se suma si los precios lo incluyen y el negocio lo cobra.
  const addsTax = fiscal.pricesIncludeTax && fiscal.taxpayer !== "none"
  const taxRates = new Map(
    tx
      .select()
      .from(tax)
      .all()
      .map((t) => [t.id, t.kind === "taxed" ? t.rateBp : 0]),
  )
  const pair = getBusinessPair(tx)
  const stored = pair ? rateAt(tx, pair.base, pair.quote, now) : undefined
  const rate = stored ? exchangeRate(stored.base, stored.quote, stored.value) : null

  /** El costo en la moneda del precio, exacto; null si no hay cómo convertirlo. */
  const costIn = (minor: number, from: string, to: string): ExactMinor | number | null => {
    if (from === to) return minor
    if (!rate) return null
    const base = currencies.get(rate.base)
    const quote = currencies.get(rate.quote)
    const pairOk =
      (from === rate.base && to === rate.quote) || (from === rate.quote && to === rate.base)
    if (!base || !quote || !pairOk) return null
    return convertExact({ amountMinor: minor, currency: from }, rate, { base, quote }).amountMinor
  }

  const changes: Change[] = []
  let unchanged = 0
  let skippedNoCost = 0
  let skippedNoRate = 0
  for (const row of selectRows(tx, body)) {
    const step = roundingStep(body.rounding, currencies.get(row.priceCurrency)?.decimals ?? 2)
    let afterMinor: number
    if (body.mode === "percent") {
      afterMinor = percentPrice(row.priceMinor, body.valueBp, step)
    } else {
      if (row.costMinor === null || row.costCurrency === null || row.costMinor <= 0) {
        skippedNoCost++
        continue
      }
      const cost = costIn(row.costMinor, row.costCurrency, row.priceCurrency)
      if (!cost) {
        skippedNoRate++
        continue
      }
      const taxRateBp = addsTax ? (taxRates.get(row.taxId ?? fiscal.defaultTaxId) ?? 0) : 0
      afterMinor = markupPrice(cost, body.valueBp, taxRateBp, step)
    }
    if (afterMinor === row.priceMinor) {
      unchanged++
      continue
    }
    changes.push({
      productId: row.productId,
      variantId: row.variantId,
      name: row.name,
      sku: row.sku,
      currency: row.priceCurrency,
      beforeMinor: row.priceMinor,
      afterMinor,
    })
  }
  return { changes, unchanged, skippedNoCost, skippedNoRate }
}

/**
 * Cambio masivo de precios. Con `apply: false` solo calcula; con `apply: true` guarda todo en una
 * transacción y deja una sola entrada en la bitácora con los precios de antes (para poder volver
 * atrás). Lo ya vendido no cambia: los documentos guardan su propio precio.
 */
export function bulkReprice(
  db: Db,
  body: BulkPriceBody,
  actorId: string,
  now: number,
): BulkPriceResult {
  return db.transaction(
    (tx) => {
      const r = compute(tx, body, now)
      if (body.apply && r.changes.length) {
        for (const c of r.changes) {
          tx.update(variant)
            .set({ priceMinor: c.afterMinor })
            .where(eq(variant.id, c.variantId))
            .run()
        }
        tx.insert(auditLog)
          .values({
            id: uuidv7(now),
            at: now,
            actorId,
            action: "product.prices.bulk",
            entityType: "product",
            entityId: uuidv7(now),
            data: {
              mode: body.mode,
              valueBp: body.valueBp,
              rounding: body.rounding,
              categoryId: body.categoryId ?? null,
              count: r.changes.length,
              changes: r.changes.map((c) => ({
                variantId: c.variantId,
                name: c.name,
                currency: c.currency,
                beforeMinor: c.beforeMinor,
                afterMinor: c.afterMinor,
              })),
            },
          })
          .run()
      }
      return {
        applied: body.apply && r.changes.length > 0,
        changed: r.changes.length,
        unchanged: r.unchanged,
        skipped: r.skippedNoCost + r.skippedNoRate,
        skippedNoCost: r.skippedNoCost,
        skippedNoRate: r.skippedNoRate,
        changes: r.changes.slice(0, MAX_ROWS),
      }
    },
    { behavior: body.apply ? "immediate" : "deferred" },
  )
}
