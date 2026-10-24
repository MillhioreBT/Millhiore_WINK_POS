import type { TaxBook } from "@millhiore/contracts"
import {
  Button,
  Card,
  CardContent,
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
import { useState } from "react"
import { formatDateTime, formatMoney, formatPercent } from "../../lib/format"
import { taxBookQuery } from "../../lib/queries"
import { bold, type Cell, downloadXlsx, fileName, moneyCell } from "../../lib/xlsx"
import { ExportButtons, Line, PrintHeader } from "./parts"

/** En pantalla, los primeros: un año de ventas no cabe; el Excel los trae todos. */
const SHOWN = 300

const KIND_LABEL = { exempt: "Exento", exonerated: "Exonerado", not_subject: "No sujeto" } as const

function rateLabel(r: TaxBook["rates"][number]): string {
  return r.kind === "taxed" ? `Alícuota ${formatPercent(r.rateBp)}` : KIND_LABEL[r.kind]
}

const date = (ms: number) => formatDateTime(ms).split(",")[0] ?? ""

/** Qué es cada renglón: la venta, o qué devuelve o anula. */
function concept(row: TaxBook["rows"][number]): string {
  if (row.voids) return `Anulación de ${row.voids}`
  if (row.type === "RETURN" || row.type === "PURCHASE_RETURN") {
    return row.returns ? `Devolución de ${row.returns}` : "Devolución"
  }
  return row.type === "PURCHASE" ? "Compra" : "Venta"
}

/**
 * Libro de ventas o de compras para el contador: documento por documento, con la base y el IVA
 * de cada alícuota. Informativo (las notas de venta no son facturas fiscales).
 */
export function TaxBookTab({
  bounds,
  period,
  business,
}: {
  bounds: { from: number; to: number }
  period: string
  business: string
}) {
  const [kind, setKind] = useState<"sales" | "purchases">("sales")
  const { data: r, isLoading } = useQuery(taxBookQuery(bounds, kind))
  const sales = kind === "sales"
  const title = sales ? "Libro de ventas" : "Libro de compras"
  const who = sales ? "Cliente" : "Proveedor"

  const exportXlsx = async () => {
    if (!r) return
    const header: Cell[] = [
      bold("Fecha"),
      bold("Documento"),
      bold("Concepto"),
      bold(who),
      bold("Cédula o RIF"),
      ...(sales ? [] : [bold("Factura")]),
      bold(`Total (${r.legalCurrency})`),
      ...r.rates.flatMap((x) =>
        x.kind === "taxed"
          ? [bold(`Base ${formatPercent(x.rateBp)}`), bold(`IVA ${formatPercent(x.rateBp)}`)]
          : [bold(KIND_LABEL[x.kind])],
      ),
      ...(sales ? [bold("IGTF")] : []),
    ]
    const amounts = (row: Pick<TaxBook["rows"][number], "groups" | "surchargeLegalMinor">) => [
      ...r.rates.flatMap((x) => {
        const g = row.groups.find((y) => y.key === x.key)
        return x.kind === "taxed"
          ? [moneyCell(g?.baseLegalMinor ?? 0), moneyCell(g?.taxLegalMinor ?? 0)]
          : [moneyCell(g?.baseLegalMinor ?? 0)]
      }),
      ...(sales ? [moneyCell(row.surchargeLegalMinor)] : []),
    ]
    await downloadXlsx(fileName(sales ? "libro-ventas" : "libro-compras", period), [
      {
        name: title,
        widths: [
          11,
          16,
          26,
          28,
          15,
          ...(sales ? [] : [14]),
          16,
          ...r.rates.flatMap(() => [14, 14]),
        ],
        rows: [
          [bold(`${business} · ${title}`)],
          [`Período: ${period}`],
          ["Informativo: las notas de venta no son facturas fiscales."],
          [],
          header,
          ...r.rows.map((row) => [
            date(row.postedAt),
            row.number,
            concept(row),
            row.contactName ?? (sales ? "Consumidor final" : ""),
            row.contactTaxId ?? "",
            ...(sales ? [] : [row.externalRef ?? ""]),
            moneyCell(row.totalLegalMinor),
            ...amounts(row),
          ]),
          [
            bold("Totales"),
            "",
            "",
            "",
            "",
            ...(sales ? [] : [""]),
            moneyCell(r.totals.totalLegalMinor, 2, true),
            ...amounts(r.totals),
          ],
        ],
      },
    ])
  }

  const money = (minor: number) => formatMoney(minor, r?.legalCurrency ?? "VES")
  // Lo gravado (base e IVA) y lo que no paga IVA (exento, exonerado, no sujeto) de un renglón.
  const taxed = (groups: TaxBook["rows"][number]["groups"]) => {
    const sum = { base: 0, tax: 0, exempt: 0 }
    for (const g of groups) {
      if (g.key.startsWith("taxed:")) {
        sum.base += g.baseLegalMinor
        sum.tax += g.taxLegalMinor
      } else {
        sum.exempt += g.baseLegalMinor
      }
    }
    return sum
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={sales ? "default" : "outline"}
            onClick={() => setKind("sales")}
          >
            Ventas
          </Button>
          <Button
            size="sm"
            variant={sales ? "outline" : "default"}
            onClick={() => setKind("purchases")}
          >
            Compras
          </Button>
        </div>
        <div className="ml-auto">
          <ExportButtons onExcel={exportXlsx} disabled={!r} />
        </div>
      </div>
      <p className="text-muted-foreground text-sm print:hidden">
        Para tu contador, en {r?.legalCurrency ?? "Bs"} a la tasa de cada documento. Es informativo:
        las notas de venta no son facturas fiscales.{" "}
        {sales
          ? "Las devoluciones y anulaciones restan."
          : "Los gastos no entran: se guardan por su total, sin separar el IVA."}
      </p>
      <PrintHeader business={business} title={title} period={period} />

      {!r ? (
        <p className="text-muted-foreground text-sm">{isLoading ? "Cargando…" : "Sin datos."}</p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Resumen</CardTitle>
            </CardHeader>
            <CardContent className="divide-y">
              <Line
                label="Documentos"
                value={String(r.rows.length)}
                hint={sales ? "Ventas, devoluciones y anulaciones" : "Compras y anulaciones"}
              />
              {r.rates.map((x) => {
                const g = r.totals.groups.find((y) => y.key === x.key)
                return (
                  <Line
                    key={x.key}
                    label={rateLabel(x)}
                    value={money(g?.baseLegalMinor ?? 0)}
                    hint={x.kind === "taxed" ? `IVA ${money(g?.taxLegalMinor ?? 0)}` : "Base"}
                  />
                )
              })}
              {sales ? (
                <Line
                  label="IGTF cobrado"
                  value={money(r.totals.surchargeLegalMinor)}
                  hint="Se declara aparte"
                />
              ) : null}
              <Line label="Total" value={money(r.totals.totalLegalMinor)} strong />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Documento</TableHead>
                    <TableHead className="hidden md:table-cell">{who}</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Base</TableHead>
                    <TableHead className="text-right">IVA</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                        Nada en el período.
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {r.rows.slice(0, SHOWN).map((row) => {
                    const t = taxed(row.groups)
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="whitespace-normal">
                          <span className="font-medium">{row.number}</span>
                          <span className="block text-muted-foreground text-xs">
                            {date(row.postedAt)} · {concept(row)}
                            {row.externalRef ? ` · factura ${row.externalRef}` : ""}
                          </span>
                          <span className="block text-muted-foreground text-xs md:hidden">
                            {row.contactName ?? (sales ? "Consumidor final" : "—")}
                          </span>
                        </TableCell>
                        <TableCell className="hidden whitespace-normal md:table-cell">
                          {row.contactName ?? (sales ? "Consumidor final" : "—")}
                          {row.contactTaxId ? (
                            <span className="block text-muted-foreground text-xs">
                              {row.contactTaxId}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="tabular hidden text-right sm:table-cell">
                          {money(t.base)}
                          {t.exempt ? (
                            <span className="block text-muted-foreground text-xs">
                              Exento {money(t.exempt)}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="tabular text-right">
                          {money(t.tax)}
                          <span className="block text-muted-foreground text-xs sm:hidden">
                            Total {money(row.totalLegalMinor)}
                          </span>
                        </TableCell>
                        <TableCell className="tabular hidden text-right sm:table-cell">
                          {money(row.totalLegalMinor)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              {r.rows.length > SHOWN ? (
                <p className="px-4 py-3 text-muted-foreground text-sm">
                  Se muestran los primeros {SHOWN} de {r.rows.length}. El Excel los trae todos.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
