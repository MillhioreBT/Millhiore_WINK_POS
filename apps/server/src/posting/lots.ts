import type { Db } from "@millhiore/db"
import { document, lot, lotBalance, stockBalance, stockMove } from "@millhiore/db"
import {
  type LotStock,
  type LotTake,
  lotOrder,
  PostingError,
  takeLots,
  uuidv7,
} from "@millhiore/domain"
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Pick<Db, "select">

/**
 * Lo que hay de un producto en una ubicación, lote por lote. Lo que no está en ningún lote (lo que
 * había antes de llevar lotes, o lo que entró sin fecha) va como «sin lote».
 */
export function lotStock(db: Reader, variantId: string, locationId: string): LotStock[] {
  const lots = db
    .select({
      lotId: lot.id,
      expiresOn: lot.expiresOn,
      createdAt: lot.createdAt,
      qtyMilli: lotBalance.qtyMilli,
    })
    .from(lotBalance)
    .innerJoin(lot, eq(lot.id, lotBalance.lotId))
    .where(
      and(
        eq(lot.variantId, variantId),
        eq(lotBalance.locationId, locationId),
        ne(lotBalance.qtyMilli, 0),
      ),
    )
    .all()
  const total =
    db
      .select({ qty: stockBalance.qtyMilli })
      .from(stockBalance)
      .where(and(eq(stockBalance.variantId, variantId), eq(stockBalance.locationId, locationId)))
      .get()?.qty ?? 0
  const inLots = lots.reduce((acc, l) => acc + l.qtyMilli, 0)
  return [{ lotId: null, expiresOn: null, createdAt: 0, qtyMilli: total - inLots }, ...lots]
}

/**
 * Reparte una salida entre los lotes de la ubicación: primero lo sin lote, después el que vence
 * antes. Al vender o trasladar (`saleable`), lo vencido sale solo si no queda otra cosa.
 */
export function allocateOut(
  db: Reader,
  variantId: string,
  locationId: string,
  qtyMilli: number,
  today: string,
  saleable: boolean,
): LotTake[] {
  return takeLots(lotOrder(lotStock(db, variantId, locationId), today, saleable), qtyMilli)
}

/** Lo que queda de un lote en una ubicación. */
export function lotQty(db: Reader, lotId: string, locationId: string): number {
  return (
    db
      .select({ qty: lotBalance.qtyMilli })
      .from(lotBalance)
      .where(and(eq(lotBalance.lotId, lotId), eq(lotBalance.locationId, locationId)))
      .get()?.qty ?? 0
  )
}

/**
 * El lote al que entra mercancía nueva: si ya existe uno del producto con el mismo código y la
 * misma fecha, se completa ese; si no, se crea con el documento que lo trae.
 */
export function lotFor(
  tx: Tx,
  input: {
    variantId: string
    code: string | null
    expiresOn: string | null
    documentId: string
    now: number
  },
): string {
  const existing = tx
    .select({ id: lot.id })
    .from(lot)
    .where(
      and(
        eq(lot.variantId, input.variantId),
        input.code === null ? isNull(lot.code) : eq(lot.code, input.code),
        input.expiresOn === null ? isNull(lot.expiresOn) : eq(lot.expiresOn, input.expiresOn),
      ),
    )
    .get()
  if (existing) return existing.id
  const id = uuidv7(input.now)
  tx.insert(lot)
    .values({
      id,
      variantId: input.variantId,
      code: input.code,
      expiresOn: input.expiresOn,
      documentId: input.documentId,
      createdAt: input.now,
    })
    .run()
  return id
}

/**
 * Lo que una devolución puede regresar a cada lote: lo que la venta sacó de él menos lo que ya
 * regresaron las devoluciones vigentes (las anuladas se compensan con su reverso).
 */
export function returnableLots(db: Reader, saleId: string, variantId: string): LotTake[] {
  // Regresa primero al lote que vence antes (el orden en que la venta los sacó).
  const taken = db
    .select({ lotId: stockMove.lotId, qty: sql<number>`-sum(${stockMove.qtyMilli})` })
    .from(stockMove)
    .innerJoin(lot, eq(lot.id, stockMove.lotId))
    .where(and(eq(stockMove.documentId, saleId), eq(stockMove.variantId, variantId)))
    .groupBy(stockMove.lotId)
    .orderBy(sql`${lot.expiresOn} is null`, asc(lot.expiresOn), asc(lot.createdAt), asc(lot.id))
    .all()
  const returned = new Map(
    db
      .select({ lotId: stockMove.lotId, qty: sql<number>`sum(${stockMove.qtyMilli})` })
      .from(stockMove)
      .innerJoin(document, eq(document.id, stockMove.documentId))
      .where(and(eq(document.returnsDocumentId, saleId), eq(stockMove.variantId, variantId)))
      .groupBy(stockMove.lotId)
      .all()
      .map((r) => [r.lotId, r.qty]),
  )
  return taken
    .filter((t): t is { lotId: string; qty: number } => t.lotId !== null)
    .map((t) => ({ lotId: t.lotId, qtyMilli: t.qty - (returned.get(t.lotId) ?? 0) }))
    .filter((t) => t.qtyMilli > 0)
}

/**
 * Lo que una devolución al proveedor puede sacar de cada lote que trajo la compra: lo que entró
 * menos lo ya devuelto, sin pasar de lo que queda del lote en la ubicación.
 */
export function purchaseLots(
  db: Reader,
  purchaseId: string,
  variantId: string,
  locationId: string,
): LotTake[] {
  const brought = db
    .select({ lotId: stockMove.lotId, qty: sql<number>`sum(${stockMove.qtyMilli})` })
    .from(stockMove)
    .innerJoin(lot, eq(lot.id, stockMove.lotId))
    .where(and(eq(stockMove.documentId, purchaseId), eq(stockMove.variantId, variantId)))
    .groupBy(stockMove.lotId)
    .orderBy(sql`${lot.expiresOn} is null`, asc(lot.expiresOn), asc(lot.id))
    .all()
  const returned = new Map(
    db
      .select({ lotId: stockMove.lotId, qty: sql<number>`-sum(${stockMove.qtyMilli})` })
      .from(stockMove)
      .innerJoin(document, eq(document.id, stockMove.documentId))
      .where(and(eq(document.returnsDocumentId, purchaseId), eq(stockMove.variantId, variantId)))
      .groupBy(stockMove.lotId)
      .all()
      .map((r) => [r.lotId, r.qty]),
  )
  return brought
    .filter((t): t is { lotId: string; qty: number } => t.lotId !== null)
    .map((t) => ({
      lotId: t.lotId,
      qtyMilli: Math.min(t.qty - (returned.get(t.lotId) ?? 0), lotQty(db, t.lotId, locationId)),
    }))
    .filter((t) => t.qtyMilli > 0)
}

/** Actualiza lo que hay de un lote en una ubicación (la proyección de sus movimientos). */
export function applyLotMove(
  tx: Tx,
  move: { lotId: string; locationId: string; qtyMilli: number },
  allowNegativeStock: boolean,
): void {
  const row = tx
    .insert(lotBalance)
    .values(move)
    .onConflictDoUpdate({
      target: [lotBalance.lotId, lotBalance.locationId],
      set: { qtyMilli: sql`${lotBalance.qtyMilli} + ${move.qtyMilli}` },
    })
    .returning({ qty: lotBalance.qtyMilli })
    .get()
  if (move.qtyMilli < 0 && row && row.qty < 0 && !allowNegativeStock) {
    throw new PostingError(
      "INSUFFICIENT_STOCK",
      `El lote ya no tiene esa cantidad (quedaría en ${row.qty / 1000})`,
    )
  }
}
