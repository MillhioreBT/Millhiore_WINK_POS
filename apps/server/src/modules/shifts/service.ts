import type { CloseShiftBody, OpenShiftBody, Shift, ShiftReport } from "@millhiore/contracts"
import {
  account,
  accountMove,
  auditLog,
  business,
  cashShift,
  cashShiftAccount,
  type Db,
  document,
  documentTax,
  outbox,
  payment,
  paymentMethod,
  terminal,
  user,
} from "@millhiore/db"
import { exchangeRate, isUuidv7, uuidv7 } from "@millhiore/domain"
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { HttpError } from "../../http/errors"
import {
  type PostContext,
  postDocumentIn,
  requireLocalServer,
  requireOwnBranch,
} from "../../posting/post"
import { inBranches } from "../branches/service"
import { rateAt } from "../rates/service"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Db | Tx

/** Cuentas de efectivo activas: las que se cuentan en la gaveta. */
function cashAccounts(db: Reader) {
  return db
    .select({ id: account.id, name: account.name, currency: account.currency })
    .from(account)
    .where(and(eq(account.kind, "cash"), eq(account.active, true)))
    .orderBy(asc(account.name))
    .all()
}

/**
 * Lo que debe haber en la gaveta de una caja para una cuenta de efectivo: lo que movieron los
 * documentos de esa caja. Con varias cajas, cada una lleva su parte de la misma cuenta («Efectivo
 * Bs») y su propio turno; con una sola, es el saldo de la cuenta.
 */
function drawerBalance(db: Reader, terminalId: string, accountId: string): number {
  return (
    db
      .select({ amount: sql<number>`coalesce(sum(${accountMove.amountMinor}), 0)` })
      .from(accountMove)
      .innerJoin(document, eq(document.id, accountMove.documentId))
      .where(and(eq(accountMove.accountId, accountId), eq(document.terminalId, terminalId)))
      .get()?.amount ?? 0
  )
}

function countsByAccount(
  counts: OpenShiftBody["counts"],
  accounts: { id: string; name: string }[],
) {
  const map = new Map(counts.map((c) => [c.accountId, c]))
  for (const c of counts) {
    if (!accounts.some((a) => a.id === c.accountId)) {
      throw new HttpError(422, "UNKNOWN_ACCOUNT", `No es una cuenta de efectivo: ${c.accountId}`)
    }
  }
  for (const a of accounts) {
    if (!map.has(a.id)) throw new HttpError(422, "MISSING_COUNT", `Falta el conteo de ${a.name}`)
  }
  return map
}

/**
 * Asienta una diferencia de arqueo como ingreso (sobrante) o retiro (faltante) de caja, dentro
 * de la transacción del turno. Devuelve el id del documento.
 */
function postDifference(
  tx: Tx,
  ctx: PostContext,
  input: { terminalId: string; accountId: string; currency: string; diff: number; note: string },
): string {
  const method = tx
    .select({ id: paymentMethod.id })
    .from(paymentMethod)
    .where(and(eq(paymentMethod.accountId, input.accountId), eq(paymentMethod.active, true)))
    .orderBy(asc(paymentMethod.id))
    .get()
  if (!method) {
    throw new HttpError(409, "NO_METHOD", `La cuenta ${input.accountId} no tiene método de cobro`)
  }
  const biz = tx.select().from(business).get()
  let rate = null
  if (biz && input.currency !== biz.legalCurrency) {
    const stored = rateAt(tx, input.currency, biz.legalCurrency, ctx.now)
    if (!stored) {
      throw new HttpError(
        409,
        "NO_RATE",
        `Carga la tasa del día: hace falta para asentar la diferencia en ${input.currency}`,
      )
    }
    rate = exchangeRate(stored.base, stored.quote, stored.value)
  }
  const id = uuidv7(ctx.now)
  postDocumentIn(
    tx,
    {
      id,
      type: input.diff > 0 ? "CASH_IN" : "CASH_OUT",
      terminalId: input.terminalId,
      currency: input.currency,
      rate,
      lines: [],
      payments: [
        {
          id: uuidv7(ctx.now),
          paymentMethodId: method.id,
          currency: input.currency,
          amountMinor: Math.abs(input.diff),
          rate: null,
        },
      ],
      note: input.note,
    },
    { ...ctx, requireShift: false },
  )
  return id
}

function audit(tx: Tx, ctx: PostContext, action: string, shiftId: string, data: unknown) {
  tx.insert(auditLog)
    .values({
      id: uuidv7(ctx.now),
      at: ctx.now,
      actorId: ctx.actorId,
      action,
      entityType: "cash_shift",
      entityId: shiftId,
      data,
    })
    .run()
  tx.insert(outbox)
    .values({
      id: uuidv7(ctx.now),
      type: action,
      payload: { shiftId, ...(data as object) },
      createdAt: ctx.now,
    })
    .run()
}

/**
 * Abre el turno de una terminal contando el efectivo de cada cuenta. Si lo contado no coincide
 * con los libros (alguien sacó o metió dinero sin registrarlo), la diferencia se asienta ya.
 * Reintentar con el mismo `id` devuelve el turno abierto.
 */
export function openShift(db: Db, input: OpenShiftBody, ctx: PostContext): Shift {
  if (!isUuidv7(input.id)) throw new HttpError(422, "INVALID_ID", "El id debe ser un UUIDv7")
  return db.transaction(
    (tx) => {
      const existing = tx.select().from(cashShift).where(eq(cashShift.id, input.id)).get()
      if (existing) return getShift(tx, existing.id)
      const term = tx.select().from(terminal).where(eq(terminal.id, input.terminalId)).get()
      if (!term?.active) {
        throw new HttpError(422, "UNKNOWN_TERMINAL", `Terminal desconocida: ${input.terminalId}`)
      }
      const open = tx
        .select({ id: cashShift.id })
        .from(cashShift)
        .where(and(eq(cashShift.terminalId, term.id), eq(cashShift.status, "open")))
        .get()
      if (open) throw new HttpError(409, "SHIFT_OPEN", `${term.name} ya tiene un turno abierto`)
      requireOwnBranch(tx, ctx, [term.locationId])
      requireLocalServer(tx, [term.locationId])

      const accounts = cashAccounts(tx)
      const counts = countsByAccount(input.counts, accounts)
      tx.insert(cashShift)
        .values({
          id: input.id,
          terminalId: term.id,
          status: "open",
          openedBy: ctx.actorId,
          openedAt: ctx.now,
          openingNote: input.note ?? null,
        })
        .run()
      for (const a of accounts) {
        const expected = drawerBalance(tx, term.id, a.id)
        const counted = counts.get(a.id)?.countedMinor ?? 0
        // La primera vez que se cuenta una gaveta, lo que hay es el fondo inicial, no un sobrante.
        const firstCount = !tx
          .select({ id: cashShiftAccount.shiftId })
          .from(cashShiftAccount)
          .innerJoin(cashShift, eq(cashShift.id, cashShiftAccount.shiftId))
          .where(and(eq(cashShiftAccount.accountId, a.id), eq(cashShift.terminalId, term.id)))
          .get()
        const adjustment =
          counted === expected
            ? null
            : postDifference(tx, ctx, {
                terminalId: term.id,
                accountId: a.id,
                currency: a.currency,
                diff: counted - expected,
                note:
                  firstCount && counted > expected
                    ? "Fondo inicial de caja"
                    : `Diferencia al abrir el turno (${counted > expected ? "sobrante" : "faltante"})`,
              })
        tx.insert(cashShiftAccount)
          .values({
            shiftId: input.id,
            accountId: a.id,
            openingExpectedMinor: expected,
            openingCountedMinor: counted,
            openingAdjustmentId: adjustment,
          })
          .run()
      }
      audit(tx, ctx, "shift.opened", input.id, { terminalId: term.id })
      return getShift(tx, input.id)
    },
    { behavior: "immediate" },
  )
}

/**
 * Cierra el turno con el arqueo de cada cuenta de efectivo. Lo esperado es lo que la caja tiene de
 * esa cuenta en los libros; la diferencia (sobrante o faltante) se asienta como ingreso o retiro, de modo
 * que el turno siguiente arranca con los libros cuadrados con la gaveta.
 */
export function closeShift(
  db: Db,
  shiftId: string,
  input: CloseShiftBody,
  ctx: PostContext,
): Shift {
  return db.transaction(
    (tx) => {
      const shift = tx.select().from(cashShift).where(eq(cashShift.id, shiftId)).get()
      if (!shift) throw new HttpError(404, "NOT_FOUND", `No existe el turno ${shiftId}`)
      if (shift.status === "closed")
        throw new HttpError(409, "SHIFT_CLOSED", "El turno ya está cerrado")
      const term = tx.select().from(terminal).where(eq(terminal.id, shift.terminalId)).get()
      if (term) {
        requireOwnBranch(tx, ctx, [term.locationId])
        requireLocalServer(tx, [term.locationId])
      }
      const rows = tx
        .select({
          accountId: cashShiftAccount.accountId,
          name: account.name,
          currency: account.currency,
        })
        .from(cashShiftAccount)
        .innerJoin(account, eq(account.id, cashShiftAccount.accountId))
        .where(eq(cashShiftAccount.shiftId, shiftId))
        .all()
      const counts = countsByAccount(
        input.counts,
        rows.map((r) => ({ id: r.accountId, name: r.name })),
      )
      const differences: { account: string; currency: string; diff: number }[] = []
      for (const r of rows) {
        const count = counts.get(r.accountId)
        const expected = drawerBalance(tx, shift.terminalId, r.accountId)
        const counted = count?.countedMinor ?? 0
        const diff = counted - expected
        const adjustment =
          diff === 0
            ? null
            : postDifference(tx, ctx, {
                terminalId: shift.terminalId,
                accountId: r.accountId,
                currency: r.currency,
                diff,
                note: `${diff > 0 ? "Sobrante" : "Faltante"} al cerrar el turno`,
              })
        if (diff !== 0) differences.push({ account: r.name, currency: r.currency, diff })
        tx.update(cashShiftAccount)
          .set({
            closingExpectedMinor: expected,
            closingCountedMinor: counted,
            closingDenominations: count?.denominations ?? null,
            closingAdjustmentId: adjustment,
          })
          .where(
            and(eq(cashShiftAccount.shiftId, shiftId), eq(cashShiftAccount.accountId, r.accountId)),
          )
          .run()
      }
      tx.update(cashShift)
        .set({
          status: "closed",
          closedAt: ctx.now,
          closedBy: ctx.actorId,
          closingNote: input.note ?? null,
        })
        .where(eq(cashShift.id, shiftId))
        .run()
      audit(tx, ctx, "shift.closed", shiftId, { differences })
      return getShift(tx, shiftId)
    },
    { behavior: "immediate" },
  )
}

const opener = alias(user, "opener")
const closer = alias(user, "closer")

export function getShift(db: Reader, shiftId: string): Shift {
  const s = db
    .select({
      id: cashShift.id,
      terminalId: cashShift.terminalId,
      terminalName: terminal.name,
      status: cashShift.status,
      openedAt: cashShift.openedAt,
      openedBy: opener.name,
      openingNote: cashShift.openingNote,
      closedAt: cashShift.closedAt,
      closedBy: closer.name,
      closingNote: cashShift.closingNote,
    })
    .from(cashShift)
    .innerJoin(terminal, eq(terminal.id, cashShift.terminalId))
    .leftJoin(opener, eq(opener.id, cashShift.openedBy))
    .leftJoin(closer, eq(closer.id, cashShift.closedBy))
    .where(eq(cashShift.id, shiftId))
    .get()
  if (!s) throw new HttpError(404, "NOT_FOUND", `No existe el turno ${shiftId}`)
  const accounts = db
    .select({
      accountId: cashShiftAccount.accountId,
      accountName: account.name,
      currency: account.currency,
      openingExpectedMinor: cashShiftAccount.openingExpectedMinor,
      openingCountedMinor: cashShiftAccount.openingCountedMinor,
      closingExpectedMinor: cashShiftAccount.closingExpectedMinor,
      closingCountedMinor: cashShiftAccount.closingCountedMinor,
      closingDenominations: cashShiftAccount.closingDenominations,
    })
    .from(cashShiftAccount)
    .innerJoin(account, eq(account.id, cashShiftAccount.accountId))
    .where(eq(cashShiftAccount.shiftId, shiftId))
    .orderBy(asc(account.name))
    .all()
    .map((a) => ({
      ...a,
      differenceMinor:
        a.closingCountedMinor === null || a.closingExpectedMinor === null
          ? null
          : a.closingCountedMinor - a.closingExpectedMinor,
    }))
  return { ...s, accounts }
}

export function currentShift(db: Reader, terminalId: string): Shift | null {
  const open = db
    .select({ id: cashShift.id })
    .from(cashShift)
    .where(and(eq(cashShift.terminalId, terminalId), eq(cashShift.status, "open")))
    .get()
  return open ? getShift(db, open.id) : null
}

/** Los últimos turnos (con `branchIds`, solo los de las cajas de esas sucursales). */
export function listShifts(
  db: Db,
  limit: number,
  branchIds: readonly string[] | null = null,
): Shift[] {
  return db
    .select({ id: cashShift.id })
    .from(cashShift)
    .innerJoin(terminal, eq(terminal.id, cashShift.terminalId))
    .where(inBranches(terminal.locationId, branchIds))
    .orderBy(desc(cashShift.openedAt))
    .limit(limit)
    .all()
    .map((s) => getShift(db, s.id))
}

/** Resumen del turno: ventas, cobrado por método y movimientos de caja. */
export function shiftReport(db: Db, shiftId: string): ShiftReport {
  const shift = getShift(db, shiftId)
  const biz = db.select().from(business).get()
  const docs = db.select().from(document).where(eq(document.shiftId, shiftId)).all()
  const sales = docs.filter((d) => d.type === "SALE")
  const saleIds = sales.map((d) => d.id)
  // Los abonos de clientes también entran a la gaveta y a las cuentas del turno.
  const collections = docs.filter((d) => d.type === "PAYMENT_IN")
  // Los gastos pagados con efectivo de esta caja: salen de la gaveta (el arqueo ya los descuenta).
  const expenses = docs.filter((d) => d.type === "EXPENSE")
  // Los pagos a proveedores también salen de la gaveta (o de las cuentas) en el turno.
  const supplierPayments = docs.filter((d) => d.type === "PAYMENT_OUT")
  // Lo devuelto a los proveedores: lo que reembolsan puede entrar a la gaveta.
  const supplierReturns = docs.filter((d) => d.type === "PURCHASE_RETURN")
  // Las devoluciones restan de las ventas: su importe y el dinero que sale entran con signo contrario.
  const returns = docs.filter((d) => d.type === "RETURN")
  const returnIds = new Set(returns.map((d) => d.id))
  const takingIds = [...saleIds, ...collections.map((d) => d.id), ...returnIds]
  const voided = new Set(sales.filter((d) => d.reversesDocumentId).map((d) => d.reversesDocumentId))
  const taxRows = takingIds.length
    ? db
        .select()
        .from(documentTax)
        .where(inArray(documentTax.documentId, [...saleIds, ...returnIds]))
        .all()
    : []

  const byMethod = new Map<
    string,
    {
      methodId: string
      methodName: string
      currency: string
      amountMinor: number
      commissionMinor: number
    }
  >()
  if (takingIds.length) {
    for (const p of db
      .select({
        documentId: payment.documentId,
        methodId: payment.paymentMethodId,
        methodName: paymentMethod.name,
        currency: payment.currency,
        amountMinor: payment.amountMinor,
        commissionMinor: payment.commissionMinor,
      })
      .from(payment)
      .innerJoin(paymentMethod, eq(paymentMethod.id, payment.paymentMethodId))
      .where(inArray(payment.documentId, takingIds))
      .all()) {
      const key = `${p.methodId}|${p.currency}`
      const row = byMethod.get(key) ?? {
        methodId: p.methodId,
        methodName: p.methodName,
        currency: p.currency,
        amountMinor: 0,
        commissionMinor: 0,
      }
      row.amountMinor += returnIds.has(p.documentId) ? -p.amountMinor : p.amountMinor
      row.commissionMinor += p.commissionMinor
      byMethod.set(key, row)
    }
  }

  // Propinas por quien las recibe ("" = el equipo); los reversos del turno las restan.
  const tipTotals = new Map<string, number>()
  for (const d of sales) {
    if (d.tipLegalMinor === 0) continue
    const key = d.tipUserId ?? ""
    tipTotals.set(key, (tipTotals.get(key) ?? 0) + d.tipLegalMinor)
  }
  const tipUserIds = [...tipTotals.keys()].filter(Boolean)
  const tipNames = new Map(
    tipUserIds.length
      ? db
          .select({ id: user.id, name: user.name })
          .from(user)
          .where(inArray(user.id, tipUserIds))
          .all()
          .map((u) => [u.id, u.name])
      : [],
  )

  const adjustments = new Set(
    shift.accounts.length
      ? db
          .select({
            o: cashShiftAccount.openingAdjustmentId,
            c: cashShiftAccount.closingAdjustmentId,
          })
          .from(cashShiftAccount)
          .where(eq(cashShiftAccount.shiftId, shiftId))
          .all()
          .flatMap((r) => [r.o, r.c])
          .filter((id): id is string => id !== null)
      : [],
  )

  return {
    ...shift,
    legalCurrency: biz?.legalCurrency ?? "VES",
    sales: {
      count: sales.filter((d) => !d.reversesDocumentId).length,
      voided: voided.size,
      totalLegalMinor:
        sales.reduce((acc, d) => acc + d.totalLegalMinor, 0) -
        returns.reduce((acc, d) => acc + d.totalLegalMinor, 0),
      taxLegalMinor: taxRows.reduce(
        (acc, t) => acc + (returnIds.has(t.documentId) ? -t.taxLegalMinor : t.taxLegalMinor),
        0,
      ),
      surchargeLegalMinor: sales.reduce((acc, d) => acc + d.surchargeLegalMinor, 0),
      creditLegalMinor: sales.reduce((acc, d) => acc + d.creditLegalMinor, 0),
      discountLegalMinor:
        sales.reduce((acc, d) => acc + d.discountLegalMinor, 0) -
        returns.reduce((acc, d) => acc + d.discountLegalMinor, 0),
      returnsLegalMinor: returns.reduce((acc, d) => acc + d.totalLegalMinor, 0),
    },
    collections: {
      count: collections.filter((d) => !d.reversesDocumentId).length,
      totalLegalMinor: collections.reduce((acc, d) => acc + d.totalLegalMinor, 0),
    },
    expenses: {
      count: expenses.reduce((acc, d) => acc + (d.reversesDocumentId ? -1 : 1), 0),
      totalLegalMinor: expenses.reduce((acc, d) => acc + d.totalLegalMinor, 0),
    },
    supplierPayments: {
      count: supplierPayments.reduce((acc, d) => acc + (d.reversesDocumentId ? -1 : 1), 0),
      totalLegalMinor: supplierPayments.reduce((acc, d) => acc + d.totalLegalMinor, 0),
    },
    supplierReturns: {
      count: supplierReturns.reduce((acc, d) => acc + (d.reversesDocumentId ? -1 : 1), 0),
      totalLegalMinor: supplierReturns.reduce((acc, d) => acc + d.totalLegalMinor, 0),
    },
    tips: [...tipTotals]
      .filter(([, total]) => total !== 0)
      .map(([id, total]) => ({
        userId: id || null,
        name: id ? (tipNames.get(id) ?? id) : "Todo el equipo",
        totalLegalMinor: total,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "es")),
    byMethod: [...byMethod.values()]
      .filter((m) => m.amountMinor !== 0)
      .sort((a, b) => a.methodName.localeCompare(b.methodName, "es")),
    cashMovements: docs
      .filter(
        (d): d is typeof d & { type: "CASH_IN" | "CASH_OUT" } =>
          d.type === "CASH_IN" || d.type === "CASH_OUT",
      )
      .sort((a, b) => a.postedAt - b.postedAt)
      .map((d) => ({
        id: d.id,
        number: d.number,
        type: d.type,
        currency: d.currency,
        totalMinor: d.totalMinor,
        note: d.note,
        postedAt: d.postedAt,
        adjustment: adjustments.has(d.id),
      })),
  }
}
