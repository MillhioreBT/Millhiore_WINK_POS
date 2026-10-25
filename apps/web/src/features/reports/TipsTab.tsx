import {
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { formatMoney } from "../../lib/format"
import { tipsReportQuery } from "../../lib/queries"
import { bold, type Cell, downloadXlsx, fileName, moneyCell } from "../../lib/xlsx"
import { ExportButtons, PrintHeader } from "./parts"

/**
 * Propinas del período por quien las recibe (o el equipo), netas de anulaciones: lo que se le
 * entrega a cada mesonero. En bolívares y en divisas a la tasa de cada venta.
 */
export function TipsTab({
  bounds,
  period,
  business,
}: {
  bounds: { from: number; to: number }
  period: string
  business: string
}) {
  const { data: r, isLoading } = useQuery(tipsReportQuery(bounds))
  const legal = r?.legalCurrency ?? "VES"
  const ref = r?.referenceCurrency ?? "USD"

  const exportXlsx = async () => {
    if (!r) return
    const rows: Cell[][] = [
      [bold("Para"), bold("Ventas"), bold(`Propinas (${legal})`), bold(`Propinas (${ref})`)],
      ...r.rows.map((x): Cell[] => [
        x.name,
        x.count,
        moneyCell(x.totalLegalMinor),
        x.totalReferenceMinor === null ? "" : moneyCell(x.totalReferenceMinor),
      ]),
      [
        bold("Total"),
        "",
        moneyCell(r.totalLegalMinor),
        r.totalReferenceMinor === null ? "" : moneyCell(r.totalReferenceMinor),
      ],
    ]
    await downloadXlsx(fileName("propinas", period), [
      { name: "Propinas", widths: [28, 10, 18, 18], rows },
    ])
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <p className="mr-auto text-muted-foreground text-sm">
          Lo que dejaron los clientes, por quien lo recibe. No es venta: está en lo cobrado y se
          entrega con un retiro de caja.
        </p>
        <ExportButtons onExcel={exportXlsx} disabled={!r?.rows.length} />
      </div>
      <PrintHeader business={business} title="Propinas" period={period} />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Para</TableHead>
                <TableHead className="text-right">Ventas</TableHead>
                <TableHead className="text-right">Propinas</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r?.rows.length ? null : (
                <TableRow>
                  <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                    {isLoading ? "Cargando…" : "No hubo propinas en este período."}
                  </TableCell>
                </TableRow>
              )}
              {(r?.rows ?? []).map((x) => (
                <TableRow key={x.userId ?? "equipo"}>
                  <TableCell className="font-medium">{x.name}</TableCell>
                  <TableCell className="tabular text-right">{x.count}</TableCell>
                  <TableCell className="tabular text-right">
                    {formatMoney(x.totalLegalMinor, legal)}
                    {x.totalReferenceMinor !== null ? (
                      <span className="block text-muted-foreground text-xs">
                        {formatMoney(x.totalReferenceMinor, ref)}
                      </span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
              {r?.rows.length ? (
                <TableRow className="font-semibold">
                  <TableCell>Total</TableCell>
                  <TableCell />
                  <TableCell className="tabular text-right">
                    {formatMoney(r.totalLegalMinor, legal)}
                    {r.totalReferenceMinor !== null ? (
                      <span className="block font-normal text-muted-foreground text-xs">
                        {formatMoney(r.totalReferenceMinor, ref)}
                      </span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
