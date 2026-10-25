import type { DaySummary, ShiftReport, WebOrder } from "@millhiore/contracts"
import { type Db, document, product, stockBalance, stockMove, user, variant } from "@millhiore/db"
import { money } from "@millhiore/printing"
import { and, eq, inArray, lt, sql } from "drizzle-orm"

// Los textos de las alertas por Telegram: cortos, sin formato (un nombre con * o _ no rompe nada)
// y con lo que el dueño necesita saber de un vistazo.

type Reader = Pick<Db, "select">

const qtyFormat = new Intl.NumberFormat("es-VE", { maximumFractionDigits: 3 })
const grams = new Intl.NumberFormat("es-VE", { minimumFractionDigits: 3, maximumFractionDigits: 3 })

/** «3», «0,350 kg» o «1,5 l». */
function quantity(milli: number, unit: string): string {
  if (unit === "unit") return qtyFormat.format(milli / 1000)
  return `${(unit === "kg" ? grams : qtyFormat).format(milli / 1000)} ${unit}`
}

const DOC_NAMES: Record<string, string> = {
  SALE: "la venta",
  RETURN: "la devolución",
  PURCHASE: "la compra",
  PURCHASE_RETURN: "la devolución al proveedor",
  EXPENSE: "el gasto",
  ADJUSTMENT: "el ajuste",
  PAYMENT_IN: "el abono",
  PAYMENT_OUT: "el pago",
  TRANSFER: "la transferencia",
  STOCK_TRANSFER: "el traslado",
  DEBT_IN: "la deuda",
  DEBT_OUT: "la deuda",
  PRODUCTION: "la producción",
}

/**
 * «🛒 Pedido P-000012 de Ana (0414-1112233): 2 × Café, 1 × Franela (M). Total $ 16,00. Delivery a
 * Calle 5.»
 */
export function orderText(o: WebOrder): string {
  const items = o.lines.map((l) => `${quantity(l.qtyMilli, l.unit)} × ${l.name}`).join(", ")
  const total =
    o.totalReferenceMinor !== null
      ? ` Total ${money(o.totalReferenceMinor, o.referenceCurrency)}.`
      : o.totalLegalMinor !== null
        ? ` Total ${money(o.totalLegalMinor, o.legalCurrency)}.`
        : ""
  const how =
    o.delivery === "delivery" ? ` Delivery a ${o.address ?? "—"}.` : " Retira en la tienda."
  const pay = o.payment ? ` Paga con ${o.payment}.` : ""
  return `🛒 Pedido ${o.number} de ${o.customerName} (${o.customerPhone}): ${items}.${total}${how}${pay}`
}

/** «❌ Anulada la venta C1-000012 (Bs 365,00). La anuló Dueña.» */
export function voidText(db: Reader, reversalId: string, originalId: string): string | null {
  const original = db
    .select({
      type: document.type,
      number: document.number,
      totalMinor: document.totalMinor,
      currency: document.currency,
    })
    .from(document)
    .where(eq(document.id, originalId))
    .get()
  if (!original) return null
  const by = db
    .select({ name: user.name })
    .from(document)
    .innerJoin(user, eq(user.id, document.createdBy))
    .where(eq(document.id, reversalId))
    .get()?.name
  const total = original.totalMinor ? ` (${money(original.totalMinor, original.currency)})` : ""
  const what = DOC_NAMES[original.type] ?? "el documento"
  return `❌ Anulada ${what} ${original.number}${total}.${by ? ` La anuló ${by}.` : ""}`
}

/**
 * Lo que un documento dejó en su existencia mínima o por debajo (y antes estaba por encima):
 * así se avisa una sola vez, cuando cruza. null si nada cruzó.
 */
export function lowStockText(db: Reader, documentId: string): string | null {
  const out = db
    .select({ variantId: stockMove.variantId, qtyMilli: sql<number>`sum(${stockMove.qtyMilli})` })
    .from(stockMove)
    .where(and(eq(stockMove.documentId, documentId), lt(stockMove.qtyMilli, 0)))
    .groupBy(stockMove.variantId)
    .all()
  if (out.length === 0) return null
  const rows = db
    .select({
      id: variant.id,
      name: variant.name,
      unit: product.unit,
      min: variant.minStockMilli,
      stock: sql<number>`coalesce((select sum(${stockBalance.qtyMilli}) from ${stockBalance}
        where ${stockBalance.variantId} = ${variant.id}), 0)`,
    })
    .from(variant)
    .innerJoin(product, eq(product.id, variant.productId))
    .where(
      inArray(
        variant.id,
        out.map((o) => o.variantId),
      ),
    )
    .all()
  const crossed = rows.filter((r) => {
    const moved = -(out.find((o) => o.variantId === r.id)?.qtyMilli ?? 0)
    return r.min !== null && r.stock <= r.min && r.stock + moved > r.min
  })
  if (crossed.length === 0) return null
  return [
    "⚠️ Por reponer",
    ...crossed.map(
      (r) =>
        `• ${r.name}: quedan ${quantity(r.stock, r.unit)} (mínimo ${quantity(r.min ?? 0, r.unit)})`,
    ),
  ].join("\n")
}

/** El cierre de un turno: lo vendido y, del arqueo, solo lo que no cuadró. */
export function shiftText(report: ShiftReport): string {
  const legal = report.legalCurrency
  const net = report.sales.count - report.sales.voided
  const lines = [
    `🔒 Cierre de turno · ${report.terminalName}${report.closedBy ? ` · ${report.closedBy}` : ""}`,
    `Vendido: ${money(report.sales.totalLegalMinor, legal)} (${net} venta${net === 1 ? "" : "s"})`,
  ]
  const off = report.accounts.filter((a) => (a.differenceMinor ?? 0) !== 0)
  if (off.length === 0) lines.push("El arqueo cuadró.")
  for (const a of off) {
    const d = a.differenceMinor ?? 0
    lines.push(
      `${a.accountName}: ${d > 0 ? "sobrante" : "faltante"} de ${money(Math.abs(d), a.currency)}`,
    )
  }
  if (report.closingNote) lines.push(`Nota: ${report.closingNote}`)
  return lines.join("\n")
}

/** «💱 Tasa nueva: 1 USD = 36,50 Bs (BCV)». */
export function rateText(rate: { base: string; quote: string; value: string; source?: string }) {
  const value = new Intl.NumberFormat("es-VE", { maximumFractionDigits: 4 }).format(
    Number(rate.value),
  )
  const quote = rate.quote === "VES" ? "Bs" : rate.quote
  return `💱 Tasa nueva: 1 ${rate.base} = ${value} ${quote}${rate.source ? ` (${rate.source.toUpperCase()})` : ""}`
}

const dayFormat = new Intl.DateTimeFormat("es-VE", {
  timeZone: "America/Caracas",
  weekday: "long",
  day: "numeric",
  month: "long",
})

/** El resumen del día, corto: ventas, cobrado por método, gastos, lo más vendido y por reponer. */
export function dailyText(s: DaySummary, businessName: string): string {
  const legal = s.legalCurrency
  const net = s.sales.count - s.sales.voided
  const day = dayFormat.format(s.from + 12 * 3_600_000)
  const lines = [
    `📊 ${businessName} · ${day}`,
    `Ventas: ${net} · ${money(s.sales.totalLegalMinor, legal)}${
      s.sales.totalReferenceMinor !== null
        ? ` (≈ ${money(s.sales.totalReferenceMinor, s.referenceCurrency)})`
        : ""
    }`,
  ]
  if (s.sales.voided) lines.push(`Anuladas: ${s.sales.voided}`)
  if (s.byMethod.length) {
    lines.push("", "Cobrado:")
    for (const m of s.byMethod) lines.push(`• ${m.methodName}: ${money(m.amountMinor, m.currency)}`)
  }
  if (s.expenses.count) lines.push("", `Gastos: ${money(s.expenses.totalLegalMinor, legal)}`)
  if (s.topProducts.length) {
    lines.push("", "Lo más vendido:")
    s.topProducts.slice(0, 3).forEach((p, i) => {
      lines.push(`${i + 1}. ${p.name} × ${qtyFormat.format(p.qtyMilli / 1000)}`)
    })
  }
  if (s.lowStock?.length) {
    lines.push(
      "",
      `Por reponer: ${s.lowStock.length} producto${s.lowStock.length === 1 ? "" : "s"}`,
    )
  }
  if (s.openShifts.length) {
    lines.push(`Cajas abiertas: ${s.openShifts.map((sh) => sh.terminalName).join(", ")}`)
  }
  return lines.join("\n")
}
