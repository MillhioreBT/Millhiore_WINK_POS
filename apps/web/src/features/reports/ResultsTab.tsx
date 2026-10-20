import { Card, CardContent, CardHeader, CardTitle } from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { TriangleAlertIcon } from "lucide-react"
import { formatMoney, formatPercent } from "../../lib/format"
import { resultsReportQuery } from "../../lib/queries"
import { bold, downloadXlsx, fileName, moneyCell, percentCell } from "../../lib/xlsx"
import { ExportButtons, Line, PrintHeader } from "./parts"

/** Cuánto ganó el negocio en el período: ventas, costo, gastos, pérdidas y comisiones. */
export function ResultsTab({
  bounds,
  period,
  business,
}: {
  bounds: { from: number; to: number }
  period: string
  business: string
}) {
  const { data: r, isLoading } = useQuery(resultsReportQuery(bounds))
  if (!r) {
    return <p className="text-muted-foreground text-sm">{isLoading ? "Cargando…" : "Sin datos."}</p>
  }
  const c = r.legalCurrency
  const money = (minor: number | null) => (minor === null ? "—" : formatMoney(minor, c))
  const negated = (minor: number | null) => (minor === null ? null : -minor)
  const costKnown = r.costOfGoodsLegalMinor !== null
  const profitNegative = (r.netProfitLegalMinor ?? 0) < 0

  const exportXlsx = () =>
    downloadXlsx(fileName("resultados", period), [
      {
        name: "Resultados",
        widths: [44, 18],
        rows: [
          [bold(`${business} · Estado de resultados`)],
          [`Período: ${period}`],
          [`Moneda: ${c}`],
          [],
          ["Ventas (con IVA)", moneyCell(r.sales.totalLegalMinor)],
          ["IVA", moneyCell(-r.sales.taxLegalMinor)],
          [bold("Ventas sin IVA"), moneyCell(r.sales.netLegalMinor, 2, true)],
          ["Costo de lo vendido", moneyCell(negated(r.costOfGoodsLegalMinor))],
          [bold("Utilidad bruta"), moneyCell(r.grossProfitLegalMinor, 2, true)],
          ["Margen bruto", percentCell(r.grossMarginBp)],
          ["Gastos", moneyCell(-r.expenses.totalLegalMinor)],
          ["Pérdidas de inventario", moneyCell(negated(r.inventoryLossLegalMinor))],
          ["Comisiones de bancos y puntos de venta", moneyCell(-r.commissionsLegalMinor)],
          [bold("Utilidad neta"), moneyCell(r.netProfitLegalMinor, 2, true)],
          [],
          [bold("Informativo")],
          ["Compras de mercancía", moneyCell(r.purchases.totalLegalMinor)],
          ["IGTF cobrado (se declara aparte)", moneyCell(r.sales.surchargeLegalMinor)],
          ["Descuentos dados", moneyCell(r.sales.discountLegalMinor)],
          ["Líneas vendidas sin costo conocido", r.linesWithoutCost],
        ],
      },
      {
        name: "Gastos por categoría",
        widths: [40, 10, 18],
        rows: [
          [bold("Categoría"), bold("Gastos"), bold("Total")],
          ...r.expenses.byCategory.map((e) => [e.name, e.count, moneyCell(e.totalLegalMinor)]),
          [bold("Total"), r.expenses.count, moneyCell(r.expenses.totalLegalMinor, 2, true)],
        ],
      },
    ])

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground text-sm print:hidden">
          Todo en {c}, cada venta a la tasa de su día. Las devoluciones y anulaciones restan.
        </p>
        <div className="ml-auto">
          <ExportButtons onExcel={exportXlsx} />
        </div>
      </div>
      <PrintHeader business={business} title="Estado de resultados" period={period} />
      {r.linesWithoutCost > 0 ? (
        <p className="flex items-start gap-2 rounded-md bg-warning/15 px-3 py-2 text-sm">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>
            {r.linesWithoutCost} línea{r.linesWithoutCost === 1 ? "" : "s"} vendida
            {r.linesWithoutCost === 1 ? "" : "s"} sin costo conocido (se vendió antes de comprar el
            producto o es de antes de llevar costos): no restan, así que la utilidad sale más alta
            de lo real.
          </span>
        </p>
      ) : null}
      {costKnown ? null : (
        <p className="rounded-md bg-muted px-3 py-2 text-sm">
          Tu rol no ve los costos: la utilidad no se muestra.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader>
            <CardTitle>Estado de resultados</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <Line
              label="Ventas (con IVA)"
              value={money(r.sales.totalLegalMinor)}
              hint={`${r.sales.count} venta${r.sales.count === 1 ? "" : "s"}`}
            />
            <Line label="− IVA" value={money(-r.sales.taxLegalMinor)} muted indent />
            <Line label="Ventas sin IVA" value={money(r.sales.netLegalMinor)} strong />
            <Line
              label="− Costo de lo vendido"
              value={money(negated(r.costOfGoodsLegalMinor))}
              muted
              indent
            />
            <Line
              label="Utilidad bruta"
              value={money(r.grossProfitLegalMinor)}
              hint={
                r.grossMarginBp !== null ? `Margen ${formatPercent(r.grossMarginBp)}` : undefined
              }
              strong
            />
            <Line label="− Gastos" value={money(-r.expenses.totalLegalMinor)} muted indent />
            <Line
              label="− Pérdidas de inventario"
              value={money(negated(r.inventoryLossLegalMinor))}
              hint="Merma, vencido, uso interno… a costo"
              muted
              indent
            />
            <Line
              label="− Comisiones de bancos y puntos de venta"
              value={money(-r.commissionsLegalMinor)}
              muted
              indent
            />
            <Line
              label="Utilidad neta"
              value={money(r.netProfitLegalMinor)}
              strong
              negative={profitNegative}
            />
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Gastos por categoría</CardTitle>
            </CardHeader>
            <CardContent className="divide-y">
              {r.expenses.byCategory.length ? (
                r.expenses.byCategory.map((e) => (
                  <Line
                    key={e.name}
                    label={e.name}
                    hint={`${e.count} gasto${e.count === 1 ? "" : "s"}`}
                    value={money(e.totalLegalMinor)}
                  />
                ))
              ) : (
                <p className="text-muted-foreground text-sm">Sin gastos en el período.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Informativo</CardTitle>
            </CardHeader>
            <CardContent className="divide-y">
              <Line
                label="Compras de mercancía"
                hint={`${r.purchases.count} compra${r.purchases.count === 1 ? "" : "s"} · son inventario, no un gasto`}
                value={money(r.purchases.totalLegalMinor)}
              />
              <Line
                label="IGTF cobrado"
                hint="No es ingreso del comercio: se declara aparte"
                value={money(r.sales.surchargeLegalMinor)}
              />
              <Line label="Descuentos dados" value={money(r.sales.discountLegalMinor)} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
