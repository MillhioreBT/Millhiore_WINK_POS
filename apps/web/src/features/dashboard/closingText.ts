import type { DaySummary, Payables, Receivables } from "@millhiore/contracts"
import { formatDay, formatMoney, formatQty } from "../../lib/format"

const HOUR = 3_600_000

/** WhatsApp pone en negrita lo que va entre asteriscos. */
const bold = (text: string) => `*${text}*`

/**
 * El cierre del día como texto para copiar o mandar por WhatsApp (al dueño, al contador o al
 * grupo del negocio). Solo incluye lo que tiene datos; cada cifra sale del resumen del día.
 * `owed` son las cuentas por cobrar de ahora mismo y `owing` las que se deben a proveedores (null
 * si quien lo arma no las ve).
 */
export function closingText(
  s: DaySummary,
  business: { name: string },
  owed: Receivables | null,
  owing: Payables | null = null,
): string {
  const legal = s.legalCurrency
  const reference = s.referenceCurrency
  const day = formatDay(s.from + 12 * HOUR).replace(/^./, (c) => c.toUpperCase())
  const net = s.sales.count - s.sales.voided
  const out: string[] = [`${bold(business.name)}`, `Cierre del día · ${day}`, ""]

  out.push(bold("VENTAS"))
  out.push(
    `Ventas: ${net}${s.sales.voided ? ` (${s.sales.voided} anulada${s.sales.voided === 1 ? "" : "s"})` : ""}`,
  )
  out.push(
    `Total vendido: ${formatMoney(s.sales.totalLegalMinor, legal)}` +
      (s.sales.totalReferenceMinor !== null
        ? ` (≈ ${formatMoney(s.sales.totalReferenceMinor, reference)})`
        : ""),
  )
  if (net > 0) {
    out.push(`Promedio por venta: ${formatMoney(Math.round(s.sales.totalLegalMinor / net), legal)}`)
  }
  if (s.sales.taxLegalMinor) out.push(`IVA: ${formatMoney(s.sales.taxLegalMinor, legal)}`)
  if (s.sales.surchargeLegalMinor) {
    out.push(`IGTF: ${formatMoney(s.sales.surchargeLegalMinor, legal)}`)
  }
  if (s.sales.returnsLegalMinor) {
    out.push(`Devoluciones: ${formatMoney(s.sales.returnsLegalMinor, legal)}`)
  }
  if (s.sales.discountLegalMinor) {
    out.push(`Descuentos dados: ${formatMoney(s.sales.discountLegalMinor, legal)}`)
  }
  if (s.sales.creditLegalMinor) {
    out.push(`Vendido a crédito: ${formatMoney(s.sales.creditLegalMinor, legal)}`)
  }

  if (s.byMethod.length) {
    out.push("", bold("COBRADO POR MÉTODO"))
    for (const m of s.byMethod)
      out.push(
        `• ${m.methodName}: ${formatMoney(m.amountMinor, m.currency)}${m.commissionMinor ? ` (comisión ${formatMoney(m.commissionMinor, m.currency)})` : ""}`,
      )
  }
  if (s.collections.count) {
    out.push(
      `Incluye ${s.collections.count} abono${s.collections.count === 1 ? "" : "s"} de clientes (${formatMoney(s.collections.totalLegalMinor, legal)})`,
    )
  }

  if (s.purchases.count) {
    out.push(
      "",
      bold("COMPRAS"),
      `${s.purchases.count} factura${s.purchases.count === 1 ? "" : "s"} de proveedor: ${formatMoney(s.purchases.totalLegalMinor, legal)}`,
    )
  }

  if (s.expenses.count > 0 || s.expenses.totalLegalMinor !== 0) {
    out.push(
      "",
      bold("GASTOS"),
      `${s.expenses.count} gasto${s.expenses.count === 1 ? "" : "s"}: ${formatMoney(s.expenses.totalLegalMinor, legal)}`,
    )
  }
  // Merma, vencido, uso interno… a costo (solo si quien lo manda ve costos).
  if (s.inventoryLossLegalMinor) {
    out.push(`Pérdidas de inventario: ${formatMoney(s.inventoryLossLegalMinor, legal)}`)
  }

  if (s.topProducts.length) {
    out.push("", bold("LO MÁS VENDIDO"))
    s.topProducts.slice(0, 5).forEach((p, i) => {
      out.push(`${i + 1}. ${p.name} × ${formatQty(p.qtyMilli)}`)
    })
  }

  out.push(...debtLines(owed, owing))

  if (s.lowStock?.length) {
    out.push("", bold("POR REPONER"))
    for (const p of s.lowStock.slice(0, 8)) {
      out.push(`• ${p.name}: ${formatQty(p.stockMilli)}`)
    }
    if (s.lowStock.length > 8) out.push(`… y ${s.lowStock.length - 8} más`)
  }

  if (s.openShifts.length) {
    out.push("", `Cajas abiertas: ${s.openShifts.map((sh) => sh.terminalName).join(", ")}`)
  }
  return out.join("\n")
}

/** Lo que deben los clientes y lo que se les debe a los proveedores, ahora mismo. */
export function debtLines(owed: Receivables | null, owing: Payables | null): string[] {
  const out: string[] = []
  if (owed?.totals.length) {
    out.push("", bold("POR COBRAR (FIADO)"))
    for (const t of owed.totals) {
      out.push(
        `${formatMoney(t.outstandingMinor, t.currency)} · ${t.customers} cliente${t.customers === 1 ? "" : "s"}` +
          (t.overdueMinor > 0 ? ` · ${formatMoney(t.overdueMinor, t.currency)} vencido` : ""),
      )
    }
  }

  if (owing?.totals.length) {
    out.push("", bold("POR PAGAR (PROVEEDORES)"))
    for (const t of owing.totals) {
      out.push(
        `${formatMoney(t.outstandingMinor, t.currency)} · ${t.suppliers} proveedor${t.suppliers === 1 ? "" : "es"}` +
          (t.overdueMinor > 0 ? ` · ${formatMoney(t.overdueMinor, t.currency)} vencido` : ""),
      )
    }
  }
  return out
}
