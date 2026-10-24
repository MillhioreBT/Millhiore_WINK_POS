import type { DaySummary } from "@millhiore/contracts"
import {
  business,
  cashShift,
  currency,
  type Db,
  document,
  documentLine,
  documentTax,
  payment,
  paymentMethod,
  product,
  stockBalance,
  terminal,
  user,
  variant,
} from "@millhiore/db"
import {
  addDays,
  type CurrencyBook,
  convert,
  dayRange,
  exchangeRate,
  isValidDate,
  legalConverter,
  localDate,
  localHour,
  money,
} from "@millhiore/domain"
import { and, asc, eq, gte, inArray, lt, type SQLWrapper, sql } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { features } from "../features/routes"
import { listAdjustments } from "../inventory/service"
import { expiryCounts } from "../lots/routes"
import { rateAt } from "../rates/service"

type Business = typeof business.$inferSelect

function loadBook(db: Db): CurrencyBook {
  return Object.fromEntries(
    db
      .select()
      .from(currency)
      .all()
      .map((c) => [c.code, { code: c.code, decimals: c.decimals }]),
  )
}

/** Las devoluciones restan: su importe entra con signo contrario al de una venta. */
const signed = (col: SQLWrapper) =>
  sql<number>`case when ${document.type} = 'RETURN' then -${col} else ${col} end`

/** Ventas y devoluciones de un rango (las devoluciones se restan de las ventas). */
const salesIn = (from: number, to: number) =>
  and(
    inArray(document.type, ["SALE", "RETURN"]),
    gte(document.postedAt, from),
    lt(document.postedAt, to),
  )

/** Lo que movió dinero con clientes: ventas cobradas, abonos y reembolsos de devoluciones. */
const takingsIn = (from: number, to: number) =>
  and(
    inArray(document.type, ["SALE", "PAYMENT_IN", "RETURN"]),
    gte(document.postedAt, from),
    lt(document.postedAt, to),
  )

/** Cifras de ventas de un rango: totales legales y su equivalente en la moneda de referencia. */
function salesFigures(db: Db, biz: Business, book: CurrencyBook, from: number, to: number) {
  const where = salesIn(from, to)
  const totals = db
    .select({
      count: sql<number>`count(case when ${document.type} = 'SALE' and ${document.reversesDocumentId} is null then 1 end)`,
      voided: sql<number>`count(case when ${document.type} = 'SALE' and ${document.reversesDocumentId} is not null then 1 end)`,
      totalLegalMinor: sql<number>`coalesce(sum(${signed(document.totalLegalMinor)}), 0)`,
      surchargeLegalMinor: sql<number>`coalesce(sum(${document.surchargeLegalMinor}), 0)`,
      creditLegalMinor: sql<number>`coalesce(sum(${document.creditLegalMinor}), 0)`,
      discountLegalMinor: sql<number>`coalesce(sum(${signed(document.discountLegalMinor)}), 0)`,
      returnsLegalMinor: sql<number>`coalesce(sum(case when ${document.type} = 'RETURN' then ${document.totalLegalMinor} else 0 end), 0)`,
    })
    .from(document)
    .where(where)
    .get()
  const tax = db
    .select({ taxLegalMinor: sql<number>`coalesce(sum(${signed(documentTax.taxLegalMinor)}), 0)` })
    .from(documentTax)
    .innerJoin(document, eq(document.id, documentTax.documentId))
    .where(where)
    .get()

  // A la referencia con la tasa vigente al momento de cada venta: comparar días en Bs mezcla
  // ventas con devaluación.
  const ref = biz.referenceCurrency
  const legal = biz.legalCurrency
  let reference = 0
  let missingRate = false
  const pair = book[ref] && book[legal] ? { base: book[ref], quote: book[legal] } : null
  for (const d of db
    .select({
      type: document.type,
      postedAt: document.postedAt,
      currency: document.currency,
      totalMinor: document.totalMinor,
      totalLegalMinor: document.totalLegalMinor,
    })
    .from(document)
    .where(where)
    .all()) {
    const sign = d.type === "RETURN" ? -1 : 1
    if (d.currency === ref) {
      reference += sign * d.totalMinor
      continue
    }
    const stored = pair ? rateAt(db, ref, legal, d.postedAt) : undefined
    if (!stored || !pair) {
      missingRate = true
      continue
    }
    const rate = exchangeRate(stored.base, stored.quote, stored.value)
    reference += sign * convert(money(d.totalLegalMinor, legal), rate, pair).amountMinor
  }

  return {
    count: totals?.count ?? 0,
    voided: totals?.voided ?? 0,
    totalLegalMinor: totals?.totalLegalMinor ?? 0,
    taxLegalMinor: tax?.taxLegalMinor ?? 0,
    surchargeLegalMinor: totals?.surchargeLegalMinor ?? 0,
    creditLegalMinor: totals?.creditLegalMinor ?? 0,
    discountLegalMinor: totals?.discountLegalMinor ?? 0,
    returnsLegalMinor: totals?.returnsLegalMinor ?? 0,
    totalReferenceMinor: missingRate ? null : reference,
  }
}

/**
 * Resumen de un día en la zona horaria del negocio: ventas netas de anulaciones (un reverso
 * cuenta el día en que se anula), cobrado por método, ventas por hora, lo más vendido, compras,
 * turnos abiertos y productos por reponer.
 */
export function daySummary(
  db: Db,
  opts: { date?: string | undefined; now: number; includeStock: boolean; seeCost: boolean },
): DaySummary {
  const biz = db.select().from(business).get()
  if (!biz) throw new HttpError(409, "NOT_CONFIGURED", "El negocio aún no está configurado")
  const tz = biz.timezone
  const date = opts.date ?? localDate(opts.now, tz)
  if (!isValidDate(date)) throw new HttpError(422, "INVALID_DATE", `Fecha inválida: ${date}`)
  const { from, to } = dayRange(date, tz)
  const yesterday = dayRange(addDays(date, -1), tz)
  const book = loadBook(db)
  const where = salesIn(from, to)

  const byMethod = db
    .select({
      methodId: payment.paymentMethodId,
      methodName: paymentMethod.name,
      currency: payment.currency,
      amountMinor: sql<number>`sum(case when ${document.type} = 'RETURN' then -${payment.amountMinor} else ${payment.amountMinor} end)`,
      commissionMinor: sql<number>`sum(${payment.commissionMinor})`,
    })
    .from(payment)
    .innerJoin(document, eq(document.id, payment.documentId))
    .innerJoin(paymentMethod, eq(paymentMethod.id, payment.paymentMethodId))
    .where(takingsIn(from, to))
    .groupBy(payment.paymentMethodId, payment.currency)
    .all()
    .filter((m) => m.amountMinor !== 0)
    .sort((a, b) => a.methodName.localeCompare(b.methodName, "es"))

  const docs = db
    .select({
      id: document.id,
      type: document.type,
      postedAt: document.postedAt,
      reverses: document.reversesDocumentId,
      totalLegalMinor: document.totalLegalMinor,
      currency: document.currency,
      legalCurrency: document.legalCurrency,
      rateBase: document.rateBase,
      rateQuote: document.rateQuote,
      rateValue: document.rateValue,
    })
    .from(document)
    .where(where)
    .all()

  const hours = new Map<number, { hour: number; count: number; totalLegalMinor: number }>()
  for (const d of docs) {
    const hour = localHour(d.postedAt, tz)
    const row = hours.get(hour) ?? { hour, count: 0, totalLegalMinor: 0 }
    if (!d.reverses && d.type === "SALE") row.count += 1
    row.totalLegalMinor += (d.type === "RETURN" ? -1 : 1) * d.totalLegalMinor
    hours.set(hour, row)
  }

  // Lo más vendido: importe de cada línea llevado a moneda legal con la tasa de su documento.
  const toLegal = new Map(
    docs.map((d) => [
      d.id,
      legalConverter(
        d.currency,
        d.legalCurrency,
        d.rateBase && d.rateQuote && d.rateValue
          ? exchangeRate(d.rateBase, d.rateQuote, d.rateValue)
          : null,
        book,
      ),
    ]),
  )
  const docType = new Map(docs.map((d) => [d.id, d.type]))
  const products = new Map<
    string,
    { variantId: string; name: string; qtyMilli: number; totalLegalMinor: number }
  >()
  for (const l of db
    .select({
      documentId: documentLine.documentId,
      variantId: documentLine.variantId,
      name: variant.name,
      qtyMilli: documentLine.qtyMilli,
      lineTotalMinor: documentLine.lineTotalMinor,
    })
    .from(documentLine)
    .innerJoin(document, eq(document.id, documentLine.documentId))
    .innerJoin(variant, eq(variant.id, documentLine.variantId))
    .where(where)
    .all()) {
    const row = products.get(l.variantId) ?? {
      variantId: l.variantId,
      name: l.name,
      qtyMilli: 0,
      totalLegalMinor: 0,
    }
    // Lo devuelto resta de lo vendido.
    const sign = docType.get(l.documentId) === "RETURN" ? -1 : 1
    row.qtyMilli += sign * l.qtyMilli
    row.totalLegalMinor += sign * (toLegal.get(l.documentId)?.(l.lineTotalMinor) ?? 0)
    products.set(l.variantId, row)
  }

  const purchases = db
    .select({
      count: sql<number>`count(case when ${document.type} = 'PURCHASE' and ${document.reversesDocumentId} is null then 1 end)`,
      // Lo devuelto a los proveedores resta de las compras.
      totalLegalMinor: sql<number>`coalesce(sum(case when ${document.type} = 'PURCHASE_RETURN' then -${document.totalLegalMinor} else ${document.totalLegalMinor} end), 0)`,
    })
    .from(document)
    .where(
      and(
        inArray(document.type, ["PURCHASE", "PURCHASE_RETURN"]),
        gte(document.postedAt, from),
        lt(document.postedAt, to),
      ),
    )
    .get()

  const collections = db
    .select({
      count: sql<number>`count(case when ${document.reversesDocumentId} is null then 1 end)`,
      totalLegalMinor: sql<number>`coalesce(sum(${document.totalLegalMinor}), 0)`,
    })
    .from(document)
    .where(
      and(eq(document.type, "PAYMENT_IN"), gte(document.postedAt, from), lt(document.postedAt, to)),
    )
    .get()

  // Gastos pagados en el día, netos de anulaciones (un reverso resta uno y su monto).
  const expenses = db
    .select({
      count: sql<number>`coalesce(sum(case when ${document.reversesDocumentId} is null then 1 else -1 end), 0)`,
      totalLegalMinor: sql<number>`coalesce(sum(${document.totalLegalMinor}), 0)`,
    })
    .from(document)
    .where(
      and(eq(document.type, "EXPENSE"), gte(document.postedAt, from), lt(document.postedAt, to)),
    )
    .get()

  const openShifts = db
    .select({
      id: cashShift.id,
      terminalName: terminal.name,
      openedAt: cashShift.openedAt,
      openedBy: user.name,
    })
    .from(cashShift)
    .innerJoin(terminal, eq(terminal.id, cashShift.terminalId))
    .leftJoin(user, eq(user.id, cashShift.openedBy))
    .where(eq(cashShift.status, "open"))
    .orderBy(asc(terminal.name))
    .all()

  return {
    date,
    from,
    to,
    legalCurrency: biz.legalCurrency,
    referenceCurrency: biz.referenceCurrency,
    sales: salesFigures(db, biz, book, from, to),
    previous: salesFigures(db, biz, book, yesterday.from, yesterday.to),
    byMethod,
    byHour: [...hours.values()].sort((a, b) => a.hour - b.hour),
    topProducts: [...products.values()]
      .filter((p) => p.qtyMilli > 0)
      .sort((a, b) => b.totalLegalMinor - a.totalLegalMinor || b.qtyMilli - a.qtyMilli)
      .slice(0, 10),
    purchases: {
      count: purchases?.count ?? 0,
      totalLegalMinor: purchases?.totalLegalMinor ?? 0,
    },
    collections: {
      count: collections?.count ?? 0,
      totalLegalMinor: collections?.totalLegalMinor ?? 0,
    },
    expenses: {
      count: expenses?.count ?? 0,
      totalLegalMinor: expenses?.totalLegalMinor ?? 0,
    },
    inventoryLossLegalMinor: opts.seeCost ? inventoryLoss(db, from, to) : null,
    expiry: opts.includeStock && features(db).lots ? expiryCounts(db, opts.now) : null,
    openShifts,
    lowStock: opts.includeStock ? lowStock(db) : null,
  }
}

/** Salidas por ajuste (merma, vencido, uso interno…) menos entradas por ajuste, a costo. */
function inventoryLoss(db: Db, from: number, to: number): number {
  const a = listAdjustments(db, { from, to, limit: 1, seeCost: true })
  return (a.outLegalMinor ?? 0) - (a.inLegalMinor ?? 0)
}

/** Productos activos que llevan existencia y están agotados o por debajo de su mínimo. */
export function lowStock(db: Db): NonNullable<DaySummary["lowStock"]> {
  const stock = sql<number>`coalesce((select sum(${stockBalance.qtyMilli}) from ${stockBalance}
    where ${stockBalance.variantId} = ${variant.id}), 0)`
  return db
    .select({
      productId: product.id,
      variantId: variant.id,
      name: product.name,
      stockMilli: stock,
      minStockMilli: variant.minStockMilli,
    })
    .from(product)
    .innerJoin(variant, eq(variant.productId, product.id))
    .where(
      and(
        eq(product.active, true),
        eq(product.tracksStock, true),
        sql`${stock} <= coalesce(${variant.minStockMilli}, 0)`,
      ),
    )
    .orderBy(asc(stock), asc(product.name))
    .limit(50)
    .all()
}
