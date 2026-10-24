import type { DebtBody } from "@millhiore/contracts"
import type { Db } from "@millhiore/db"
import { type PostContext, type PostedDocument, postDocument } from "../../posting/post"

/**
 * Anota una deuda sin venta, compra o gasto detrás. Todo el monto queda a crédito en su moneda:
 * se cobra con un abono (`DEBT_IN`) o se paga a proveedor (`DEBT_OUT`). Idempotente por `id`.
 */
export function postDebt(db: Db, body: DebtBody, ctx: PostContext): PostedDocument {
  return postDocument(
    db,
    {
      id: body.id,
      type: body.type,
      terminalId: body.terminalId,
      currency: body.currency,
      rate: body.rate,
      lines: [],
      payments: body.payments,
      contactId: body.contactId,
      externalRef: body.externalRef,
      note: body.note || null,
      amountMinor: body.amountMinor,
      creditMinor: body.amountMinor,
      creditCurrency: body.currency,
      dueAt: body.dueAt ?? null,
    },
    ctx,
  )
}
