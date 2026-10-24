import type { ExchangeExposure } from "@millhiore/contracts"
import { account, accountMove, business, currency, type Db, exchangeRate } from "@millhiore/db"
import { and, asc, desc, eq, sql } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { rateAt, SOURCE_PRIORITY } from "../rates/service"

/**
 * Exposición cambiaria: cuánto valían en la moneda de referencia los bolívares de cada cuenta
 * cuando entraron, contra lo que valen hoy a la tasa vigente. Es informativa: no toca los saldos.
 *
 * La base es un costo promedio móvil: lo que entra suma su valor a la tasa de ese momento; lo que
 * sale se lleva su parte proporcional de la base (sale «al promedio»). Si el saldo cruza de
 * positivo a negativo, la base vuelve a empezar desde lo que quedó, a la tasa de ese momento.
 */
export function exchangeExposure(db: Db, now: number): ExchangeExposure {
  const biz = db.select().from(business).get()
  if (!biz) throw new HttpError(409, "NOT_CONFIGURED", "El negocio aún no está configurado")
  const reference = biz.referenceCurrency
  const legal = biz.legalCurrency
  const current = reference === legal ? undefined : rateAt(db, reference, legal, now)
  const empty = { balanceMinor: 0, basisMinor: 0, valueMinor: 0, differenceMinor: 0 }
  if (!current) {
    return {
      referenceCurrency: reference,
      legalCurrency: legal,
      rate: null,
      accounts: [],
      totals: empty,
    }
  }

  const decimals = new Map(
    db
      .select()
      .from(currency)
      .all()
      .map((c) => [c.code, c.decimals]),
  )
  // Unidades menores de la moneda legal → unidades menores de la de referencia, a una tasa dada.
  const scale = 10 ** ((decimals.get(reference) ?? 2) - (decimals.get(legal) ?? 2))
  const toReference = (legalMinor: number, rate: number) => (legalMinor / rate) * scale

  // El historial de la tasa en orden de vigencia; a igual vigencia, la preferida (manual, BCV…)
  // queda de última, igual que en `rateAt`.
  const history = db
    .select({ effectiveAt: exchangeRate.effectiveAt, value: exchangeRate.value })
    .from(exchangeRate)
    .where(and(eq(exchangeRate.base, reference), eq(exchangeRate.quote, legal)))
    .orderBy(asc(exchangeRate.effectiveAt), desc(SOURCE_PRIORITY), asc(exchangeRate.createdAt))
    .all()
    .map((r) => ({ effectiveAt: r.effectiveAt, value: Number(r.value) }))

  const accounts = db
    .select({ id: account.id, name: account.name, kind: account.kind, active: account.active })
    .from(account)
    .where(eq(account.currency, legal))
    .orderBy(asc(account.name))
    .all()
  const today = Number(current.value)
  const rows: ExchangeExposure["accounts"] = []
  for (const a of accounts) {
    const moves = db
      .select({ amountMinor: accountMove.amountMinor, at: accountMove.createdAt })
      .from(accountMove)
      .where(eq(accountMove.accountId, a.id))
      // En el orden en que se registraron (dos ids del mismo milisegundo no dicen cuál fue antes).
      .orderBy(asc(accountMove.createdAt), sql`rowid`)
      .all()
    let balance = 0
    let basis = 0
    // Lo que entró antes de la primera tasa conocida se valora con esa primera tasa.
    let i = 0
    let rate = history[0]?.value ?? today
    for (const m of moves) {
      while (i < history.length && (history[i]?.effectiveAt ?? Infinity) <= m.at) {
        rate = history[i]?.value ?? rate
        i++
      }
      const next = balance + m.amountMinor
      if (balance === 0 || (next !== 0 && Math.sign(next) !== Math.sign(balance))) {
        basis = toReference(next, rate)
      } else if (Math.abs(next) > Math.abs(balance)) {
        basis += toReference(m.amountMinor, rate)
      } else {
        basis *= next / balance
      }
      balance = next
    }
    if (balance === 0) continue
    const basisMinor = Math.round(basis)
    const valueMinor = Math.round(toReference(balance, today))
    rows.push({
      accountId: a.id,
      name: a.name,
      kind: a.kind,
      active: a.active,
      balanceMinor: balance,
      basisMinor,
      valueMinor,
      differenceMinor: valueMinor - basisMinor,
    })
  }
  const sum = (k: keyof typeof empty) => rows.reduce((acc, r) => acc + r[k], 0)
  return {
    referenceCurrency: reference,
    legalCurrency: legal,
    rate: { value: current.value, effectiveAt: current.effectiveAt },
    accounts: rows,
    totals: {
      balanceMinor: sum("balanceMinor"),
      basisMinor: sum("basisMinor"),
      valueMinor: sum("valueMinor"),
      differenceMinor: sum("differenceMinor"),
    },
  }
}
