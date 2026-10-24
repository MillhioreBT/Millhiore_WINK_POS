/**
 * Lotes con vencimiento. Cada entrada de mercancía de un producto con lotes (una compra, un ajuste)
 * crea o completa un lote con su fecha; las salidas se reparten entre los lotes de la ubicación
 * sin que nadie tenga que elegirlos. Lo que había antes de llevar lotes, o lo que entra sin fecha,
 * queda «sin lote» y se trata como lo más viejo.
 */

/** Lo que hay de un lote en una ubicación. `lotId` null = sin lote. */
export interface LotStock {
  lotId: string | null
  /** Fecha de vencimiento (AAAA-MM-DD); null = sin fecha. */
  expiresOn: string | null
  /** Cuándo entró el lote (ms): a igual vencimiento, sale primero lo más viejo. */
  createdAt: number
  qtyMilli: number
}

export interface LotTake {
  lotId: string | null
  qtyMilli: number
}

/** Si un lote ya venció en `today` (AAAA-MM-DD): vence al terminar su día. */
export function isExpired(expiresOn: string | null, today: string): boolean {
  return expiresOn !== null && expiresOn < today
}

/** Días que le quedan a un lote (0 = vence hoy, negativo = vencido); null sin fecha. */
export function daysLeft(expiresOn: string | null, today: string): number | null {
  if (expiresOn === null) return null
  const ms = Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}

/**
 * El orden en que sale la mercancía: primero lo que no tiene lote (lo más viejo), después el que
 * vence primero (FEFO) y, a igual fecha, el que entró antes; los lotes sin fecha, al final. El
 * id desempata: el reparto siempre sale igual.
 * Al vender o trasladar (`saleable`), lo vencido queda para el final: sale solo si no hay otra
 * cosa, porque lo vencido se da de baja con un ajuste.
 */
export function lotOrder(lots: readonly LotStock[], today: string, saleable: boolean): LotStock[] {
  const rank = (l: LotStock) =>
    l.lotId === null ? 0 : saleable && isExpired(l.expiresOn, today) ? 2 : 1
  return [...lots].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.expiresOn ?? "9999-12-31").localeCompare(b.expiresOn ?? "9999-12-31") ||
      a.createdAt - b.createdAt ||
      (a.lotId ?? "").localeCompare(b.lotId ?? ""),
  )
}

/**
 * Reparte una salida de `qtyMilli` (positiva) entre los lotes, en el orden dado, sin dejar ninguno
 * en negativo. Lo que no alcance sale «sin lote» (la existencia queda en negativo si el negocio lo
 * permite). Devuelve lo que se toma de cada uno, sin partes en cero.
 */
export function takeLots(ordered: readonly LotStock[], qtyMilli: number): LotTake[] {
  const out: LotTake[] = []
  let left = qtyMilli
  for (const l of ordered) {
    if (left <= 0) break
    const take = Math.min(left, Math.max(0, l.qtyMilli))
    if (take > 0) {
      out.push({ lotId: l.lotId, qtyMilli: take })
      left -= take
    }
  }
  if (left > 0) {
    const none = out.find((t) => t.lotId === null)
    if (none) none.qtyMilli += left
    else out.push({ lotId: null, qtyMilli: left })
  }
  return out
}
