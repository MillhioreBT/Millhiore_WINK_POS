import { document, documentLine, variant } from "@millhiore/db"
import { and, asc, eq, isNull, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import type { Reader } from "./receivables"

/** Una línea de la venta con lo que ya se devolvió y lo que todavía se puede devolver. */
export interface ReturnableLine {
  lineNo: number
  variantId: string
  name: string
  /** Lo vendido en la línea (milésimas), su precio y descuento originales. */
  qtyMilli: number
  unitPriceMinor: number
  discountMinor: number
  lineTotalMinor: number
  taxId: string | null
  taxRateBp: number
  /** Lo ya devuelto de esta línea (devoluciones vigentes) y el descuento que se le aplicó. */
  returnedMilli: number
  returnedDiscountMinor: number
  remainingMilli: number
}

/** Lo devuelto de una venta por producto; las devoluciones anuladas ya no cuentan. */
function returnedByVariant(db: Reader, saleId: string) {
  const reversal = alias(document, "reversal")
  return new Map(
    db
      .select({
        variantId: documentLine.variantId,
        qty: sql<number>`coalesce(sum(${documentLine.qtyMilli}), 0)`,
        discount: sql<number>`coalesce(sum(${documentLine.discountMinor}), 0)`,
      })
      .from(documentLine)
      .innerJoin(document, eq(document.id, documentLine.documentId))
      .leftJoin(reversal, eq(reversal.reversesDocumentId, document.id))
      .where(
        and(
          eq(document.type, "RETURN"),
          eq(document.returnsDocumentId, saleId),
          isNull(document.reversesDocumentId),
          isNull(reversal.id),
        ),
      )
      .groupBy(documentLine.variantId)
      .all()
      .map((r) => [r.variantId, { qty: r.qty, discount: r.discount }]),
  )
}

/**
 * Las líneas de una venta con lo que queda por devolver. Si el mismo producto aparece en varias
 * líneas, lo devuelto se reparte entre ellas en orden (la primera se agota antes).
 */
export function returnableLines(db: Reader, saleId: string): ReturnableLine[] {
  const returned = returnedByVariant(db, saleId)
  const pool = new Map([...returned].map(([id, r]) => [id, { qty: r.qty, discount: r.discount }]))
  return db
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
    })
    .from(documentLine)
    .innerJoin(variant, eq(variant.id, documentLine.variantId))
    .where(eq(documentLine.documentId, saleId))
    .orderBy(asc(documentLine.lineNo))
    .all()
    .map((l) => {
      const left = pool.get(l.variantId) ?? { qty: 0, discount: 0 }
      const take = Math.min(l.qtyMilli, left.qty)
      // El descuento devuelto se reparte en proporción a lo que absorbe esta línea.
      const discount = left.qty > 0 ? Math.round((left.discount * take) / left.qty) : 0
      pool.set(l.variantId, { qty: left.qty - take, discount: left.discount - discount })
      return {
        ...l,
        returnedMilli: take,
        returnedDiscountMinor: discount,
        remainingMilli: l.qtyMilli - take,
      }
    })
}

/** La venta ya fue anulada (tiene un documento de reverso). */
export function isReversed(db: Reader, documentId: string): boolean {
  return (
    db
      .select({ id: document.id })
      .from(document)
      .where(eq(document.reversesDocumentId, documentId))
      .get() !== undefined
  )
}

/** Devoluciones vigentes de una venta (sin contar las anuladas): impide anular la venta. */
export function activeReturns(db: Reader, saleId: string): number {
  const reversal = alias(document, "reversal")
  return db
    .select({ id: document.id })
    .from(document)
    .leftJoin(reversal, eq(reversal.reversesDocumentId, document.id))
    .where(
      and(
        eq(document.type, "RETURN"),
        eq(document.returnsDocumentId, saleId),
        isNull(document.reversesDocumentId),
        isNull(reversal.id),
      ),
    )
    .all().length
}
