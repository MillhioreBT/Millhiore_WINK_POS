import type { DocumentDetail, DocumentSummary } from "@millhiore/contracts"
import {
  allocation,
  branch,
  contact,
  type Db,
  discountCode,
  document,
  documentCharge,
  documentLine,
  documentSurcharge,
  documentTax,
  expenseCategory,
  fiscalInvoice,
  location,
  lot,
  payment,
  paymentMethod,
  product,
  stockMove,
  stockReason,
  terminal,
  user,
  variant,
} from "@millhiore/db"
import { DOCUMENT_TYPES, type DocumentType } from "@millhiore/domain"
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { HttpError } from "../../http/errors"
import { inBranches } from "../branches/service"
import { features } from "../features/routes"

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
  // Los datos que quedaron en el documento; los documentos de antes de guardarlos, los de hoy.
  contactName: sql<string | null>`coalesce(${document.customerName}, ${contact.name})`,
  contactTaxId: sql<
    string | null
  >`case when ${document.customerName} is null then ${contact.taxId} else ${document.customerTaxId} end`,
  contactAddress: sql<
    string | null
  >`case when ${document.customerName} is null then ${contact.address} else ${document.customerAddress} end`,
  invoiceRequested: document.invoiceRequested,
  invoice: {
    invoiceNumber: fiscalInvoice.invoiceNumber,
    controlNumber: fiscalInvoice.controlNumber,
    recordedAt: fiscalInvoice.recordedAt,
  },
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
  branch: { id: branch.id, name: branch.name, address: branch.address, phone: branch.phone },
}

/** La sucursal solo se muestra con las sucursales activadas. */
function withBranch<T extends { branch: DocumentSummary["branch"] }>(db: Db, rows: T[]): T[] {
  return features(db).branches ? rows : rows.map((r) => ({ ...r, branch: null }))
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
    /** Solo las ventas con factura que todavía no tienen sus números (y no se anularon). */
    invoicePending?: boolean | undefined
    /**
     * Solo los de estas sucursales (por la ubicación de la que salen, o adonde llega un
     * traslado); null, todas.
     */
    branchIds?: readonly string[] | null | undefined
    limit: number
  },
): DocumentSummary[] {
  const filters = [
    opts.branchIds
      ? or(
          inBranches(document.locationId, opts.branchIds),
          inBranches(document.toLocationId, opts.branchIds),
        )
      : undefined,
    opts.types?.length ? inArray(document.type, opts.types) : undefined,
    opts.from !== undefined ? gte(document.postedAt, opts.from) : undefined,
    opts.to !== undefined ? lt(document.postedAt, opts.to) : undefined,
    opts.expenseCategoryId ? eq(document.expenseCategoryId, opts.expenseCategoryId) : undefined,
    opts.invoicePending
      ? and(
          eq(document.invoiceRequested, true),
          isNull(fiscalInvoice.documentId),
          isNull(reversal.id),
        )
      : undefined,
  ].filter((f) => f !== undefined)
  const rows = db
    .select(summaryColumns)
    .from(document)
    .leftJoin(reversal, eq(reversal.reversesDocumentId, document.id))
    .leftJoin(returned, eq(returned.id, document.returnsDocumentId))
    .leftJoin(user, eq(user.id, document.createdBy))
    .leftJoin(contact, eq(contact.id, document.contactId))
    .leftJoin(fiscalInvoice, eq(fiscalInvoice.documentId, document.id))
    .leftJoin(expenseCategory, eq(expenseCategory.id, document.expenseCategoryId))
    .leftJoin(stockReason, eq(stockReason.id, document.stockReasonId))
    .innerJoin(terminal, eq(terminal.id, document.terminalId))
    .innerJoin(location, eq(location.id, document.locationId))
    .leftJoin(destination, eq(destination.id, document.toLocationId))
    .leftJoin(tipUser, eq(tipUser.id, document.tipUserId))
    .leftJoin(discountCode, eq(discountCode.id, document.discountCodeId))
    .leftJoin(branch, eq(branch.id, location.branchId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(document.postedAt), desc(document.id))
    .limit(opts.limit)
    .all()
  return withBranch(db, rows)
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
    .leftJoin(fiscalInvoice, eq(fiscalInvoice.documentId, document.id))
    .leftJoin(expenseCategory, eq(expenseCategory.id, document.expenseCategoryId))
    .leftJoin(stockReason, eq(stockReason.id, document.stockReasonId))
    .innerJoin(terminal, eq(terminal.id, document.terminalId))
    .innerJoin(location, eq(location.id, document.locationId))
    .leftJoin(destination, eq(destination.id, document.toLocationId))
    .leftJoin(tipUser, eq(tipUser.id, document.tipUserId))
    .leftJoin(discountCode, eq(discountCode.id, document.discountCodeId))
    .leftJoin(branch, eq(branch.id, location.branchId))
    .where(eq(document.id, id))
    .get()
  if (!head) throw new HttpError(404, "NOT_FOUND", `No existe el documento ${id}`)
  const [{ rateBase, rateQuote, rateValue, ...summary }] = withBranch(db, [head]) as [typeof head]

  const lines = db
    .select({
      lineNo: documentLine.lineNo,
      variantId: documentLine.variantId,
      name: variant.name,
      unit: product.unit,
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
    .innerJoin(product, eq(product.id, variant.productId))
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
