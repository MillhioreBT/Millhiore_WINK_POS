import type { CreateQuoteBody, QuoteDetail, QuoteSummary } from "@millhiore/contracts"
import {
  auditLog,
  contact,
  type Db,
  document,
  product,
  quote,
  quoteLine,
  saleCharge,
  user,
  variant,
} from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, asc, desc, eq, gte, inArray, like, lt, or, type SQL, sql } from "drizzle-orm"
import { HttpError } from "../../http/errors"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

const DAY_MS = 86_400_000

const summaryColumns = {
  id: quote.id,
  number: quote.number,
  status: quote.status,
  contactId: quote.contactId,
  contactName: contact.name,
  contactPhone: contact.phone,
  validUntil: quote.validUntil,
  totalLegalMinor: quote.totalLegalMinor,
  totalRefMinor: quote.totalRefMinor,
  rateValue: quote.rateValue,
  lineCount: sql<number>`(select count(*) from ${quoteLine} where ${quoteLine.quoteId} = ${quote.id})`,
  note: quote.note,
  createdBy: user.name,
  createdAt: quote.createdAt,
  closedAt: quote.closedAt,
  documentId: quote.documentId,
  documentNumber: document.number,
}

function summaries(db: Db | Tx, where: SQL | undefined, limit = 500): QuoteSummary[] {
  return db
    .select(summaryColumns)
    .from(quote)
    .leftJoin(contact, eq(contact.id, quote.contactId))
    .leftJoin(user, eq(user.id, quote.createdBy))
    .leftJoin(document, eq(document.id, quote.documentId))
    .where(where)
    .orderBy(desc(quote.createdAt), desc(quote.id))
    .limit(limit)
    .all()
}

/** Cotizaciones de un período, las más recientes primero; con estado o búsqueda opcionales. */
export function listQuotes(
  db: Db,
  opts: {
    status?: QuoteSummary["status"] | undefined
    search?: string | undefined
    from?: number | undefined
    to?: number | undefined
    limit?: number | undefined
  },
): QuoteSummary[] {
  const term = opts.search?.trim()
  const filters = [
    opts.status ? eq(quote.status, opts.status) : undefined,
    opts.from !== undefined ? gte(quote.createdAt, opts.from) : undefined,
    opts.to !== undefined ? lt(quote.createdAt, opts.to) : undefined,
    term ? or(like(quote.number, `%${term}%`), like(contact.name, `%${term}%`)) : undefined,
  ].filter((f) => f !== undefined)
  return summaries(db, filters.length ? and(...filters) : undefined, opts.limit ?? 500)
}

export function quoteDetail(db: Db | Tx, id: string): QuoteDetail {
  const summary = summaries(db, eq(quote.id, id), 1)[0]
  const row = db.select().from(quote).where(eq(quote.id, id)).get()
  if (!summary || !row) throw new HttpError(404, "NOT_FOUND", `No existe la cotización ${id}`)
  const lines = db
    .select({
      lineNo: quoteLine.lineNo,
      variantId: quoteLine.variantId,
      name: quoteLine.name,
      qtyMilli: quoteLine.qtyMilli,
      priceMinor: quoteLine.priceMinor,
      priceCurrency: quoteLine.priceCurrency,
      discountKind: quoteLine.discountKind,
      discountValue: quoteLine.discountValue,
      discountCurrency: quoteLine.discountCurrency,
      taxId: product.taxId,
      active: variant.active,
    })
    .from(quoteLine)
    .innerJoin(variant, eq(variant.id, quoteLine.variantId))
    .innerJoin(product, eq(product.id, variant.productId))
    .where(eq(quoteLine.quoteId, id))
    .orderBy(asc(quoteLine.lineNo))
    .all()
  return {
    ...summary,
    lines: lines.map(({ discountKind, discountValue, discountCurrency, ...l }) => ({
      ...l,
      discount: discountOf(discountKind, discountValue, discountCurrency),
    })),
    saleDiscount: discountOf(row.discountKind, row.discountValue, row.discountCurrency),
    charges: row.charges ?? [],
    contact: row.contactId
      ? (db.select().from(contact).where(eq(contact.id, row.contactId)).get() ?? null)
      : null,
  }
}

type DiscountSpec = NonNullable<QuoteDetail["saleDiscount"]>

function discountOf(
  kind: "percent" | "amount" | null,
  value: number | null,
  currency: string | null,
): DiscountSpec | null {
  if (!kind || !value) return null
  return kind === "percent"
    ? { kind, bp: value }
    : { kind, amountMinor: value, currency: currency ?? "" }
}

function discountColumns(d: DiscountSpec | null | undefined) {
  return {
    discountKind: d?.kind ?? null,
    discountValue: d ? (d.kind === "percent" ? d.bp : d.amountMinor) : null,
    discountCurrency: d?.kind === "amount" ? d.currency : null,
  }
}

function audit(tx: Tx, actorId: string, now: number, action: string, id: string, data: unknown) {
  tx.insert(auditLog)
    .values({ id: uuidv7(now), at: now, actorId, action, entityType: "quote", entityId: id, data })
    .run()
}

/**
 * Guarda una cotización con los precios con que se ofreció. Reenviar el mismo `id` devuelve la
 * ya guardada (la caja puede reintentar sin duplicarla).
 */
export function createQuote(
  db: Db,
  body: CreateQuoteBody,
  actorId: string,
  now: number,
): QuoteDetail {
  return db.transaction(
    (tx) => {
      if (tx.select({ id: quote.id }).from(quote).where(eq(quote.id, body.id)).get()) {
        return quoteDetail(tx, body.id)
      }
      if (body.contactId) {
        const c = tx.select().from(contact).where(eq(contact.id, body.contactId)).get()
        if (!c?.active || c.kind === "supplier") {
          throw new HttpError(422, "UNKNOWN_CONTACT", "Elige un cliente activo")
        }
      }
      const variantIds = [...new Set(body.lines.map((l) => l.variantId))]
      const names = new Map(
        tx
          .select({ id: variant.id, name: variant.name, active: variant.active })
          .from(variant)
          .where(inArray(variant.id, variantIds))
          .all()
          .map((v) => [v.id, v]),
      )
      for (const id of variantIds) {
        if (!names.get(id)?.active) {
          throw new HttpError(422, "UNKNOWN_PRODUCT", `Producto desconocido o inactivo: ${id}`)
        }
      }
      const chargeIds = body.charges.map((c) => c.chargeId)
      if (chargeIds.length) {
        const known = tx
          .select({ id: saleCharge.id })
          .from(saleCharge)
          .where(and(inArray(saleCharge.id, chargeIds), eq(saleCharge.active, true)))
          .all()
        if (known.length !== new Set(chargeIds).size) {
          throw new HttpError(422, "UNKNOWN_CHARGE", "Recargo desconocido o inactivo")
        }
      }
      const count = tx.select({ n: sql<number>`count(*)` }).from(quote).get()?.n ?? 0
      const number = `COT-${String(count + 1).padStart(6, "0")}`
      tx.insert(quote)
        .values({
          id: body.id,
          number,
          contactId: body.contactId ?? null,
          // Vale hasta el final del día `validDays` (en milisegundos desde ahora).
          validUntil: now + body.validDays * DAY_MS,
          ...discountColumns(body.saleDiscount),
          charges: body.charges.length ? body.charges : null,
          totalRefMinor: body.totalRefMinor,
          totalLegalMinor: body.totalLegalMinor,
          rateValue: body.rateValue,
          note: body.note?.trim() || null,
          createdBy: actorId,
          createdAt: now,
        })
        .run()
      body.lines.forEach((l, i) => {
        tx.insert(quoteLine)
          .values({
            id: uuidv7(now),
            quoteId: body.id,
            lineNo: i + 1,
            variantId: l.variantId,
            name: names.get(l.variantId)?.name ?? "",
            qtyMilli: l.qtyMilli,
            priceMinor: l.priceMinor,
            priceCurrency: l.priceCurrency,
            ...discountColumns(l.discount),
          })
          .run()
      })
      audit(tx, actorId, now, "quote.created", body.id, {
        number,
        contactId: body.contactId ?? null,
        totalLegalMinor: body.totalLegalMinor,
      })
      return quoteDetail(tx, body.id)
    },
    { behavior: "immediate" },
  )
}

/** Anula una cotización abierta (el cliente no la quiso). */
export function cancelQuote(db: Db, id: string, actorId: string, now: number): QuoteDetail {
  return db.transaction(
    (tx) => {
      const row = tx.select().from(quote).where(eq(quote.id, id)).get()
      if (!row) throw new HttpError(404, "NOT_FOUND", `No existe la cotización ${id}`)
      if (row.status !== "open") {
        throw new HttpError(409, "QUOTE_CLOSED", `La cotización ${row.number} ya no está abierta`)
      }
      tx.update(quote).set({ status: "cancelled", closedAt: now }).where(eq(quote.id, id)).run()
      audit(tx, actorId, now, "quote.cancelled", id, { number: row.number })
      return quoteDetail(tx, id)
    },
    { behavior: "immediate" },
  )
}
