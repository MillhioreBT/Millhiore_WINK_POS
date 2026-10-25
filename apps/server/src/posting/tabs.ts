import { type Db, tab, tabLine } from "@millhiore/db"
import { PostingError, uuidv7 } from "@millhiore/domain"
import { and, eq, inArray, isNull } from "drizzle-orm"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Pick<Db, "select">
type TabLineRow = typeof tabLine.$inferSelect

/** Cuánto de cada producto de la cuenta se toma (para cobrar, anular o pasar a otra mesa). */
export interface TabTake {
  lineId: string
  qtyMilli: number
}

/** Lo que falta por cobrar de una cuenta: ni anulado ni pagado. */
export function pendingLines(db: Reader, tabId: string): TabLineRow[] {
  return db
    .select()
    .from(tabLine)
    .where(and(eq(tabLine.tabId, tabId), isNull(tabLine.voidedAt), isNull(tabLine.documentId)))
    .all()
}

/**
 * Las líneas pendientes que se toman, con cuánto de cada una. Falla si alguna ya no está pendiente
 * o no tiene tanto (otro equipo la cobró, la anuló o la pasó a otra mesa mientras tanto).
 */
export function takeLines(
  db: Reader,
  tabId: string,
  takes: readonly TabTake[],
): { line: TabLineRow; qtyMilli: number }[] {
  const ids = takes.map((t) => t.lineId)
  if (new Set(ids).size !== ids.length) {
    throw new PostingError("INVALID_LINE", "Un producto de la cuenta está repetido")
  }
  const rows = new Map(
    (ids.length
      ? db
          .select()
          .from(tabLine)
          .where(and(eq(tabLine.tabId, tabId), inArray(tabLine.id, ids)))
          .all()
      : []
    ).map((r) => [r.id, r]),
  )
  return takes.map((t) => {
    const line = rows.get(t.lineId)
    if (!line || line.voidedAt !== null || line.documentId !== null || t.qtyMilli > line.qtyMilli) {
      throw new PostingError(
        "TAB_CHANGED",
        "La cuenta cambió mientras tanto (otro equipo la cobró o la modificó): vuelve a abrirla",
      )
    }
    return { line, qtyMilli: t.qtyMilli }
  })
}

/**
 * Aplica `changes` a `qtyMilli` de la línea: a toda, o a una parte que pasa a ser una línea nueva
 * (la original se queda con el resto). Devuelve el id de la línea que recibió los cambios.
 */
export function splitLine(
  tx: Tx,
  line: TabLineRow,
  qtyMilli: number,
  changes: Partial<Omit<TabLineRow, "id" | "qtyMilli">>,
  now: number,
): string {
  if (qtyMilli >= line.qtyMilli) {
    tx.update(tabLine).set(changes).where(eq(tabLine.id, line.id)).run()
    return line.id
  }
  const id = uuidv7(now)
  tx.update(tabLine)
    .set({ qtyMilli: line.qtyMilli - qtyMilli })
    .where(eq(tabLine.id, line.id))
    .run()
  tx.insert(tabLine)
    .values({ ...line, ...changes, id, qtyMilli })
    .run()
  return id
}

/**
 * Venta que cobra productos de una cuenta abierta: deben ser los mismos (por producto, la misma
 * cantidad) que trae la venta. Se valida antes de contabilizar.
 */
export function checkTabPayment(
  tx: Reader,
  input: {
    type: string
    lines: readonly { variantId: string; qtyMilli: number }[]
    tab?: { id: string; lines: readonly TabTake[] } | null | undefined
  },
): { line: TabLineRow; qtyMilli: number }[] | null {
  if (!input.tab) return null
  const row = tx.select().from(tab).where(eq(tab.id, input.tab.id)).get()
  if (input.type !== "SALE" || !row) {
    throw new PostingError("UNKNOWN_REFERENCE", "Solo una venta cobra una cuenta abierta")
  }
  if (row.status !== "open") {
    throw new PostingError("TAB_CHANGED", `La cuenta ${row.number} ya no está abierta`)
  }
  const taken = takeLines(tx, row.id, input.tab.lines)
  const want = new Map<string, number>()
  for (const t of taken) {
    want.set(t.line.variantId, (want.get(t.line.variantId) ?? 0) + t.qtyMilli)
  }
  const sold = new Map<string, number>()
  for (const l of input.lines) sold.set(l.variantId, (sold.get(l.variantId) ?? 0) + l.qtyMilli)
  const same =
    want.size === sold.size && [...want].every(([variantId, qty]) => sold.get(variantId) === qty)
  if (!same) {
    throw new PostingError(
      "TAB_CHANGED",
      "Los productos de la venta no coinciden con los de la cuenta: vuelve a cargarla",
    )
  }
  return taken
}

/** Deja cobrados en la venta los productos tomados; si la cuenta queda saldada, se cierra. */
export function settleTab(
  tx: Tx,
  tabId: string,
  taken: readonly { line: TabLineRow; qtyMilli: number }[],
  documentId: string,
  now: number,
): void {
  for (const t of taken) splitLine(tx, t.line, t.qtyMilli, { documentId }, now)
  if (pendingLines(tx, tabId).length === 0) {
    tx.update(tab).set({ status: "closed", closedAt: now }).where(eq(tab.id, tabId)).run()
  }
}
