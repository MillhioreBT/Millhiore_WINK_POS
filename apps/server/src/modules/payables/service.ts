import type { Payables } from "@millhiore/contracts"
import { contact, type Db, document, expenseCategory } from "@millhiore/db"
import { agingBucket, emptyAging } from "@millhiore/domain"
import { eq, inArray } from "drizzle-orm"
import { openPayables } from "../../posting/receivables"

/** A quién se le debe, cuánto, desde cuándo y cuánto de eso ya venció, con la antigüedad de saldos. */
export function payables(db: Db, now: number): Payables {
  const debts = openPayables(db)
  if (debts.length === 0) return { suppliers: [], totals: [] }

  const people = new Map(
    db
      .select({ id: contact.id, name: contact.name, taxId: contact.taxId, phone: contact.phone })
      .from(contact)
      .where(inArray(contact.id, [...new Set(debts.map((d) => d.contactId))]))
      .all()
      .map((c) => [c.id, c]),
  )
  const details = new Map(
    db
      .select({
        id: document.id,
        externalRef: document.externalRef,
        category: expenseCategory.name,
      })
      .from(document)
      .leftJoin(expenseCategory, eq(expenseCategory.id, document.expenseCategoryId))
      .where(
        inArray(
          document.id,
          debts.map((d) => d.id),
        ),
      )
      .all()
      .map((d) => [d.id, d]),
  )

  const rows = new Map<string, Payables["suppliers"][number]>()
  for (const d of debts) {
    const key = `${d.contactId}|${d.currency}`
    const person = people.get(d.contactId)
    const row = rows.get(key) ?? {
      contactId: d.contactId,
      name: person?.name ?? d.contactId,
      taxId: person?.taxId ?? null,
      phone: person?.phone ?? null,
      currency: d.currency,
      outstandingMinor: 0,
      overdueMinor: 0,
      openCount: 0,
      oldestPostedAt: d.postedAt,
      nextDueAt: null,
      aging: emptyAging(),
      open: [],
    }
    const overdue = d.dueAt !== null && d.dueAt < now
    const detail = details.get(d.id)
    row.outstandingMinor += d.outstandingMinor
    if (overdue) row.overdueMinor += d.outstandingMinor
    row.aging[agingBucket(d.dueAt, now)] += d.outstandingMinor
    row.openCount += 1
    row.oldestPostedAt = Math.min(row.oldestPostedAt, d.postedAt)
    if (d.dueAt !== null) row.nextDueAt = Math.min(row.nextDueAt ?? d.dueAt, d.dueAt)
    row.open.push({
      id: d.id,
      number: d.number,
      postedAt: d.postedAt,
      dueAt: d.dueAt,
      currency: d.currency,
      creditMinor: d.creditMinor,
      paidMinor: d.paidMinor,
      outstandingMinor: d.outstandingMinor,
      overdue,
      kind: d.type === "EXPENSE" || d.type === "DEBT_OUT" ? d.type : "PURCHASE",
      label:
        d.type === "EXPENSE"
          ? d.note || detail?.category || "Gasto"
          : d.type === "DEBT_OUT"
            ? d.note || "Deuda"
            : "Compra",
      externalRef: detail?.externalRef ?? null,
    })
    rows.set(key, row)
  }

  const suppliers = [...rows.values()].sort(
    (a, b) =>
      a.currency.localeCompare(b.currency) ||
      b.outstandingMinor - a.outstandingMinor ||
      a.name.localeCompare(b.name, "es"),
  )
  const totals = new Map<string, Payables["totals"][number]>()
  for (const s of suppliers) {
    const t = totals.get(s.currency) ?? {
      currency: s.currency,
      outstandingMinor: 0,
      overdueMinor: 0,
      suppliers: 0,
      aging: emptyAging(),
    }
    t.outstandingMinor += s.outstandingMinor
    t.overdueMinor += s.overdueMinor
    t.suppliers += 1
    for (const k of Object.keys(t.aging) as (keyof typeof t.aging)[]) t.aging[k] += s.aging[k]
    totals.set(s.currency, t)
  }
  return { suppliers, totals: [...totals.values()] }
}
