import type { TipsReport } from "@millhiore/contracts"
import { business, currency, type Db, document, user } from "@millhiore/db"
import { convert, exchangeRate, money } from "@millhiore/domain"
import { and, eq, gte, lt, ne } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { inBranches } from "../branches/service"

/**
 * Las propinas de un período por quien las recibe (o el equipo), netas de anulaciones: el reverso
 * de una venta lleva la propina con signo contrario. En moneda legal y en la de referencia, a la
 * tasa de cada venta (en un período largo, sumar bolívares de meses distintos engaña).
 */
export function tipsReport(
  db: Db,
  opts: { from: number; to: number; branchIds?: readonly string[] | null },
): TipsReport {
  const biz = db.select().from(business).get()
  if (!biz) throw new HttpError(409, "NOT_CONFIGURED", "El negocio aún no está configurado")
  const ref = biz.referenceCurrency
  const book = Object.fromEntries(
    db
      .select()
      .from(currency)
      .all()
      .map((c) => [c.code, { code: c.code, decimals: c.decimals }]),
  )
  const docs = db
    .select({
      currency: document.currency,
      tipMinor: document.tipMinor,
      tipLegalMinor: document.tipLegalMinor,
      tipUserId: document.tipUserId,
      name: user.name,
      reversesDocumentId: document.reversesDocumentId,
      rateBase: document.rateBase,
      rateQuote: document.rateQuote,
      rateValue: document.rateValue,
    })
    .from(document)
    .leftJoin(user, eq(user.id, document.tipUserId))
    .where(
      and(
        eq(document.type, "SALE"),
        ne(document.tipMinor, 0),
        gte(document.postedAt, opts.from),
        lt(document.postedAt, opts.to),
        inBranches(document.locationId, opts.branchIds ?? null),
      ),
    )
    .all()

  /** La propina en la moneda de referencia, con la tasa de su venta; null si no se puede. */
  const inReference = (d: (typeof docs)[number]): number | null => {
    if (d.currency === ref) return d.tipMinor
    const base = d.rateBase ? book[d.rateBase] : undefined
    const quote = d.rateQuote ? book[d.rateQuote] : undefined
    if (!(base && quote && d.rateValue)) return null
    const covers =
      (base.code === ref && quote.code === d.currency) ||
      (quote.code === ref && base.code === d.currency)
    if (!covers) return null
    const sign = Math.sign(d.tipMinor)
    const rate = exchangeRate(base.code, quote.code, d.rateValue)
    return (
      sign * convert(money(Math.abs(d.tipMinor), d.currency), rate, { base, quote }).amountMinor
    )
  }

  const rows = new Map<string, TipsReport["rows"][number]>()
  for (const d of docs) {
    const key = d.tipUserId ?? ""
    const row = rows.get(key) ?? {
      userId: d.tipUserId,
      name: d.tipUserId ? (d.name ?? d.tipUserId) : "Todo el equipo",
      count: 0,
      totalLegalMinor: 0,
      totalReferenceMinor: 0,
    }
    row.count += d.reversesDocumentId ? -1 : 1
    row.totalLegalMinor += d.tipLegalMinor
    const r = inReference(d)
    row.totalReferenceMinor =
      row.totalReferenceMinor === null || r === null ? null : row.totalReferenceMinor + r
    rows.set(key, row)
  }
  const list = [...rows.values()]
    .filter((r) => r.count !== 0 || r.totalLegalMinor !== 0)
    .sort((a, b) => b.totalLegalMinor - a.totalLegalMinor || a.name.localeCompare(b.name, "es"))
  return {
    legalCurrency: biz.legalCurrency,
    referenceCurrency: ref,
    rows: list,
    totalLegalMinor: list.reduce((acc, r) => acc + r.totalLegalMinor, 0),
    totalReferenceMinor: list.some((r) => r.totalReferenceMinor === null)
      ? null
      : list.reduce((acc, r) => acc + (r.totalReferenceMinor ?? 0), 0),
  }
}
