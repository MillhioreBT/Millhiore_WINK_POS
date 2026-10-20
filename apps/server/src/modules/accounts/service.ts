import type {
  Account,
  CreateAccountBody,
  TransferBody,
  TransferRow,
  UpdateAccountBody,
} from "@millhiore/contracts"
import {
  account,
  accountBalance,
  auditLog,
  business,
  type Db,
  document,
  IGTF_SURCHARGE,
  payment,
  paymentMethod,
  user,
} from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { HttpError } from "../../http/errors"
import { type PostContext, type PostedDocument, postDocument } from "../../posting/post"
import { fiscalSettings } from "../settings/service"

function audit(
  db: Pick<Db, "insert">,
  actorId: string,
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
      entityType: "account",
      entityId: id,
      data,
    })
    .run()
}

/** Las cuentas con lo que hay en cada una y los métodos de pago que las usan. */
export function listAccounts(db: Db, opts: { all?: boolean } = {}): Account[] {
  const balances = new Map(
    db
      .select()
      .from(accountBalance)
      .all()
      .map((b) => [b.accountId, b.amountMinor]),
  )
  const methods = new Map<string, string[]>()
  for (const m of db
    .select()
    .from(paymentMethod)
    .where(eq(paymentMethod.active, true))
    .orderBy(asc(paymentMethod.name))
    .all()) {
    methods.set(m.accountId, [...(methods.get(m.accountId) ?? []), m.name])
  }
  return db
    .select()
    .from(account)
    .where(opts.all ? undefined : eq(account.active, true))
    .orderBy(asc(account.kind), asc(account.name))
    .all()
    .map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      currency: a.currency,
      active: a.active,
      balanceMinor: balances.get(a.id) ?? 0,
      methods: methods.get(a.id) ?? [],
    }))
}

function accountById(db: Db, id: string): Account {
  const row = listAccounts(db, { all: true }).find((a) => a.id === id)
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe la cuenta ${id}`)
  return row
}

/**
 * Crea una cuenta (banco, pago móvil o billetera) y su método de pago con el mismo nombre, para
 * poder cobrar y pagar con ella desde ya. El método pide referencia (la del pago o la operación) y,
 * si el negocio es sujeto pasivo especial y la cuenta es en divisas, lleva el IGTF.
 */
export function createAccount(
  db: Db,
  body: CreateAccountBody,
  actorId: string,
  now: number,
): Account {
  const biz = db.select().from(business).get()
  if (!biz) throw new HttpError(409, "NOT_CONFIGURED", "El negocio aún no está configurado")
  if (db.select().from(account).where(eq(account.name, body.name)).get()) {
    throw new HttpError(409, "DUPLICATE_NAME", "Ya existe una cuenta con ese nombre")
  }
  const id = uuidv7(now)
  const igtf = fiscalSettings(db).taxpayer === "special" && body.currency !== biz.legalCurrency
  db.transaction(
    (tx) => {
      tx.insert(account)
        .values({ id, name: body.name, kind: body.kind, currency: body.currency })
        .run()
      tx.insert(paymentMethod)
        .values({
          id: uuidv7(now),
          name: body.name,
          accountId: id,
          requiresReference: true,
          surchargeId: igtf ? IGTF_SURCHARGE.id : null,
        })
        .run()
    },
    { behavior: "immediate" },
  )
  audit(db, actorId, now, "account.created", id, body)
  return accountById(db, id)
}

/**
 * Renombra una cuenta (y el método que lleva su nombre) o la desactiva. El efectivo no se
 * desactiva (cada turno lo cuenta) y una cuenta con dinero tampoco: primero se transfiere.
 */
export function updateAccount(
  db: Db,
  id: string,
  patch: UpdateAccountBody,
  actorId: string,
  now: number,
): Account {
  const before = accountById(db, id)
  if (patch.active === false && before.active) {
    if (before.kind === "cash") {
      throw new HttpError(409, "CASH_ACCOUNT", "Las cuentas de efectivo no se desactivan")
    }
    if (before.balanceMinor !== 0) {
      throw new HttpError(
        409,
        "ACCOUNT_HAS_BALANCE",
        "La cuenta todavía tiene dinero: transfiérelo a otra antes de desactivarla",
      )
    }
  }
  if (patch.name !== undefined && patch.name !== before.name) {
    const taken = db.select().from(account).where(eq(account.name, patch.name)).get()
    if (taken) throw new HttpError(409, "DUPLICATE_NAME", "Ya existe una cuenta con ese nombre")
  }
  try {
    db.transaction(
      (tx) => {
        const set = {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.active !== undefined ? { active: patch.active } : {}),
        }
        if (Object.keys(set).length) tx.update(account).set(set).where(eq(account.id, id)).run()
        // El método que se llamaba como la cuenta sigue su nombre; los demás se quedan como están.
        if (patch.name !== undefined && patch.name !== before.name) {
          tx.update(paymentMethod)
            .set({ name: patch.name })
            .where(and(eq(paymentMethod.accountId, id), eq(paymentMethod.name, before.name)))
            .run()
        }
        // Sin cuenta activa, sus métodos dejan de ofrecerse; al reactivarla vuelven.
        if (patch.active !== undefined) {
          tx.update(paymentMethod)
            .set({ active: patch.active })
            .where(eq(paymentMethod.accountId, id))
            .run()
        }
      },
      { behavior: "immediate" },
    )
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error).cause ?? (e as Error).message))) {
      throw new HttpError(409, "DUPLICATE_NAME", "Ya existe una cuenta con ese nombre")
    }
    throw e
  }
  audit(db, actorId, now, "account.updated", id, { before: before.name, patch })
  return accountById(db, id)
}

/** El método de pago activo con que se registra el dinero que entra o sale de una cuenta. */
function methodOf(db: Db, accountId: string): { id: string; name: string } {
  const row = db
    .select({ id: paymentMethod.id, name: account.name })
    .from(paymentMethod)
    .innerJoin(account, eq(account.id, paymentMethod.accountId))
    .where(
      and(
        eq(paymentMethod.accountId, accountId),
        eq(paymentMethod.active, true),
        eq(account.active, true),
      ),
    )
    .orderBy(asc(paymentMethod.name))
    .get()
  if (!row) {
    throw new HttpError(422, "UNKNOWN_ACCOUNT", "Elige una cuenta activa para transferir")
  }
  return row
}

/** Mueve dinero de una cuenta a otra, con cambio de moneda si hace falta. Idempotente por `id`. */
export function postTransfer(db: Db, body: TransferBody, ctx: PostContext): PostedDocument {
  const from = db.select().from(account).where(eq(account.id, body.fromAccountId)).get()
  const to = db.select().from(account).where(eq(account.id, body.toAccountId)).get()
  if (!(from && to)) throw new HttpError(422, "UNKNOWN_ACCOUNT", "Elige dos cuentas que existan")
  const fromMethod = methodOf(db, from.id)
  const toMethod = methodOf(db, to.id)
  return postDocument(
    db,
    {
      id: body.id,
      type: "TRANSFER",
      terminalId: body.terminalId,
      currency: from.currency,
      rate: body.rate,
      lines: [],
      payments: [
        {
          id: uuidv7(ctx.now),
          paymentMethodId: fromMethod.id,
          currency: from.currency,
          amountMinor: body.fromAmountMinor,
          rate: null,
          reference: body.reference ?? null,
        },
        {
          id: uuidv7(ctx.now + 1),
          paymentMethodId: toMethod.id,
          currency: to.currency,
          amountMinor: body.toAmountMinor,
          rate: null,
          reference: body.reference ?? null,
        },
      ],
      note: body.note || null,
    },
    ctx,
  )
}

/** Las transferencias de un rango, las más recientes primero, con las cuentas por su nombre. */
export function listTransfers(
  db: Db,
  opts: { from?: number | undefined; to?: number | undefined; limit: number },
): TransferRow[] {
  const reversal = alias(document, "reversal")
  const docs = db
    .select({
      id: document.id,
      number: document.number,
      postedAt: document.postedAt,
      note: document.note,
      createdBy: user.name,
      reversedBy: reversal.id,
      reversesDocumentId: document.reversesDocumentId,
    })
    .from(document)
    .leftJoin(reversal, eq(reversal.reversesDocumentId, document.id))
    .leftJoin(user, eq(user.id, document.createdBy))
    .where(
      and(
        eq(document.type, "TRANSFER"),
        opts.from === undefined ? undefined : gte(document.postedAt, opts.from),
        opts.to === undefined ? undefined : lt(document.postedAt, opts.to),
      ),
    )
    .orderBy(desc(document.postedAt), desc(document.id))
    .limit(opts.limit)
    .all()
  if (docs.length === 0) return []
  const legs = db
    .select({
      documentId: payment.documentId,
      accountName: account.name,
      currency: payment.currency,
      amountMinor: payment.amountMinor,
      reference: payment.reference,
    })
    .from(payment)
    .innerJoin(account, eq(account.id, payment.accountId))
    .where(
      inArray(
        payment.documentId,
        docs.map((d) => d.id),
      ),
    )
    .orderBy(asc(payment.id))
    .all()
  const byDoc = new Map<string, typeof legs>()
  for (const l of legs) byDoc.set(l.documentId, [...(byDoc.get(l.documentId) ?? []), l])
  return docs.flatMap((d) => {
    const [from, to] = byDoc.get(d.id) ?? []
    if (!(from && to)) return []
    return [
      {
        id: d.id,
        number: d.number,
        postedAt: d.postedAt,
        fromAccountName: from.accountName,
        fromCurrency: from.currency,
        fromAmountMinor: from.amountMinor,
        toAccountName: to.accountName,
        toCurrency: to.currency,
        toAmountMinor: to.amountMinor,
        reference: from.reference,
        note: d.note,
        createdBy: d.createdBy,
        reversedBy: d.reversedBy,
        reversesDocumentId: d.reversesDocumentId,
      },
    ]
  })
}
