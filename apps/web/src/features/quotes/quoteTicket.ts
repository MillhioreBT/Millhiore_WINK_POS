import type { QuoteDetail } from "@millhiore/contracts"
import type { TicketCharge } from "../pos/compute"
import type { TicketLine } from "../pos/store"

/** Los productos de una cotización como líneas de la caja, con su precio congelado. */
export function quoteLines(q: QuoteDetail): TicketLine[] {
  return q.lines.map((l) => ({
    variantId: l.variantId,
    name: l.name,
    qtyMilli: l.qtyMilli,
    priceMinor: l.priceMinor,
    priceCurrency: l.priceCurrency,
    taxId: l.taxId,
    ...(l.discount ? { discount: l.discount } : {}),
    fixedPrice: true,
  }))
}

export function quoteCharges(q: QuoteDetail): TicketCharge[] {
  return q.charges.map((c) => ({ chargeId: c.chargeId, ...(c.amount ? { amount: c.amount } : {}) }))
}

/** Venció: pasó la fecha hasta la que valían los precios. */
export function isExpired(q: { status: string; validUntil: number }, now = Date.now()): boolean {
  return q.status === "open" && q.validUntil < now
}

export const QUOTE_STATUS: Record<QuoteDetail["status"], string> = {
  open: "Abierta",
  converted: "Vendida",
  cancelled: "Anulada",
}
