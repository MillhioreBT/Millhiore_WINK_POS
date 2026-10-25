import type { DocumentDetail, DocumentSummary } from "@millhiore/contracts"
import {
  allocation,
  contact,
  type Db,
  discountCode,
  document,
  documentCharge,
  documentLine,
  documentSurcharge,
  documentTax,
  expenseCategory,
  location,
  lot,
  payment,
  paymentMethod,
  stockMove,
  stockReason,
  terminal,
  user,
  variant,
} from "@millhiore/db"
import { DOCUMENT_TYPES, type DocumentType } from "@millhiore/domain"
import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { HttpError } from "../../http/errors"

const reversal = alias(document, "reversal")
/** La venta de la que es una devolución. */
const returned = alias(document, "returned")
/** Adónde llegó un traslado. */
const destination = alias(location, "destination")
/** Para quién fue la propina. */
const tipUser = alias(user, "tip_user")

const summaryColumns = {
  id: document.id,
  type: document.type,
  number: document.number,
  postedAt: document.postedAt,
  currency: document.currency,
  legalCurrency: document.legalCurrency,
  totalMinor: document.totalMinor,
  totalLegalMinor: document.totalLegalMinor,
  surchargeMinor: document.surchargeMinor,
  surchargeLegalMinor: document.surchargeLegalMinor,
  reversesDocumentId: document.reversesDocumentId,
  reversedBy: reversal.id,
  createdBy: user.name,
  contactId: document.contactId,
  contactName: contact.name,
  contactTaxId: contact.taxId,
  externalRef: document.externalRef,
  note: document.note,
  discountMinor: document.discountMinor,
  discountLegalMinor: document.discountLegalMinor,
  returnsDocumentId: document.returnsDocumentId,
  returnsNumber: returned.number,
  expenseCategoryId: document.expenseCategoryId,
  expenseCategoryName: expenseCategory.name,
  stockReasonId: document.stockReasonId,
  stockReasonName: stockReason.name,
  tipMinor: document.tipMinor,
  tipLegalMinor: document.tipLegalMinor,
  tipUserId: document.tipUserId,
  tipUserName: tipUser.name,
  creditMinor: document.creditMinor,
  creditCurrency: document.creditCurrency,
  dueAt: document.dueAt,
  terminalName: terminal.name,
  locationId: document.locationId,
  locationName: location.name,
  toLocationId: document.toLocationId,
  toLocationName: destination.name,
  discountCode: discountCode.code,
}

export function isDocumentType(value: string): value is DocumentType {
  return (DOCUMENT_TYPES as readonly string[]).includes(value)
}

/** Documentos más recientes primero, con filtro opcional por tipo y rango de fechas. */
export function listDocuments(
  db: Db,
  opts: {
    types?: DocumentType[] | undefined
    from?: number | undefined
    to?: number | undefined
    /** Solo gastos de esta categoría. */
    expenseCategoryId?: string | undefined
    limit: number
  },
): DocumentSummary[] {
  const filters = [
    opts.types?.length ? inArray(document.type, opts.types) : undefined,
    opts.from !== undefined ? gte(document.postedAt, opts.from) : undefined,
    opts.to !== undefined ? lt(document.postedAt, opts.to) : undefined,
    opts.expenseCategoryId ? eq(document.expenseCategoryId, opts.expenseCategoryId) : undefined,
  ].filter((f) => f !== undefined)
  return db
    .select(summaryColumns)
    .from(document)
    .leftJoin(reversal, eq(reversal.reversesDocumentId, document.id))
    .leftJoin(returned, eq(returned.id, document.returnsDocumentId))
    .leftJoin(user, eq(user.id, document.createdBy))
    .leftJoin(contact, eq(contact.id, document.contactId))
    .leftJoin(expenseCategory, eq(expenseCategory.id, document.expenseCategoryId))
    .leftJoin(stockReason, eq(stockReason.id, document.stockReasonId))
    .innerJoin(terminal, eq(terminal.id, document.terminalId))
    .innerJoin(location, eq(location.id, document.locationId))
    .leftJoin(destination, eq(destination.id, document.toLocationId))
    .leftJoin(tipUser, eq(tipUser.id, document.tipUserId))
    .leftJoin(discountCode, eq(discountCode.id, document.discountCodeId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(document.postedAt), desc(document.id))
    .limit(opts.limit)
    .all()
}

/** Documento completo: líneas con nombre, pagos con su método y desglose de IVA e IGTF. */
export function getDocument(db: Db, id: string): DocumentDetail {
  const head = db
    .select({
      ...summaryColumns,
      rateBase: document.rateBase,
      rateQuote: document.rateQuote,
      rateValue: document.rateValue,
      pricesIncludeTax: document.pricesIncludeTax,
    })
    .from(document)
    .leftJoin(reversal, eq(reversal.reversesDocumentId, document.id))
    .leftJoin(returned, eq(returned.id, document.returnsDocumentId))
    .leftJoin(user, eq(user.id, document.createdBy))
    .leftJoin(contact, eq(contact.id, document.contactId))
    .leftJoin(expenseCategory, eq(expenseCategory.id, document.expenseCategoryId))
    .leftJoin(stockReason, eq(stockReason.id, document.stockReasonId))
    .innerJoin(terminal, eq(terminal.id, document.terminalId))
    .innerJoin(location, eq(location.id, document.locationId))
    .leftJoin(destination, eq(destination.id, document.toLocationId))
    .leftJoin(tipUser, eq(tipUser.id, document.tipUserId))
    .leftJoin(discountCode, eq(discountCode.id, document.discountCodeId))
    .where(eq(document.id, id))
    .get()
  if (!head) throw new HttpError(404, "NOT_FOUND", `No existe el documento ${id}`)
  const { rateBase, rateQuote, rateValue, ...summary } = head

  const lines = db
    .select({
      lineNo: documentLine.lineNo,
      variantId: documentLine.variantId,
      name: variant.name,
      qtyMilli: documentLine.qtyMilli,
      unitPriceMinor: documentLine.unitPriceMinor,
      discountMinor: documentLine.discountMinor,
      lineTotalMinor: documentLine.lineTotalMinor,
      taxId: documentLine.taxId,
      taxRateBp: documentLine.taxRateBp,
      modifiers: documentLine.modifiers,
      note: documentLine.note,
    })
    .from(documentLine)
    .innerJoin(variant, eq(variant.id, documentLine.variantId))
    .where(eq(documentLine.documentId, id))
    .orderBy(asc(documentLine.lineNo))
    .all()

  const payments = db
    .select({
      id: payment.id,
      paymentMethodId: payment.paymentMethodId,
      methodName: paymentMethod.name,
      currency: payment.currency,
      amountMinor: payment.amountMinor,
      reference: payment.reference,
      surchargeId: payment.surchargeId,
    })
    .from(payment)
    .innerJoin(paymentMethod, eq(paymentMethod.id, payment.paymentMethodId))
    .where(eq(payment.documentId, id))
    .orderBy(asc(payment.id))
    .all()

  const taxes = db
    .select({
      taxId: documentTax.taxId,
      kind: documentTax.kind,
      rateBp: documentTax.rateBp,
      baseMinor: documentTax.baseMinor,
      taxMinor: documentTax.taxMinor,
      baseLegalMinor: documentTax.baseLegalMinor,
      taxLegalMinor: documentTax.taxLegalMinor,
    })
    .from(documentTax)
    .where(eq(documentTax.documentId, id))
    .orderBy(asc(documentTax.position))
    .all()

  const surcharges = db
    .select({
      surchargeId: documentSurcharge.surchargeId,
      rateBp: documentSurcharge.rateBp,
      baseMinor: documentSurcharge.baseMinor,
      amountMinor: documentSurcharge.amountMinor,
      baseLegalMinor: documentSurcharge.baseLegalMinor,
      amountLegalMinor: documentSurcharge.amountLegalMinor,
    })
    .from(documentSurcharge)
    .where(eq(documentSurcharge.documentId, id))
    .orderBy(asc(documentSurcharge.position))
    .all()

  const charges = db
    .select({
      chargeId: documentCharge.chargeId,
      name: documentCharge.name,
      kind: documentCharge.kind,
      rateBp: documentCharge.rateBp,
      baseMinor: documentCharge.baseMinor,
      amountMinor: documentCharge.amountMinor,
      amountLegalMinor: documentCharge.amountLegalMinor,
      taxId: documentCharge.taxId,
      taxRateBp: documentCharge.taxRateBp,
    })
    .from(documentCharge)
    .where(eq(documentCharge.documentId, id))
    .orderBy(asc(documentCharge.position))
    .all()

  const sale = alias(document, "sale")
  const allocations = db
    .select({
      saleDocumentId: allocation.saleDocumentId,
      saleNumber: sale.number,
      amountMinor: allocation.amountMinor,
    })
    .from(allocation)
    .innerJoin(sale, eq(sale.id, allocation.saleDocumentId))
    .where(eq(allocation.paymentDocumentId, id))
    .orderBy(asc(sale.postedAt), asc(sale.id))
    .all()

  // Los lotes que movió cada línea (de su producto, no de sus ingredientes); en un traslado, los
  // que salieron del origen.
  const lotMoves = db
    .select({
      lineId: stockMove.documentLineId,
      lotId: lot.id,
      code: lot.code,
      expiresOn: lot.expiresOn,
      qtyMilli: sql<number>`sum(abs(${stockMove.qtyMilli}))`,
    })
    .from(stockMove)
    .innerJoin(lot, eq(lot.id, stockMove.lotId))
    .innerJoin(documentLine, eq(documentLine.id, stockMove.documentLineId))
    .where(
      and(
        eq(stockMove.documentId, id),
        eq(stockMove.variantId, documentLine.variantId),
        summary.type === "STOCK_TRANSFER"
          ? eq(stockMove.locationId, summary.locationId)
          : undefined,
      ),
    )
    .groupBy(stockMove.documentLineId, lot.id)
    .orderBy(asc(lot.expiresOn))
    .all()
  // Lo que se gastó de cada ingrediente (receta de un plato vendido o de una producción).
  const ingredient = alias(variant, "ingredient")
  const ingredientMoves = db
    .select({
      lineId: stockMove.documentLineId,
      variantId: ingredient.id,
      name: ingredient.name,
      qtyMilli: sql<number>`sum(abs(${stockMove.qtyMilli}))`,
    })
    .from(stockMove)
    .innerJoin(documentLine, eq(documentLine.id, stockMove.documentLineId))
    .innerJoin(ingredient, eq(ingredient.id, stockMove.variantId))
    .where(and(eq(stockMove.documentId, id), ne(stockMove.variantId, documentLine.variantId)))
    .groupBy(stockMove.documentLineId, ingredient.id)
    .orderBy(sql`min(${stockMove}.rowid)`)
    .all()
  const lineNoOf = new Map(
    db
      .select({ id: documentLine.id, lineNo: documentLine.lineNo })
      .from(documentLine)
      .where(eq(documentLine.documentId, id))
      .all()
      .map((l) => [l.id, l.lineNo]),
  )

  return {
    ...summary,
    rate:
      rateBase && rateQuote && rateValue
        ? { base: rateBase, quote: rateQuote, value: rateValue }
        : null,
    lines: lines.map((l) => ({
      ...l,
      modifiers: l.modifiers ?? [],
      lots: lotMoves
        .filter((m) => lineNoOf.get(m.lineId) === l.lineNo)
        .map(({ lotId, code, expiresOn, qtyMilli }) => ({ lotId, code, expiresOn, qtyMilli })),
      ingredients: ingredientMoves
        .filter((m) => lineNoOf.get(m.lineId) === l.lineNo)
        .map(({ variantId, name, qtyMilli }) => ({ variantId, name, qtyMilli })),
    })),
    payments,
    taxes,
    surcharges,
    charges,
    allocations,
  }
}
