import type { Returnable, ReturnBody } from "@millhiore/contracts"
import { contact, type Db, document, tax } from "@millhiore/db"
import { type LineTax, PostingError, returnLineDiscount } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { type PostContext, type PostedDocument, postDocument } from "../../posting/post"
import { openPayables, openSales } from "../../posting/receivables"
import { isReversed, returnableLines } from "../../posting/returns"

/** El tipo de un documento, para saber qué permiso pide devolverlo (o `undefined` si no existe). */
export function documentType(db: Db, id: string): string | undefined {
  return db.select({ type: document.type }).from(document).where(eq(document.id, id)).get()?.type
}

/** Una venta (la devuelve el cliente) o una compra (se le devuelve al proveedor), vigente. */
function loadSale(db: Db, saleId: string) {
  const sale = db.select().from(document).where(eq(document.id, saleId)).get()
  if (!sale) throw new HttpError(404, "NOT_FOUND", `No existe el documento ${saleId}`)
  if ((sale.type !== "SALE" && sale.type !== "PURCHASE") || sale.reversesDocumentId) {
    throw new PostingError(
      "NOT_RETURNABLE",
      "Solo se devuelven productos de una venta o una compra",
    )
  }
  if (isReversed(db, sale.id)) {
    throw new PostingError(
      "NOT_RETURNABLE",
      `La ${sale.type === "SALE" ? "venta" : "compra"} ${sale.number} está anulada`,
    )
  }
  return { ...sale, type: sale.type }
}

/** Lo que se le debe al otro de ese documento: el cliente de la venta, o el comercio al proveedor. */
function debtOf(db: Db, doc: ReturnType<typeof loadSale>) {
  if (!doc.contactId) return undefined
  const filter = { contactId: doc.contactId, ids: [doc.id] }
  return (doc.type === "SALE" ? openSales : openPayables)(db, filter)[0]
}

/**
 * Lo que se puede devolver de una venta (o de una compra, al proveedor) y con qué precio,
 * descuento e IVA salió cada línea.
 */
export function returnableOf(db: Db, saleId: string): Returnable {
  const sale = loadSale(db, saleId)
  const kinds = new Map(
    db
      .select({ id: tax.id, kind: tax.kind })
      .from(tax)
      .all()
      .map((t) => [t.id, t.kind]),
  )
  const who = sale.contactId
    ? db.select({ name: contact.name }).from(contact).where(eq(contact.id, sale.contactId)).get()
    : undefined
  const debt = debtOf(db, sale)
  return {
    kind: sale.type,
    documentId: sale.id,
    number: sale.number,
    currency: sale.currency,
    pricesIncludeTax: sale.pricesIncludeTax,
    contactId: sale.contactId,
    contactName: who?.name ?? null,
    lines: returnableLines(db, sale.id).map((l) => ({
      lineNo: l.lineNo,
      variantId: l.variantId,
      name: l.name,
      qtyMilli: l.qtyMilli,
      unitPriceMinor: l.unitPriceMinor,
      discountMinor: l.discountMinor,
      taxId: l.taxId,
      // Con alícuota la línea es gravada; sin ella, la clase que tenga el impuesto (exento…).
      taxKind: l.taxId ? (l.taxRateBp > 0 ? "taxed" : (kinds.get(l.taxId) ?? "exempt")) : null,
      taxRateBp: l.taxRateBp,
      returnedMilli: l.returnedMilli,
      returnedDiscountMinor: l.returnedDiscountMinor,
      remainingMilli: l.remainingMilli,
    })),
    debt: debt ? { currency: debt.currency, outstandingMinor: debt.outstandingMinor } : null,
  }
}

/**
 * Registra la devolución de parte de una venta (o de una compra, al proveedor). Los precios, el
 * descuento y el IVA los fija el servidor con los del documento (la caja solo dice qué líneas y
 * cuánto), y el dinero se mueve por los métodos indicados o se descuenta de lo que se debe de ese
 * documento. Lo devuelto al proveedor sale de la ubicación a la que entró la compra.
 */
export function postReturn(
  db: Db,
  saleId: string,
  body: ReturnBody,
  ctx: PostContext,
): PostedDocument {
  const sale = loadSale(db, saleId)
  const lines = new Map(returnableLines(db, sale.id).map((l) => [l.lineNo, l]))
  const kinds = new Map(
    db
      .select({ id: tax.id, kind: tax.kind })
      .from(tax)
      .all()
      .map((t) => [t.id, t.kind]),
  )
  const seen = new Set<number>()
  const input = body.lines.map((r) => {
    const l = lines.get(r.lineNo)
    if (!l || seen.has(r.lineNo)) {
      throw new PostingError(
        "NOT_RETURNABLE",
        `La ${sale.type === "SALE" ? "venta" : "compra"} no tiene la línea ${r.lineNo}`,
      )
    }
    seen.add(r.lineNo)
    if (r.qtyMilli > l.remainingMilli) {
      throw new PostingError(
        "NOT_RETURNABLE",
        `De «${l.name}» solo se puede devolver lo que no se ha devuelto ya`,
      )
    }
    const tax: LineTax | null = l.taxId
      ? {
          taxId: l.taxId,
          kind: l.taxRateBp > 0 ? "taxed" : (kinds.get(l.taxId) ?? "exempt"),
          rateBp: l.taxRateBp,
        }
      : null
    return {
      variantId: l.variantId,
      qtyMilli: r.qtyMilli,
      unitPriceMinor: l.unitPriceMinor,
      discountMinor: returnLineDiscount({
        discountMinor: l.discountMinor,
        qtyMilli: l.qtyMilli,
        returnQtyMilli: r.qtyMilli,
        returnedQtyMilli: l.returnedMilli,
        returnedDiscountMinor: l.returnedDiscountMinor,
      }),
      tax,
    }
  })

  return postDocument(
    db,
    {
      id: body.id,
      type: sale.type === "SALE" ? "RETURN" : "PURCHASE_RETURN",
      ...(sale.type === "PURCHASE" ? { locationId: sale.locationId } : {}),
      terminalId: body.terminalId,
      currency: sale.currency,
      rate: body.rate,
      lines: input,
      payments: body.payments,
      pricesIncludeTax: sale.pricesIncludeTax,
      contactId: sale.contactId,
      returnsDocumentId: sale.id,
      note: body.note,
      allocations:
        body.creditAppliedMinor > 0
          ? [{ saleDocumentId: sale.id, amountMinor: body.creditAppliedMinor }]
          : [],
    },
    ctx,
  )
}
