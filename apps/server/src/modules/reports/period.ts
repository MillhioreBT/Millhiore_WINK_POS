import type { InventoryReport, ResultsReport, SalesReport } from "@millhiore/contracts"
import {
  business,
  category,
  currency,
  type Db,
  document,
  documentLine,
  documentTax,
  expenseCategory,
  payment,
  paymentMethod,
  product,
  stockBalance,
  user,
  variant,
} from "@millhiore/db"
import {
  type CurrencyBook,
  convert,
  exchangeRate,
  legalConverter,
  localDate,
  money,
} from "@millhiore/domain"
import { and, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { HttpError } from "../../http/errors"
import { listAdjustments } from "../inventory/service"
import { rateAt } from "../rates/service"

type Business = typeof business.$inferSelect

function setup(db: Db): { biz: Business; book: CurrencyBook } {
  const biz = db.select().from(business).get()
  if (!biz) throw new HttpError(409, "NOT_CONFIGURED", "El negocio aún no está configurado")
  const book: CurrencyBook = Object.fromEntries(
    db
      .select()
      .from(currency)
      .all()
      .map((c) => [c.code, { code: c.code, decimals: c.decimals }]),
  )
  return { biz, book }
}

/** Lo que valen `amountMinor` de `from` en moneda legal a la tasa vigente en `at`; null sin tasa. */
function toLegalAt(
  db: Db,
  book: CurrencyBook,
  legal: string,
  amountMinor: number,
  from: string,
  at: number,
): number | null {
  if (from === legal) return amountMinor
  const base = book[from]
  const quote = book[legal]
  const stored = base && quote ? rateAt(db, from, legal, at) : undefined
  if (!(base && quote && stored)) return null
  const converted = convert(
    money(Math.abs(amountMinor), from),
    exchangeRate(stored.base, stored.quote, stored.value),
    { base, quote },
  ).amountMinor
  return Math.sign(amountMinor) * converted
}

/** Las devoluciones restan: su importe entra con signo contrario al de una venta. */
const signOf = (type: string) => (type === "RETURN" ? -1 : 1)

const inRange = (from: number, to: number) =>
  and(gte(document.postedAt, from), lt(document.postedAt, to))

/** El costo de una línea (cantidad × costo unitario) en moneda legal; null sin costo o sin tasa. */
function lineCostLegal(
  db: Db,
  book: CurrencyBook,
  legal: string,
  l: { qtyMilli: number; costMinor: number | null; costCurrency: string | null; postedAt: number },
): number | null {
  if (l.costMinor === null || l.costCurrency === null) return null
  const own = Math.round((Math.abs(l.qtyMilli) * l.costMinor) / 1000)
  const legalValue = toLegalAt(db, book, legal, own, l.costCurrency, l.postedAt)
  return legalValue === null ? null : Math.sign(l.qtyMilli) * legalValue
}

/**
 * Estado de resultados de un rango (devengado, en moneda legal, cada documento a su tasa):
 * ventas sin IVA, menos el costo de lo vendido, es la utilidad bruta; de ahí se restan los
 * gastos, las pérdidas de inventario y las comisiones. Las devoluciones y anulaciones restan.
 */
export function resultsReport(
  db: Db,
  opts: { from: number; to: number; seeCost: boolean },
): ResultsReport {
  const { biz, book } = setup(db)
  const legal = biz.legalCurrency
  const { from, to } = opts

  // Ventas
  const sales = { count: 0, total: 0, tax: 0, discount: 0, surcharge: 0 }
  const taxByDoc = new Map<string, number>(
    db
      .select({ id: documentTax.documentId, tax: sql<number>`sum(${documentTax.taxLegalMinor})` })
      .from(documentTax)
      .innerJoin(document, eq(document.id, documentTax.documentId))
      .where(and(inArray(document.type, ["SALE", "RETURN"]), inRange(from, to)))
      .groupBy(documentTax.documentId)
      .all()
      .map((r) => [r.id, r.tax]),
  )
  for (const d of db
    .select({
      id: document.id,
      type: document.type,
      reverses: document.reversesDocumentId,
      total: document.totalLegalMinor,
      discount: document.discountLegalMinor,
      surcharge: document.surchargeLegalMinor,
    })
    .from(document)
    .where(and(inArray(document.type, ["SALE", "RETURN"]), inRange(from, to)))
    .all()) {
    const sign = signOf(d.type)
    if (d.type === "SALE") sales.count += d.reverses ? -1 : 1
    sales.total += sign * d.total
    sales.tax += sign * (taxByDoc.get(d.id) ?? 0)
    sales.discount += sign * d.discount
    sales.surcharge += sign * d.surcharge
  }

  // Costo de lo vendido
  let cogs = 0
  let withoutCost = 0
  for (const l of db
    .select({
      type: document.type,
      reverses: document.reversesDocumentId,
      postedAt: document.postedAt,
      qtyMilli: documentLine.qtyMilli,
      costMinor: documentLine.costMinor,
      costCurrency: documentLine.costCurrency,
      kind: product.kind,
    })
    .from(documentLine)
    .innerJoin(document, eq(document.id, documentLine.documentId))
    .innerJoin(variant, eq(variant.id, documentLine.variantId))
    .innerJoin(product, eq(product.id, variant.productId))
    .where(and(inArray(document.type, ["SALE", "RETURN"]), inRange(from, to)))
    .all()) {
    const cost = lineCostLegal(db, book, legal, l)
    if (cost === null) {
      if (l.kind === "good" && !l.reverses && l.type === "SALE") withoutCost += 1
      continue
    }
    cogs += signOf(l.type) * cost
  }

  // Gastos por categoría, netos de anulaciones
  const byCategory = db
    .select({
      name: sql<string>`coalesce(${expenseCategory.name}, 'Sin categoría')`,
      count: sql<number>`coalesce(sum(case when ${document.reversesDocumentId} is null then 1 else -1 end), 0)`,
      total: sql<number>`coalesce(sum(${document.totalLegalMinor}), 0)`,
    })
    .from(document)
    .leftJoin(expenseCategory, eq(expenseCategory.id, document.expenseCategoryId))
    .where(and(eq(document.type, "EXPENSE"), inRange(from, to)))
    .groupBy(document.expenseCategoryId)
    .all()
    .filter((c) => c.count !== 0 || c.total !== 0)
    .sort((a, b) => b.total - a.total)
  const expenses = {
    count: byCategory.reduce((acc, c) => acc + c.count, 0),
    totalLegalMinor: byCategory.reduce((acc, c) => acc + c.total, 0),
    byCategory: byCategory.map((c) => ({
      name: c.name,
      count: c.count,
      totalLegalMinor: c.total,
    })),
  }

  // Pérdidas de inventario: salidas por ajuste menos entradas por ajuste, a costo
  const adjustments = listAdjustments(db, { from, to, limit: 1, seeCost: true })
  const inventoryLoss = (adjustments.outLegalMinor ?? 0) - (adjustments.inLegalMinor ?? 0)

  // Comisiones de bancos y puntos de venta
  let commissions = 0
  for (const p of db
    .select({
      currency: payment.currency,
      commission: payment.commissionMinor,
      postedAt: document.postedAt,
    })
    .from(payment)
    .innerJoin(document, eq(document.id, payment.documentId))
    .where(and(ne(payment.commissionMinor, 0), inRange(from, to)))
    .all()) {
    commissions += toLegalAt(db, book, legal, p.commission, p.currency, p.postedAt) ?? 0
  }

  // Lo devuelto a los proveedores resta de las compras.
  const purchases = db
    .select({
      count: sql<number>`coalesce(sum(case when ${document.type} <> 'PURCHASE' then 0 when ${document.reversesDocumentId} is null then 1 else -1 end), 0)`,
      total: sql<number>`coalesce(sum(case when ${document.type} = 'PURCHASE_RETURN' then -${document.totalLegalMinor} else ${document.totalLegalMinor} end), 0)`,
    })
    .from(document)
    .where(and(inArray(document.type, ["PURCHASE", "PURCHASE_RETURN"]), inRange(from, to)))
    .get()

  const net = sales.total - sales.tax
  const seeCost = opts.seeCost
  const gross = seeCost ? net - cogs : null
  return {
    from,
    to,
    legalCurrency: legal,
    sales: {
      count: sales.count,
      totalLegalMinor: sales.total,
      taxLegalMinor: sales.tax,
      netLegalMinor: net,
      discountLegalMinor: sales.discount,
      surchargeLegalMinor: sales.surcharge,
    },
    costOfGoodsLegalMinor: seeCost ? cogs : null,
    linesWithoutCost: seeCost ? withoutCost : 0,
    grossProfitLegalMinor: gross,
    grossMarginBp: gross !== null && net > 0 ? Math.round((gross * 10_000) / net) : null,
    expenses,
    inventoryLossLegalMinor: seeCost ? inventoryLoss : null,
    commissionsLegalMinor: commissions,
    netProfitLegalMinor:
      gross === null ? null : gross - expenses.totalLegalMinor - inventoryLoss - commissions,
    purchases: { count: purchases?.count ?? 0, totalLegalMinor: purchases?.total ?? 0 },
  }
}

/** Ventas de un rango: por día, por producto (con utilidad), por método de pago y por vendedor. */
export function salesReport(
  db: Db,
  opts: { from: number; to: number; seeCost: boolean },
): SalesReport {
  const { biz, book } = setup(db)
  const legal = biz.legalCurrency
  const tz = biz.timezone
  const { from, to } = opts

  const docs = db
    .select({
      id: document.id,
      type: document.type,
      reverses: document.reversesDocumentId,
      postedAt: document.postedAt,
      total: document.totalLegalMinor,
      discount: document.discountLegalMinor,
      currency: document.currency,
      legalCurrency: document.legalCurrency,
      rateBase: document.rateBase,
      rateQuote: document.rateQuote,
      rateValue: document.rateValue,
      createdBy: document.createdBy,
    })
    .from(document)
    .where(and(inArray(document.type, ["SALE", "RETURN"]), inRange(from, to)))
    .all()
  const reversed = new Set(
    db
      .select({ id: document.reversesDocumentId })
      .from(document)
      .where(and(isNotNull(document.reversesDocumentId), eq(document.type, "SALE")))
      .all()
      .map((r) => r.id),
  )
  const taxByDoc = new Map<string, number>(
    db
      .select({ id: documentTax.documentId, tax: sql<number>`sum(${documentTax.taxLegalMinor})` })
      .from(documentTax)
      .innerJoin(document, eq(document.id, documentTax.documentId))
      .where(and(inArray(document.type, ["SALE", "RETURN"]), inRange(from, to)))
      .groupBy(documentTax.documentId)
      .all()
      .map((r) => [r.id, r.tax]),
  )

  const totals = { count: 0, total: 0, tax: 0, discount: 0, returns: 0 }
  const days = new Map<string, { date: string; count: number; totalLegalMinor: number }>()
  const users = new Map<string, { name: string; count: number; totalLegalMinor: number }>()
  const userNames = new Map(
    db
      .select({ id: user.id, name: user.name })
      .from(user)
      .all()
      .map((u) => [u.id, u.name]),
  )
  for (const d of docs) {
    const sign = signOf(d.type)
    if (d.type === "SALE") totals.count += d.reverses ? -1 : 1
    totals.total += sign * d.total
    totals.tax += sign * (taxByDoc.get(d.id) ?? 0)
    totals.discount += sign * d.discount
    if (d.type === "RETURN") totals.returns += d.total
    const date = localDate(d.postedAt, tz)
    const day = days.get(date) ?? { date, count: 0, totalLegalMinor: 0 }
    if (d.type === "SALE") day.count += d.reverses ? -1 : 1
    day.totalLegalMinor += sign * d.total
    days.set(date, day)
    // Por vendedor: las ventas vigentes (sin anular), a nombre de quien las cobró.
    if (d.type === "SALE" && !d.reverses && !reversed.has(d.id)) {
      const name = (d.createdBy && userNames.get(d.createdBy)) || "Sin vendedor"
      const u = users.get(name) ?? { name, count: 0, totalLegalMinor: 0 }
      u.count += 1
      u.totalLegalMinor += d.total
      users.set(name, u)
    }
  }

  // Por producto: el importe de cada línea a la tasa de su documento y, con costos, la utilidad
  const docInfo = new Map(docs.map((d) => [d.id, d]))
  const products = new Map<
    string,
    {
      variantId: string
      name: string
      sku: string
      categoryId: string | null
      category: string | null
      qtyMilli: number
      totalLegalMinor: number
      costLegalMinor: number
      unknownCost: boolean
    }
  >()
  for (const l of db
    .select({
      documentId: documentLine.documentId,
      variantId: documentLine.variantId,
      name: variant.name,
      sku: variant.sku,
      qtyMilli: documentLine.qtyMilli,
      lineTotalMinor: documentLine.lineTotalMinor,
      costMinor: documentLine.costMinor,
      costCurrency: documentLine.costCurrency,
      kind: product.kind,
      categoryId: product.categoryId,
      category: category.name,
    })
    .from(documentLine)
    .innerJoin(document, eq(document.id, documentLine.documentId))
    .innerJoin(variant, eq(variant.id, documentLine.variantId))
    .innerJoin(product, eq(product.id, variant.productId))
    .leftJoin(category, eq(category.id, product.categoryId))
    .where(and(inArray(document.type, ["SALE", "RETURN"]), inRange(from, to)))
    .all()) {
    const d = docInfo.get(l.documentId)
    if (!d) continue
    const sign = signOf(d.type)
    const toLegal = legalConverter(
      d.currency,
      d.legalCurrency,
      d.rateBase && d.rateQuote && d.rateValue
        ? exchangeRate(d.rateBase, d.rateQuote, d.rateValue)
        : null,
      book,
    )
    const row = products.get(l.variantId) ?? {
      variantId: l.variantId,
      name: l.name,
      sku: l.sku,
      categoryId: l.categoryId,
      category: l.category,
      qtyMilli: 0,
      totalLegalMinor: 0,
      costLegalMinor: 0,
      unknownCost: false,
    }
    row.qtyMilli += sign * l.qtyMilli
    row.totalLegalMinor += sign * toLegal(l.lineTotalMinor)
    const cost = lineCostLegal(db, book, legal, { ...l, postedAt: d.postedAt })
    if (cost === null) {
      if (l.kind === "good") row.unknownCost = true
    } else {
      row.costLegalMinor += sign * cost
    }
    products.set(l.variantId, row)
  }

  // Cobrado por método, con la comisión que descontó el banco
  const byMethod = db
    .select({
      methodName: paymentMethod.name,
      currency: payment.currency,
      amountMinor: sql<number>`sum(case when ${document.type} = 'RETURN' then -${payment.amountMinor} else ${payment.amountMinor} end)`,
      commissionMinor: sql<number>`sum(${payment.commissionMinor})`,
    })
    .from(payment)
    .innerJoin(document, eq(document.id, payment.documentId))
    .innerJoin(paymentMethod, eq(paymentMethod.id, payment.paymentMethodId))
    .where(and(inArray(document.type, ["SALE", "PAYMENT_IN", "RETURN"]), inRange(from, to)))
    .groupBy(payment.paymentMethodId, payment.currency)
    .all()
    .filter((m) => m.amountMinor !== 0)
    .sort((a, b) => a.methodName.localeCompare(b.methodName, "es"))

  // Por categoría: la suma de sus productos (con o sin categoría, todos los vendidos)
  const categories = new Map<
    string,
    {
      categoryId: string | null
      name: string
      products: number
      totalLegalMinor: number
      costLegalMinor: number
      unknownCost: boolean
    }
  >()
  for (const p of products.values()) {
    if (p.qtyMilli === 0 && p.totalLegalMinor === 0) continue
    const k = p.categoryId ?? ""
    const row = categories.get(k) ?? {
      categoryId: p.categoryId,
      name: p.category ?? "Sin categoría",
      products: 0,
      totalLegalMinor: 0,
      costLegalMinor: 0,
      unknownCost: false,
    }
    row.products += 1
    row.totalLegalMinor += p.totalLegalMinor
    row.costLegalMinor += p.costLegalMinor
    row.unknownCost ||= p.unknownCost
    categories.set(k, row)
  }

  const net = totals.total - totals.tax
  return {
    from,
    to,
    legalCurrency: legal,
    totals: {
      count: totals.count,
      totalLegalMinor: totals.total,
      netLegalMinor: net,
      taxLegalMinor: totals.tax,
      discountLegalMinor: totals.discount,
      returnsLegalMinor: totals.returns,
      averageLegalMinor: totals.count > 0 ? Math.round(totals.total / totals.count) : 0,
    },
    byDay: [...days.values()]
      .filter((d) => d.count !== 0 || d.totalLegalMinor !== 0)
      .sort((a, b) => a.date.localeCompare(b.date)),
    byProduct: [...products.values()]
      .filter((p) => p.qtyMilli !== 0 || p.totalLegalMinor !== 0)
      .sort((a, b) => b.totalLegalMinor - a.totalLegalMinor || b.qtyMilli - a.qtyMilli)
      .slice(0, 200)
      .map((p) => ({
        variantId: p.variantId,
        name: p.name,
        sku: p.sku,
        qtyMilli: p.qtyMilli,
        totalLegalMinor: p.totalLegalMinor,
        costLegalMinor: opts.seeCost && !p.unknownCost ? p.costLegalMinor : null,
        profitLegalMinor:
          opts.seeCost && !p.unknownCost ? p.totalLegalMinor - p.costLegalMinor : null,
      })),
    byCategory: [...categories.values()]
      .sort((a, b) => b.totalLegalMinor - a.totalLegalMinor || a.name.localeCompare(b.name, "es"))
      .map((c) => ({
        categoryId: c.categoryId,
        name: c.name,
        products: c.products,
        totalLegalMinor: c.totalLegalMinor,
        costLegalMinor: opts.seeCost && !c.unknownCost ? c.costLegalMinor : null,
        profitLegalMinor:
          opts.seeCost && !c.unknownCost ? c.totalLegalMinor - c.costLegalMinor : null,
      })),
    byMethod,
    byUser: [...users.values()].sort((a, b) => b.totalLegalMinor - a.totalLegalMinor),
  }
}

/** El inventario de hoy: existencia, costo, lo que vale a costo y a precio de venta, producto por producto. */
export function inventoryReport(
  db: Db,
  opts: { now: number; seeCost: boolean; locationId?: string | undefined },
): InventoryReport {
  const { biz, book } = setup(db)
  const legal = biz.legalCurrency
  const here = opts.locationId ? sql` and ${stockBalance.locationId} = ${opts.locationId}` : sql``
  const stock = sql<number>`coalesce((select sum(${stockBalance.qtyMilli}) from ${stockBalance}
    where ${stockBalance.variantId} = ${variant.id}${here}), 0)`
  const categories = alias(category, "cat")
  const rows = db
    .select({
      variantId: variant.id,
      name: variant.name,
      sku: variant.sku,
      category: categories.name,
      stockMilli: stock,
      minStockMilli: variant.minStockMilli,
      costMinor: variant.costMinor,
      costCurrency: variant.costCurrency,
      priceMinor: variant.priceMinor,
      priceCurrency: variant.priceCurrency,
    })
    .from(variant)
    .innerJoin(product, eq(product.id, variant.productId))
    .leftJoin(categories, eq(categories.id, product.categoryId))
    .where(and(eq(product.active, true), eq(variant.active, true), eq(product.tracksStock, true)))
    .orderBy(variant.name)
    .all()

  const rate = rateAt(db, biz.referenceCurrency, legal, opts.now)
  let totalValue = 0
  let totalRetail = 0
  let withoutCost = 0
  const out = rows.map((r) => {
    const qty = Math.max(0, r.stockMilli)
    const value =
      opts.seeCost && r.costMinor !== null && r.costCurrency !== null
        ? toLegalAt(
            db,
            book,
            legal,
            Math.round((qty * r.costMinor) / 1000),
            r.costCurrency,
            opts.now,
          )
        : null
    const retail = toLegalAt(
      db,
      book,
      legal,
      Math.round((qty * r.priceMinor) / 1000),
      r.priceCurrency,
      opts.now,
    )
    if (value !== null) totalValue += value
    if (retail !== null) totalRetail += retail
    if (opts.seeCost && qty > 0 && r.costMinor === null) withoutCost += 1
    return {
      ...r,
      costMinor: opts.seeCost ? r.costMinor : null,
      costCurrency: opts.seeCost ? r.costCurrency : null,
      valueLegalMinor: value,
      retailLegalMinor: retail,
    }
  })
  return {
    legalCurrency: legal,
    referenceCurrency: biz.referenceCurrency,
    rate: rate?.value ?? null,
    rows: out,
    totalValueLegalMinor: opts.seeCost ? totalValue : null,
    totalRetailLegalMinor: totalRetail,
    withoutCost,
  }
}
