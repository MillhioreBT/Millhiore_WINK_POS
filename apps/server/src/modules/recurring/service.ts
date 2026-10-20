import type {
  CreateRecurringExpenseBody,
  RecurringExpense,
  UpdateRecurringExpenseBody,
} from "@millhiore/contracts"
import {
  auditLog,
  business,
  contact,
  currency,
  type Db,
  expenseCategory,
  recurringExpense,
  terminal,
} from "@millhiore/db"
import { dayOfMonth, localDate, nextDueDay, uuidv7 } from "@millhiore/domain"
import { and, asc, eq, lte } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { postDocumentIn } from "../../posting/post"
import { getBusinessPair, rateAt } from "../rates/service"
import { postingContext } from "../settings/service"

type Reader = Pick<Db, "select">
type Row = typeof recurringExpense.$inferSelect

/** El día de hoy según el calendario del negocio. */
function todayOf(db: Reader, now: number): string {
  const biz = db.select({ timezone: business.timezone }).from(business).get()
  return localDate(now, biz?.timezone ?? "America/Caracas")
}

function audit(
  db: Pick<Db, "insert">,
  actorId: string | null,
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
      entityType: "recurring_expense",
      entityId: id,
      data,
    })
    .run()
}

function toApi(db: Reader, row: Row, today: string): RecurringExpense {
  const category = db
    .select({ name: expenseCategory.name })
    .from(expenseCategory)
    .where(eq(expenseCategory.id, row.categoryId))
    .get()
  const party = row.contactId
    ? db.select().from(contact).where(eq(contact.id, row.contactId)).get()
    : undefined
  return {
    id: row.id,
    note: row.note,
    categoryId: row.categoryId,
    categoryName: category?.name ?? "—",
    contactId: row.contactId,
    contact: party ?? null,
    currency: row.currency,
    amountMinor: row.amountMinor,
    frequency: row.frequency,
    nextDueDay: row.nextDueDay,
    auto: row.auto,
    active: row.active,
    due: row.active && row.nextDueDay <= today,
    lastError: row.lastError,
  }
}

/** Los recurrentes: primero los que ya vencieron, luego por fecha. Los pausados al final. */
export function listRecurring(db: Db, now: number): RecurringExpense[] {
  const today = todayOf(db, now)
  return db
    .select()
    .from(recurringExpense)
    .orderBy(asc(recurringExpense.nextDueDay), asc(recurringExpense.note))
    .all()
    .map((r) => toApi(db, r, today))
    .sort((a, b) => Number(b.active) - Number(a.active) || Number(b.due) - Number(a.due))
}

function get(db: Reader, id: string): Row {
  const row = db.select().from(recurringExpense).where(eq(recurringExpense.id, id)).get()
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe el gasto recurrente ${id}`)
  return row
}

/** Categoría activa, proveedor (no cliente) y moneda que existan; el automático exige proveedor. */
function check(
  db: Reader,
  v: { categoryId: string; contactId: string | null; currency: string; auto: boolean },
) {
  const category = db
    .select({ active: expenseCategory.active })
    .from(expenseCategory)
    .where(eq(expenseCategory.id, v.categoryId))
    .get()
  if (!category?.active) {
    throw new HttpError(422, "UNKNOWN_CATEGORY", "Elige una categoría de gasto activa")
  }
  if (!db.select().from(currency).where(eq(currency.code, v.currency)).get()) {
    throw new HttpError(422, "UNKNOWN_CURRENCY", `Moneda desconocida: ${v.currency}`)
  }
  if (v.contactId) {
    const party = db.select().from(contact).where(eq(contact.id, v.contactId)).get()
    if (!party?.active || party.kind === "customer") {
      throw new HttpError(422, "UNKNOWN_CONTACT", "Elige un proveedor activo")
    }
  } else if (v.auto) {
    throw new HttpError(
      422,
      "SUPPLIER_REQUIRED",
      "Para que se registre solo hace falta el proveedor: queda a deber a él",
    )
  }
}

export function createRecurring(
  db: Db,
  body: CreateRecurringExpenseBody,
  actorId: string,
  now: number,
): RecurringExpense {
  const contactId = body.contactId ?? null
  check(db, { categoryId: body.categoryId, contactId, currency: body.currency, auto: body.auto })
  const id = uuidv7(now)
  db.insert(recurringExpense)
    .values({
      id,
      note: body.note,
      categoryId: body.categoryId,
      contactId,
      currency: body.currency,
      amountMinor: body.amountMinor,
      frequency: body.frequency,
      anchorDay: dayOfMonth(body.firstDueDay),
      nextDueDay: body.firstDueDay,
      auto: body.auto,
      createdAt: now,
    })
    .run()
  audit(db, actorId, now, "recurring.created", id, {
    note: body.note,
    amountMinor: body.amountMinor,
  })
  return toApi(db, get(db, id), todayOf(db, now))
}

export function updateRecurring(
  db: Db,
  id: string,
  patch: UpdateRecurringExpenseBody,
  actorId: string,
  now: number,
): RecurringExpense {
  const before = get(db, id)
  const merged = {
    categoryId: patch.categoryId ?? before.categoryId,
    contactId: patch.contactId === undefined ? before.contactId : patch.contactId,
    currency: patch.currency ?? before.currency,
    auto: patch.auto ?? before.auto,
  }
  check(db, merged)
  const set = {
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    categoryId: merged.categoryId,
    contactId: merged.contactId,
    currency: merged.currency,
    ...(patch.amountMinor !== undefined ? { amountMinor: patch.amountMinor } : {}),
    ...(patch.frequency !== undefined ? { frequency: patch.frequency } : {}),
    // Mover el vencimiento fija el día de referencia de los siguientes meses.
    ...(patch.nextDueDay !== undefined
      ? { nextDueDay: patch.nextDueDay, anchorDay: dayOfMonth(patch.nextDueDay) }
      : {}),
    auto: merged.auto,
    ...(patch.active !== undefined ? { active: patch.active } : {}),
    // Cualquier cambio da otra oportunidad a lo que no se pudo generar.
    lastError: null,
  }
  db.update(recurringExpense).set(set).where(eq(recurringExpense.id, id)).run()
  audit(db, actorId, now, "recurring.updated", id, { before: before.note, patch })
  return toApi(db, get(db, id), todayOf(db, now))
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** Pasa un recurrente a su siguiente vencimiento (después de registrar el gasto de este). */
export function advanceRecurring(tx: Tx | Db, id: string): void {
  const row = get(tx, id)
  tx.update(recurringExpense)
    .set({
      nextDueDay: nextDueDay(row.frequency, row.nextDueDay, row.anchorDay),
      lastError: null,
    })
    .where(eq(recurringExpense.id, id))
    .run()
}

/** Cuántos gastos se generan de golpe como máximo por recurrente (la PC pudo estar meses apagada). */
const MAX_CATCH_UP = 24

export interface GenerateReport {
  generated: number
  failed: number
}

/**
 * Genera el gasto a deber de cada recurrente automático que ya venció: un gasto por periodo
 * atrasado, al proveedor, con la fecha límite que le dé su crédito. Cada gasto y el paso al
 * siguiente vencimiento van juntos en una transacción, así correrlo dos veces no duplica nada.
 * Lo que no se pueda generar (sin tasa, proveedor inactivo…) queda anotado en el recurrente.
 */
export function generateDueRecurring(db: Db, now: number): GenerateReport {
  const report: GenerateReport = { generated: 0, failed: 0 }
  const biz = db.select().from(business).get()
  const term = db
    .select({ id: terminal.id })
    .from(terminal)
    .where(eq(terminal.active, true))
    .orderBy(asc(terminal.code))
    .get()
  if (!(biz && term)) return report
  const today = localDate(now, biz.timezone)
  const due = db
    .select()
    .from(recurringExpense)
    .where(
      and(
        eq(recurringExpense.active, true),
        eq(recurringExpense.auto, true),
        lte(recurringExpense.nextDueDay, today),
      ),
    )
    .orderBy(asc(recurringExpense.nextDueDay))
    .all()

  for (const r of due) {
    let current = r
    for (let n = 0; n < MAX_CATCH_UP && current.nextDueDay <= today; n++) {
      try {
        const pair = getBusinessPair(db)
        const stored =
          current.currency === biz.legalCurrency || !pair
            ? undefined
            : rateAt(db, pair.base, pair.quote, now)
        if (current.currency !== biz.legalCurrency && !stored) {
          throw new Error("No hay una tasa de cambio vigente")
        }
        const ctx = postingContext(db, now, null)
        db.transaction(
          (tx) => {
            postDocumentIn(
              tx,
              {
                id: uuidv7(now),
                type: "EXPENSE",
                terminalId: term.id,
                currency: current.currency,
                rate: stored
                  ? { base: stored.base, quote: stored.quote, value: stored.value }
                  : null,
                lines: [],
                payments: [],
                contactId: current.contactId,
                note: current.note,
                amountMinor: current.amountMinor,
                expenseCategoryId: current.categoryId,
                creditMinor: current.amountMinor,
                creditCurrency: current.currency,
              },
              ctx,
            )
            advanceRecurring(tx, current.id)
          },
          { behavior: "immediate" },
        )
        audit(db, null, now, "recurring.generated", current.id, { day: current.nextDueDay })
        report.generated++
        current = get(db, current.id)
      } catch (e) {
        db.update(recurringExpense)
          .set({ lastError: e instanceof Error ? e.message : String(e) })
          .where(eq(recurringExpense.id, current.id))
          .run()
        report.failed++
        break
      }
    }
  }
  return report
}
