import type { ExpenseBody, ExpenseCategory, Expenses } from "@millhiore/contracts"
import { auditLog, business, type Db, document, expenseCategory } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, asc, eq, gte, lt, sql } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { type PostContext, type PostedDocument, postDocumentIn } from "../../posting/post"
import { listDocuments } from "../documents/service"
import { advanceRecurring } from "../recurring/service"

// Categorías

const categoryColumns = {
  id: expenseCategory.id,
  name: expenseCategory.name,
  position: expenseCategory.position,
  active: expenseCategory.active,
  // Gastos vigentes: los originales menos los que se anularon (un reverso resta uno).
  expenseCount: sql<number>`coalesce((select sum(case when "d"."reverses_document_id" is null then 1 else -1 end)
    from "document" as "d" where "d"."expense_category_id" = "expense_category"."id"), 0)`,
}

export function listExpenseCategories(db: Db, opts: { all?: boolean } = {}): ExpenseCategory[] {
  return db
    .select(categoryColumns)
    .from(expenseCategory)
    .where(opts.all ? undefined : eq(expenseCategory.active, true))
    .orderBy(asc(expenseCategory.position), asc(expenseCategory.name))
    .all()
}

function categoryById(db: Db, id: string): ExpenseCategory {
  const row = db
    .select(categoryColumns)
    .from(expenseCategory)
    .where(eq(expenseCategory.id, id))
    .get()
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe la categoría ${id}`)
  return row
}

function duplicate(e: unknown): never {
  if (/UNIQUE/i.test(String((e as Error).cause ?? (e as Error).message))) {
    throw new HttpError(409, "DUPLICATE_NAME", "Ya existe una categoría de gasto con ese nombre")
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
      entityType: "expense_category",
      entityId: id,
      data,
    })
    .run()
}

export function createExpenseCategory(
  db: Db,
  name: string,
  actorId: string,
  now: number,
): ExpenseCategory {
  const id = uuidv7(now)
  try {
    const last = db
      .select({ max: sql<number>`coalesce(max(${expenseCategory.position}), 0)` })
      .from(expenseCategory)
      .get()
    db.insert(expenseCategory)
      .values({ id, name, position: (last?.max ?? 0) + 1 })
      .run()
  } catch (e) {
    duplicate(e)
  }
  const created = categoryById(db, id)
  audit(db, actorId, now, "expense.category.created", id, created)
  return created
}

export function updateExpenseCategory(
  db: Db,
  id: string,
  patch: { name?: string | undefined; position?: number | undefined; active?: boolean | undefined },
  actorId: string,
  now: number,
): ExpenseCategory {
  const before = categoryById(db, id)
  const set = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.position !== undefined ? { position: patch.position } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
  }
  try {
    if (Object.keys(set).length) {
      db.update(expenseCategory).set(set).where(eq(expenseCategory.id, id)).run()
    }
  } catch (e) {
    duplicate(e)
  }
  const after = categoryById(db, id)
  audit(db, actorId, now, "expense.category.updated", id, { before, after })
  return after
}

// Gastos

/** Registra un gasto: lo que costó, en qué se gastó y con qué se pagó. Idempotente por `id`. */
export function postExpense(db: Db, body: ExpenseBody, ctx: PostContext): PostedDocument {
  return db.transaction(
    (tx) => {
      const posted = postDocumentIn(
        tx,
        {
          id: body.id,
          type: "EXPENSE",
          terminalId: body.terminalId,
          currency: body.currency,
          rate: body.rate,
          lines: [],
          payments: body.payments,
          contactId: body.contactId ?? null,
          externalRef: body.externalRef,
          note: body.note || null,
          amountMinor: body.amountMinor,
          expenseCategoryId: body.categoryId,
          // Lo que queda a deber se le debe al proveedor en la moneda del gasto.
          creditMinor: body.creditMinor,
          creditCurrency: body.currency,
          dueAt: body.dueAt ?? null,
        },
        ctx,
      )
      // Registrar el gasto de un recurrente lo pasa al siguiente vencimiento (una sola vez).
      if (body.recurringId && !posted.duplicate) advanceRecurring(tx, body.recurringId)
      return posted
    },
    { behavior: "immediate" },
  )
}

/**
 * Los gastos de un rango (los más recientes primero) con lo gastado en total y por categoría,
 * en moneda legal y neto de anulaciones: un reverso trae el total con signo contrario.
 */
export function listExpenses(
  db: Db,
  opts: {
    from?: number | undefined
    to?: number | undefined
    categoryId?: string | undefined
    limit: number
  },
): Expenses {
  const legal = db.select({ legalCurrency: business.legalCurrency }).from(business).get()
  const rows = listDocuments(db, {
    types: ["EXPENSE"],
    from: opts.from,
    to: opts.to,
    expenseCategoryId: opts.categoryId,
    limit: opts.limit,
  })
  const where = and(
    eq(document.type, "EXPENSE"),
    opts.from === undefined ? undefined : gte(document.postedAt, opts.from),
    opts.to === undefined ? undefined : lt(document.postedAt, opts.to),
    opts.categoryId ? eq(document.expenseCategoryId, opts.categoryId) : undefined,
  )
  const grouped = db
    .select({
      categoryId: document.expenseCategoryId,
      name: sql<string | null>`${expenseCategory.name}`,
      count: sql<number>`sum(case when ${document.reversesDocumentId} is null then 1 else -1 end)`,
      totalLegalMinor: sql<number>`sum(${document.totalLegalMinor})`,
    })
    .from(document)
    .leftJoin(expenseCategory, eq(expenseCategory.id, document.expenseCategoryId))
    .where(where)
    .groupBy(document.expenseCategoryId)
    .all()
  const byCategory = grouped
    .map((g) => ({
      categoryId: g.categoryId,
      name: g.name ?? "Sin categoría",
      count: g.count,
      totalLegalMinor: g.totalLegalMinor,
    }))
    // Lo que se anuló por completo no aporta nada a la lista.
    .filter((g) => g.count !== 0 || g.totalLegalMinor !== 0)
    .sort((a, b) => b.totalLegalMinor - a.totalLegalMinor || a.name.localeCompare(b.name, "es"))
  return {
    legalCurrency: legal?.legalCurrency ?? "VES",
    rows,
    totalLegalMinor: byCategory.reduce((acc, g) => acc + g.totalLegalMinor, 0),
    byCategory,
  }
}
