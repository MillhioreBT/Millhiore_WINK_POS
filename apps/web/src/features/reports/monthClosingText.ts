import type { Payables, Receivables, ResultsReport, SalesReport } from "@millhiore/contracts"
import { formatMoney, formatPercent, formatQty } from "../../lib/format"
import { debtLines } from "../dashboard/closingText"
import { changeBp } from "./compare"

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
]

/** WhatsApp pone en negrita lo que va entre asteriscos. */
const bold = (text: string) => `*${text}*`

/** «Octubre de 2026», o «Octubre de 2026 (hasta el 24)» si el mes no ha terminado. */
export function monthLabel(range: { from: string; to: string }): string {
  const [y = "", m = "", d = ""] = range.to.split("-")
  const name = MONTHS[Number(m) - 1] ?? ""
  const last = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate()
  const label = `${name.replace(/^./, (c) => c.toUpperCase())} de ${y}`
  return Number(d) === last ? label : `${label} (hasta el ${Number(d)})`
}

/** «(▲ 12 % contra el mes anterior)»: cuánto cambió; vacío si antes no había nada. */
function versus(current: number | null, previous: number | null | undefined): string {
  if (current === null || previous === null || previous === undefined) return ""
  const bp = changeBp(current, previous)
  if (bp === null) return ""
  if (bp === 0) return " (igual que el mes anterior)"
  const shown = Math.abs(bp) >= 1000 ? Math.round(bp / 100) * 100 : Math.round(bp / 10) * 10
  return ` (${bp > 0 ? "▲" : "▼"} ${formatPercent(Math.abs(shown))} contra el mes anterior)`
}

/**
 * El cierre del mes como texto para WhatsApp: ventas y resultados comparados con el mes anterior,
 * lo que más se vendió y lo que se debe hoy. Solo incluye lo que tiene datos; la utilidad solo si
 * quien lo arma ve costos.
 */
export function monthClosingText(input: {
  business: string
  label: string
  results: ResultsReport
  previous: ResultsReport | null
  sales: SalesReport
  owed: Receivables | null
  owing: Payables | null
}): string {
  const { results: r, previous: p, sales } = input
  const c = r.legalCurrency
  const money = (minor: number) => formatMoney(minor, c)
  const out: string[] = [bold(input.business), `Cierre del mes · ${input.label}`, ""]

  out.push(bold("VENTAS"))
  out.push(`Ventas: ${r.sales.count}${versus(r.sales.count, p?.sales.count)}`)
  out.push(
    `Total vendido: ${money(r.sales.totalLegalMinor)}${versus(r.sales.totalLegalMinor, p?.sales.totalLegalMinor)}`,
  )
  if (sales.totals.averageLegalMinor) {
    out.push(`Promedio por venta: ${money(sales.totals.averageLegalMinor)}`)
  }
  if (r.sales.taxLegalMinor) out.push(`IVA: ${money(r.sales.taxLegalMinor)}`)
  if (r.sales.surchargeLegalMinor) out.push(`IGTF: ${money(r.sales.surchargeLegalMinor)}`)
  if (sales.totals.returnsLegalMinor) {
    out.push(`Devoluciones: ${money(sales.totals.returnsLegalMinor)}`)
  }
  if (r.sales.discountLegalMinor) out.push(`Descuentos dados: ${money(r.sales.discountLegalMinor)}`)

  if (r.grossProfitLegalMinor !== null) {
    out.push("", bold("RESULTADOS"))
    out.push(
      `Utilidad bruta: ${money(r.grossProfitLegalMinor)}` +
        (r.grossMarginBp !== null ? ` (margen ${formatPercent(r.grossMarginBp)})` : ""),
    )
  } else if (r.expenses.totalLegalMinor || r.commissionsLegalMinor) {
    out.push("", bold("GASTOS"))
  }
  if (r.expenses.totalLegalMinor) {
    out.push(
      `Gastos: ${money(r.expenses.totalLegalMinor)}${versus(r.expenses.totalLegalMinor, p?.expenses.totalLegalMinor)}`,
    )
  }
  if (r.inventoryLossLegalMinor) {
    out.push(`Pérdidas de inventario: ${money(r.inventoryLossLegalMinor)}`)
  }
  if (r.commissionsLegalMinor) {
    out.push(`Comisiones de bancos: ${money(r.commissionsLegalMinor)}`)
  }
  if (r.netProfitLegalMinor !== null) {
    out.push(
      bold(
        `Utilidad neta: ${money(r.netProfitLegalMinor)}${versus(r.netProfitLegalMinor, p?.netProfitLegalMinor)}`,
      ),
    )
  }
  if (r.purchases.count) {
    out.push(
      `Compras de mercancía: ${money(r.purchases.totalLegalMinor)} (${r.purchases.count} factura${r.purchases.count === 1 ? "" : "s"})`,
    )
  }

  const categories = sales.byCategory.filter((x) => x.totalLegalMinor > 0)
  if (categories.length > 1) {
    out.push("", bold("POR CATEGORÍA"))
    categories.slice(0, 5).forEach((x, i) => {
      out.push(`${i + 1}. ${x.name}: ${money(x.totalLegalMinor)}`)
    })
  }
  const top = sales.byProduct.filter((x) => x.qtyMilli > 0)
  if (top.length) {
    out.push("", bold("LO MÁS VENDIDO"))
    top.slice(0, 5).forEach((x, i) => {
      out.push(`${i + 1}. ${x.name} × ${formatQty(x.qtyMilli)}`)
    })
  }

  out.push(...debtLines(input.owed, input.owing))
  return out.join("\n")
}
