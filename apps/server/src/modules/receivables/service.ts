import type { OpenSale, Receivables, Statement } from "@millhiore/contracts"
import { business, contact, currency, type Db, document } from "@millhiore/db"
import { agingBucket, type CurrencyBook, emptyAging } from "@millhiore/domain"
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { HttpError } from "../../http/errors"
import { type OpenSale as Open, openSales, owedInReference } from "../../posting/receivables"

const isOverdue = (sale: Pick<Open, "dueAt">, now: number) =>
  sale.dueAt !== null && sale.dueAt < now

function toApi(sale: Open, now: number): OpenSale {
  return {
    id: sale.id,
    number: sale.number,
    postedAt: sale.postedAt,
    dueAt: sale.dueAt,
    currency: sale.currency,
    creditMinor: sale.creditMinor,
    paidMinor: sale.paidMinor,
    outstandingMinor: sale.outstandingMinor,
    overdue: isOverdue(sale, now),
  }
}

/** Cuánto debe cada cliente, y cuánto de eso ya venció. */
export function receivables(db: Db, now: number): Receivables {
  const sales = openSales(db)
  if (sales.length === 0) return { customers: [], totals: [] }

  const people = new Map(
    db
      .select({ id: contact.id, name: contact.name, taxId: contact.taxId, phone: contact.phone })
      .from(contact)
      .where(inArray(contact.id, [...new Set(sales.map((s) => s.contactId))]))
      .all()
      .map((c) => [c.id, c]),
  )

  const rows = new Map<string, Receivables["customers"][number]>()
  for (const s of sales) {
    const key = `${s.contactId}|${s.currency}`
    const person = people.get(s.contactId)
    const row = rows.get(key) ?? {
      contactId: s.contactId,
      name: person?.name ?? s.contactId,
      taxId: person?.taxId ?? null,
      phone: person?.phone ?? null,
      currency: s.currency,
      outstandingMinor: 0,
      overdueMinor: 0,
      openCount: 0,
      oldestPostedAt: s.postedAt,
      nextDueAt: null,
      aging: emptyAging(),
    }
    row.aging[agingBucket(s.dueAt, now)] += s.outstandingMinor
    row.outstandingMinor += s.outstandingMinor
    if (isOverdue(s, now)) row.overdueMinor += s.outstandingMinor
    row.openCount += 1
    row.oldestPostedAt = Math.min(row.oldestPostedAt, s.postedAt)
    if (s.dueAt !== null) row.nextDueAt = Math.min(row.nextDueAt ?? s.dueAt, s.dueAt)
    rows.set(key, row)
  }

  const customers = [...rows.values()].sort(
    (a, b) =>
      a.currency.localeCompare(b.currency) ||
      b.outstandingMinor - a.outstandingMinor ||
      a.name.localeCompare(b.name, "es"),
  )
  const totals = new Map<string, Receivables["totals"][number]>()
  for (const c of customers) {
    const t = totals.get(c.currency) ?? {
      currency: c.currency,
      outstandingMinor: 0,
      overdueMinor: 0,
      customers: 0,
      aging: emptyAging(),
    }
    for (const k of Object.keys(t.aging) as (keyof typeof t.aging)[]) t.aging[k] += c.aging[k]
    t.outstandingMinor += c.outstandingMinor
    t.overdueMinor += c.overdueMinor
    t.customers += 1
    totals.set(c.currency, t)
  }
  return { customers, totals: [...totals.values()] }
}

/** Estado de cuenta: lo que debe venta por venta y el historial de fiados y abonos. */
export function statement(db: Db, contactId: string, now: number): Statement {
  const person = db.select().from(contact).where(eq(contact.id, contactId)).get()
  if (!person) throw new HttpError(404, "NOT_FOUND", `No existe el contacto ${contactId}`)
  const biz = db.select().from(business).get()
  if (!biz) throw new HttpError(409, "NOT_CONFIGURED", "El negocio aún no está configurado")
  const book: CurrencyBook = Object.fromEntries(
    db
      .select()
      .from(currency)
      .all()
      .map((c) => [c.code, { code: c.code, decimals: c.decimals }]),
  )

  const open = openSales(db, { contactId })
  const balances = new Map<string, Statement["balances"][number]>()
  for (const s of open) {
    const row = balances.get(s.currency) ?? {
      currency: s.currency,
      outstandingMinor: 0,
      overdueMinor: 0,
    }
    row.outstandingMinor += s.outstandingMinor
    if (isOverdue(s, now)) row.overdueMinor += s.outstandingMinor
    balances.set(s.currency, row)
  }

  const reversal = alias(document, "reversal")
  const movements = db
    .select({
      id: document.id,
      number: document.number,
      type: document.type,
      postedAt: document.postedAt,
      currency: document.currency,
      creditMinor: document.creditMinor,
      creditCurrency: document.creditCurrency,
      totalMinor: document.totalMinor,
      reversedBy: reversal.id,
    })
    .from(document)
    .leftJoin(reversal, eq(reversal.reversesDocumentId, document.id))
    .where(
      and(
        eq(document.contactId, contactId),
        isNull(document.reversesDocumentId),
        or(eq(document.type, "PAYMENT_IN"), eq(document.type, "SALE")),
      ),
    )
    .orderBy(desc(document.postedAt), desc(document.id))
    .limit(300)
    .all()
    .flatMap((d): Statement["movements"] => {
      if (d.type === "PAYMENT_IN") {
        return [
          {
            id: d.id,
            number: d.number,
            type: "PAYMENT_IN",
            postedAt: d.postedAt,
            currency: d.currency,
            amountMinor: d.totalMinor,
            voided: d.reversedBy !== null,
          },
        ]
      }
      // De las ventas solo interesan las que se dejaron a crédito.
      // Lo fiado se debe en la moneda de la deuda (dólares), no en la de la factura.
      return d.creditMinor > 0
        ? [
            {
              id: d.id,
              number: d.number,
              type: "SALE",
              postedAt: d.postedAt,
              currency: d.creditCurrency ?? d.currency,
              amountMinor: d.creditMinor,
              voided: d.reversedBy !== null,
            },
          ]
        : []
    })

  return {
    contact: person,
    referenceCurrency: biz.referenceCurrency,
    owedReferenceMinor: owedInReference(open, biz.referenceCurrency, book),
    balances: [...balances.values()],
    open: open.map((s) => toApi(s, now)),
    movements,
  }
}
