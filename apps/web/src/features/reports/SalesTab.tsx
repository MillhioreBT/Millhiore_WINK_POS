import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { formatMoney, formatQty } from "../../lib/format"
import { salesReportQuery } from "../../lib/queries"
import { bold, downloadXlsx, fileName, moneyCell, qtyCell } from "../../lib/xlsx"
import { ExportButtons, PrintHeader } from "./parts"

const day = (date: string) => date.split("-").reverse().join("/")

/** Las ventas del período por día, producto (con utilidad), método de pago y vendedor. */
export function SalesTab({
  bounds,
  period,
  business,
}: {
  bounds: { from: number; to: number }
  period: string
  business: string
}) {
  const { data: r, isLoading } = useQuery(salesReportQuery(bounds))
  if (!r) {
    return <p className="text-muted-foreground text-sm">{isLoading ? "Cargando…" : "Sin datos."}</p>
  }
  const c = r.legalCurrency
  const money = (minor: number | null) => (minor === null ? "—" : formatMoney(minor, c))
  const biggestDay = Math.max(1, ...r.byDay.map((d) => d.totalLegalMinor))

  const exportXlsx = () =>
    downloadXlsx(fileName("ventas", period), [
      {
        name: "Resumen",
        widths: [34, 18],
        rows: [
          [bold(`${business} · Ventas`)],
          [`Período: ${period}`],
          [`Moneda: ${c}`],
          [],
          ["Ventas", r.totals.count],
          ["Total con IVA", moneyCell(r.totals.totalLegalMinor)],
          ["IVA", moneyCell(r.totals.taxLegalMinor)],
          ["Ventas sin IVA", moneyCell(r.totals.netLegalMinor)],
          ["Promedio por venta", moneyCell(r.totals.averageLegalMinor)],
          ["Descuentos dados", moneyCell(r.totals.discountLegalMinor)],
          ["Devoluciones", moneyCell(r.totals.returnsLegalMinor)],
        ],
      },
      {
        name: "Por día",
        widths: [14, 10, 18],
        rows: [
          [bold("Día"), bold("Ventas"), bold(`Total (${c})`)],
          ...r.byDay.map((d) => [day(d.date), d.count, moneyCell(d.totalLegalMinor)]),
        ],
      },
      {
        name: "Por producto",
        widths: [36, 14, 12, 18, 18, 18],
        rows: [
          [
            bold("Producto"),
            bold("Código"),
            bold("Cantidad"),
            bold(`Vendido (${c})`),
            bold(`Costo (${c})`),
            bold(`Utilidad (${c})`),
          ],
          ...r.byProduct.map((p) => [
            p.name,
            p.sku,
            qtyCell(p.qtyMilli),
            moneyCell(p.totalLegalMinor),
            moneyCell(p.costLegalMinor),
            moneyCell(p.profitLegalMinor),
          ]),
        ],
      },
      {
        name: "Por método de pago",
        widths: [28, 10, 18, 18],
        rows: [
          [bold("Método"), bold("Moneda"), bold("Cobrado"), bold("Comisión")],
          ...r.byMethod.map((m) => [
            m.methodName,
            m.currency,
            moneyCell(m.amountMinor),
            moneyCell(m.commissionMinor),
          ]),
        ],
      },
      {
        name: "Por vendedor",
        widths: [30, 10, 18],
        rows: [
          [bold("Vendedor"), bold("Ventas"), bold(`Total (${c})`)],
          ...r.byUser.map((u) => [u.name, u.count, moneyCell(u.totalLegalMinor)]),
        ],
      },
    ])

  const stat = (label: string, value: string, hint?: string) => (
    <Card>
      <CardHeader className="p-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="tabular text-xl">{value}</CardTitle>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </CardHeader>
    </Card>
  )

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
      <PrintHeader business={business} title="Ventas" period={period} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {stat("Ventas", String(r.totals.count))}
        {stat(
          "Total con IVA",
          money(r.totals.totalLegalMinor),
          `IVA ${money(r.totals.taxLegalMinor)}`,
        )}
        {stat("Ventas sin IVA", money(r.totals.netLegalMinor))}
        {stat("Promedio por venta", money(r.totals.averageLegalMinor))}
        {stat(
          "Devoluciones",
          money(r.totals.returnsLegalMinor),
          `Descuentos ${money(r.totals.discountLegalMinor)}`,
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Por día</CardTitle>
          </CardHeader>
          <CardContent>
            {r.byDay.length ? (
              <ul className="grid max-h-96 grid-cols-1 gap-2 overflow-y-auto text-sm print:max-h-none">
                {r.byDay.map((d) => (
                  <li key={d.date} className="grid grid-cols-1 gap-1">
                    <span className="flex justify-between gap-3">
                      <span>
                        {day(d.date)}{" "}
                        <span className="text-muted-foreground text-xs">
                          ({d.count} venta{d.count === 1 ? "" : "s"})
                        </span>
                      </span>
                      <span className="tabular font-medium">{money(d.totalLegalMinor)}</span>
                    </span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${Math.max(2, (d.totalLegalMinor / biggestDay) * 100)}%` }}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">Sin ventas en el período.</p>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Cobrado por método</CardTitle>
              <CardDescription>
                En la moneda de cada método, con la comisión del banco
              </CardDescription>
            </CardHeader>
            <CardContent>
              {r.byMethod.length ? (
                <ul className="grid grid-cols-1 gap-2 text-sm">
                  {r.byMethod.map((m) => (
                    <li
                      key={`${m.methodName}-${m.currency}`}
                      className="flex justify-between gap-3"
                    >
                      <span>
                        {m.methodName}
                        {m.commissionMinor ? (
                          <span className="block text-muted-foreground text-xs">
                            Comisión {formatMoney(m.commissionMinor, m.currency)}
                          </span>
                        ) : null}
                      </span>
                      <span className="tabular font-medium">
                        {formatMoney(m.amountMinor, m.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground text-sm">Nada cobrado.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Por vendedor</CardTitle>
              <CardDescription>Ventas vigentes, sin descontar devoluciones</CardDescription>
            </CardHeader>
            <CardContent>
              {r.byUser.length ? (
                <ul className="grid grid-cols-1 gap-2 text-sm">
                  {r.byUser.map((u) => (
                    <li key={u.name} className="flex justify-between gap-3">
                      <span>
                        {u.name}{" "}
                        <span className="text-muted-foreground text-xs">
                          ({u.count} venta{u.count === 1 ? "" : "s"})
                        </span>
                      </span>
                      <span className="tabular font-medium">{money(u.totalLegalMinor)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground text-sm">Sin ventas.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Por producto</CardTitle>
          <CardDescription>
            La utilidad es lo vendido menos lo que costó la mercancía; sale vacía si el producto no
            tiene costo conocido
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Producto</TableHead>
                <TableHead className="text-right">Cantidad</TableHead>
                <TableHead className="text-right">Vendido</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Utilidad</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.byProduct.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    Sin ventas en el período.
                  </TableCell>
                </TableRow>
              ) : null}
              {r.byProduct.map((p) => (
                <TableRow key={p.variantId}>
                  <TableCell className="whitespace-normal font-medium">
                    {p.name}
                    <span className="block font-normal text-muted-foreground text-xs">{p.sku}</span>
                  </TableCell>
                  <TableCell className="tabular text-right">{formatQty(p.qtyMilli)}</TableCell>
                  <TableCell className="tabular text-right">
                    {money(p.totalLegalMinor)}
                    <span className="block text-muted-foreground text-xs sm:hidden">
                      {p.profitLegalMinor !== null ? `Utilidad ${money(p.profitLegalMinor)}` : ""}
                    </span>
                  </TableCell>
                  <TableCell className="tabular hidden text-right sm:table-cell">
                    {money(p.profitLegalMinor)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
