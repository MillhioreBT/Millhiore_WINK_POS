import { allocation, type Db, document } from "@millhiore/db"
import {
  type CurrencyBook,
  type CurrencyCode,
  convert,
  type DocumentType,
  type ExchangeRate,
  exchangeRate,
  money,
} from "@millhiore/domain"
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"

/** La base o una transacción abierta sobre ella: solo hace falta leer. */
export type Reader = Pick<Db, "select">

/**
 * Un documento a crédito con saldo pendiente: una venta que el cliente todavía debe, o una compra
 * o un gasto que el negocio todavía le debe a su proveedor.
 */
export interface OpenSale {
  id: string
  number: string
  contactId: string
  currency: string
  postedAt: number
  dueAt: number | null
  creditMinor: number
  /** Lo abonado hasta ahora (los abonos anulados ya no cuentan). */
  paidMinor: number
  /** Lo que sigue debiendo el cliente: `creditMinor − paidMinor`. */
  outstandingMinor: number
  rate: ExchangeRate | null
}

/**
 * Documentos a crédito de esos tipos con saldo pendiente, los más antiguos primero. Uno anulado no
 * debe nada, y un pago anulado vuelve a dejar su monto a deber.
 */
export function openCredits(
  db: Reader,
  filter: { types: readonly DocumentType[]; contactId?: string; ids?: readonly string[] },
): OpenSale[] {
  const reversal = alias(document, "reversal")
  const paid = sql<number>`coalesce((select sum(${allocation.amountMinor}) from ${allocation}
    where ${allocation.saleDocumentId} = ${document.id}), 0)`
  return db
    .select({
      id: document.id,
      number: document.number,
      contactId: document.contactId,
      currency: document.creditCurrency,
      postedAt: document.postedAt,
      dueAt: document.dueAt,
      creditMinor: document.creditMinor,
      paidMinor: paid,
      rateBase: document.rateBase,
      rateQuote: document.rateQuote,
      rateValue: document.rateValue,
    })
    .from(document)
    .leftJoin(reversal, eq(reversal.reversesDocumentId, document.id))
    .where(
      and(
        inArray(document.type, [...filter.types]),
        isNull(document.reversesDocumentId),
        gt(document.creditMinor, 0),
        isNull(reversal.id),
        filter.contactId ? eq(document.contactId, filter.contactId) : undefined,
        filter.ids ? inArray(document.id, [...filter.ids]) : undefined,
      ),
    )
    .orderBy(asc(document.postedAt), asc(document.id))
    .all()
    .flatMap((r) =>
      r.contactId && r.currency && r.creditMinor - r.paidMinor > 0
        ? [
            {
              id: r.id,
              number: r.number,
              contactId: r.contactId,
              currency: r.currency,
              postedAt: r.postedAt,
              dueAt: r.dueAt,
              creditMinor: r.creditMinor,
              paidMinor: r.paidMinor,
              outstandingMinor: r.creditMinor - r.paidMinor,
              rate:
                r.rateBase && r.rateQuote && r.rateValue
                  ? exchangeRate(r.rateBase, r.rateQuote, r.rateValue)
                  : null,
            },
          ]
        : [],
    )
}

/** Ventas a crédito con saldo pendiente: lo que los clientes todavía deben. */
export function openSales(
  db: Reader,
  filter: { contactId?: string; ids?: readonly string[] } = {},
): OpenSale[] {
  return openCredits(db, { ...filter, types: ["SALE"] })
}

/** Compras y gastos a deber con saldo pendiente: lo que el negocio todavía le debe a sus proveedores. */
export function openPayables(
  db: Reader,
  filter: { contactId?: string; ids?: readonly string[] } = {},
): OpenSale[] {
  return openCredits(db, { ...filter, types: ["PURCHASE", "EXPENSE"] })
}

/** Abonos netos (los anulados restan) que tiene aplicados una venta. */
export function collectedOn(db: Reader, saleId: string): number {
  return (
    db
      .select({ total: sql<number>`coalesce(sum(${allocation.amountMinor}), 0)` })
      .from(allocation)
      .where(eq(allocation.saleDocumentId, saleId))
      .get()?.total ?? 0
  )
}

/**
 * Lo que debe un cliente expresado en la moneda de referencia, para compararlo con su límite.
 * Cada venta se convierte con la tasa que guardó al emitirse; si no tiene una que sirva, no
 * suma (el límite es una ayuda para quien fía, no una regla contable).
 */
export function owedInReference(
  sales: readonly Pick<OpenSale, "currency" | "outstandingMinor" | "rate">[],
  reference: CurrencyCode,
  book: CurrencyBook,
): number {
  let total = 0
  for (const s of sales) {
    if (s.currency === reference) {
      total += s.outstandingMinor
      continue
    }
    const rate = s.rate
    const covers =
      rate &&
      ((rate.base === s.currency && rate.quote === reference) ||
        (rate.base === reference && rate.quote === s.currency))
    const base = rate && book[rate.base]
    const quote = rate && book[rate.quote]
    if (!(rate && covers && base && quote)) continue
    total += convert(money(s.outstandingMinor, s.currency), rate, { base, quote }).amountMinor
  }
  return total
}
