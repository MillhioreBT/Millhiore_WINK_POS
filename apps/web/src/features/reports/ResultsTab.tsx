import { Card, CardContent, CardHeader, CardTitle } from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { TriangleAlertIcon } from "lucide-react"
import { formatMoney, formatPercent } from "../../lib/format"
import { resultsReportQuery } from "../../lib/queries"
import { bold, downloadXlsx, fileName, moneyCell, percentCell } from "../../lib/xlsx"
import { changeBp } from "./compare"
import { type Comparison, Delta, ExportButtons, Line, PrintHeader } from "./parts"

/** Cuánto ganó el negocio en el período: ventas, costo, gastos, pérdidas y comisiones. */
export function ResultsTab({
  bounds,
  period,
  business,
  compare,
}: {
  bounds: { from: number; to: number }
  period: string
  business: string
  compare: Comparison
}) {
  const { data: r, isLoading } = useQuery(resultsReportQuery(bounds))
  const { data: p } = useQuery(resultsReportQuery(compare.bounds))
  if (!r) {
    return <p className="text-muted-foreground text-sm">{isLoading ? "Cargando…" : "Sin datos."}</p>
  }
  const c = r.legalCurrency
  const money = (minor: number | null) => (minor === null ? "—" : formatMoney(minor, c))
  // Sin «-0,00»: negar un cero deja un cero.
  const negated = (minor: number | null) => (minor === null || minor === 0 ? minor : -minor)
  const costKnown = r.costOfGoodsLegalMinor !== null
  const profitNegative = (r.netProfitLegalMinor ?? 0) < 0
  const delta = (current: number | null, previous: number | null | undefined, upIsGood = true) => (
    <Delta current={current} previous={previous} upIsGood={upIsGood} format={(v) => money(v)} />
  )
  // En el Excel: lo de antes y cuánto cambió, al lado de cada concepto.
  const before = (current: number | null, previous: number | null | undefined, strong = false) => {
    if (previous === undefined) return []
    const bp = current === null || previous === null ? null : changeBp(current, previous)
    return [moneyCell(previous, 2, strong), percentCell(bp)]
  }

  const exportXlsx = () =>
    downloadXlsx(fileName("resultados", period), [
      {
        name: "Resultados",
        widths: [44, 18, 18, 12],
        rows: [
          [bold(`${business} · Estado de resultados`)],
          [`Período: ${period}`],
          [`Comparado con: ${compare.period} (${compare.label})`],
          [`Moneda: ${c}`],
          [],
          ["", bold("Período"), bold("Anterior"), bold("Cambio")],
          [
            "Ventas (con IVA)",
            moneyCell(r.sales.totalLegalMinor),
            ...before(r.sales.totalLegalMinor, p?.sales.totalLegalMinor),
          ],
          [
            "IVA",
            moneyCell(negated(r.sales.taxLegalMinor)),
            ...before(negated(r.sales.taxLegalMinor), p && negated(p.sales.taxLegalMinor)),
          ],
          [
            bold("Ventas sin IVA"),
            moneyCell(r.sales.netLegalMinor, 2, true),
            ...before(r.sales.netLegalMinor, p?.sales.netLegalMinor, true),
          ],
          [
            "Costo de lo vendido",
            moneyCell(negated(r.costOfGoodsLegalMinor)),
            ...before(negated(r.costOfGoodsLegalMinor), p && negated(p.costOfGoodsLegalMinor)),
          ],
          [
            bold("Utilidad bruta"),
            moneyCell(r.grossProfitLegalMinor, 2, true),
            ...before(r.grossProfitLegalMinor, p?.grossProfitLegalMinor, true),
          ],
          [
            "Margen bruto",
            percentCell(r.grossMarginBp),
            ...(p ? [percentCell(p.grossMarginBp)] : []),
          ],
          [
            "Gastos",
            moneyCell(negated(r.expenses.totalLegalMinor)),
            ...before(
              negated(r.expenses.totalLegalMinor),
              p && negated(p.expenses.totalLegalMinor),
            ),
          ],
          [
            "Pérdidas de inventario",
            moneyCell(negated(r.inventoryLossLegalMinor)),
            ...before(negated(r.inventoryLossLegalMinor), p && negated(p.inventoryLossLegalMinor)),
          ],
          [
            "Comisiones de bancos y puntos de venta",
            moneyCell(negated(r.commissionsLegalMinor)),
            ...before(negated(r.commissionsLegalMinor), p && negated(p.commissionsLegalMinor)),
          ],
          [
            bold("Utilidad neta"),
            moneyCell(r.netProfitLegalMinor, 2, true),
            ...before(r.netProfitLegalMinor, p?.netProfitLegalMinor, true),
          ],
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
          Todo en {c}, cada venta a la tasa de su día. Las devoluciones y anulaciones restan. Las
          flechas comparan con {compare.label} ({compare.period}).
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
              delta={delta(r.sales.totalLegalMinor, p?.sales.totalLegalMinor)}
            />
            <Line label="− IVA" value={money(negated(r.sales.taxLegalMinor))} muted indent />
            <Line
              label="Ventas sin IVA"
              value={money(r.sales.netLegalMinor)}
              strong
              delta={delta(r.sales.netLegalMinor, p?.sales.netLegalMinor)}
            />
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
              delta={delta(r.grossProfitLegalMinor, p?.grossProfitLegalMinor)}
            />
            <Line
              label="− Gastos"
              value={money(negated(r.expenses.totalLegalMinor))}
              muted
              indent
              delta={delta(r.expenses.totalLegalMinor, p?.expenses.totalLegalMinor, false)}
            />
            <Line
              label="− Pérdidas de inventario"
              value={money(negated(r.inventoryLossLegalMinor))}
              hint="Merma, vencido, uso interno… a costo"
              muted
              indent
              delta={delta(r.inventoryLossLegalMinor, p?.inventoryLossLegalMinor, false)}
            />
            <Line
              label="− Comisiones de bancos y puntos de venta"
              value={money(negated(r.commissionsLegalMinor))}
              muted
              indent
            />
            <Line
              label="Utilidad neta"
              value={money(r.netProfitLegalMinor)}
              strong
              negative={profitNegative}
              delta={delta(r.netProfitLegalMinor, p?.netProfitLegalMinor)}
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
