import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  NativeSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { SearchIcon } from "lucide-react"
import { useState } from "react"
import { formatMoney, formatQty } from "../../lib/format"
import { useLocations } from "../../lib/locations"
import { inventoryReportQuery } from "../../lib/queries"
import { bold, downloadXlsx, fileName, moneyCell, qtyCell } from "../../lib/xlsx"
import { ExportButtons, PrintHeader } from "./parts"

/** Lo que hay en el inventario hoy, a costo y a precio de venta. No depende del período. */
export function InventoryTab({
  business,
  today,
  branchId,
}: {
  business: string
  today: string
  /** Con sucursales, la elegida (vacío: todas las de quien consulta). */
  branchId: string
}) {
  const all = useLocations()
  const locations = branchId ? (all?.filter((l) => l.branchId === branchId) ?? null) : all
  const [chosen, setLocationId] = useState("")
  // Una ubicación de otra sucursal deja de valer al cambiar de sucursal.
  const locationId = locations?.some((l) => l.id === chosen) ? chosen : ""
  const { data: r, isLoading } = useQuery(inventoryReportQuery(locationId, branchId))
  const where = locations?.find((l) => l.id === locationId)?.name
  const [search, setSearch] = useState("")
  const [lowOnly, setLowOnly] = useState(false)
  if (!r) {
    return <p className="text-muted-foreground text-sm">{isLoading ? "Cargando…" : "Sin datos."}</p>
  }
  const c = r.legalCurrency
  const money = (minor: number | null) => (minor === null ? "—" : formatMoney(minor, c))
  const term = search.trim().toLowerCase()
  const rows = r.rows.filter(
    (p) =>
      (!term || p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term)) &&
      (!lowOnly || p.stockMilli <= (p.minStockMilli ?? 0)),
  )
  const costOf = (p: (typeof r.rows)[number]) =>
    p.costMinor !== null && p.costCurrency ? formatMoney(p.costMinor, p.costCurrency) : "—"

  const exportXlsx = () =>
    downloadXlsx(fileName("inventario", today), [
      {
        name: "Inventario",
        widths: [36, 14, 20, 12, 10, 14, 14, 18, 18],
        rows: [
          [bold(`${business} · Inventario valorado al ${today}${where ? ` · ${where}` : ""}`)],
          [`Valores en ${c}${r.rate ? ` a la tasa ${Number(r.rate)}` : ""}`],
          [],
          [
            bold("Producto"),
            bold("Código"),
            bold("Categoría"),
            bold("Existencia"),
            bold("Mínimo"),
            bold("Costo"),
            bold("Moneda costo"),
            bold(`Valor a costo (${c})`),
            bold(`Valor a precio (${c})`),
          ],
          ...rows.map((p) => [
            p.name,
            p.sku,
            p.category,
            qtyCell(p.stockMilli),
            p.minStockMilli === null ? null : qtyCell(p.minStockMilli),
            moneyCell(p.costMinor),
            p.costCurrency,
            moneyCell(p.valueLegalMinor),
            moneyCell(p.retailLegalMinor),
          ]),
          [
            bold("Total"),
            null,
            null,
            null,
            null,
            null,
            null,
            moneyCell(r.totalValueLegalMinor, 2, true),
            moneyCell(r.totalRetailLegalMinor, 2, true),
          ],
        ],
      },
    ])

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72 print:hidden">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar producto"
            aria-label="Buscar producto"
            className="pl-9"
          />
        </div>
        {locations ? (
          <NativeSelect
            aria-label="Ubicación"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="w-full sm:w-48 print:hidden"
          >
            <option value="">Todas las ubicaciones</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </NativeSelect>
        ) : null}
        <label className="flex items-center gap-2 text-sm print:hidden">
          <input
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={lowOnly}
            onChange={(e) => setLowOnly(e.target.checked)}
          />
          Solo por reponer
        </label>
        <div className="ml-auto">
          <ExportButtons onExcel={exportXlsx} />
        </div>
      </div>
      <PrintHeader
        business={business}
        title={where ? `Inventario valorado · ${where}` : "Inventario valorado"}
        period={`al ${today}`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <CardHeader className="p-4">
            <CardDescription>Vale a costo</CardDescription>
            <CardTitle className="tabular text-xl">{money(r.totalValueLegalMinor)}</CardTitle>
            {r.totalValueLegalMinor === null ? (
              <p className="text-muted-foreground text-xs">Tu rol no ve los costos</p>
            ) : null}
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="p-4">
            <CardDescription>Vale a precio de venta</CardDescription>
            <CardTitle className="tabular text-xl">{money(r.totalRetailLegalMinor)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="p-4">
            <CardDescription>Productos</CardDescription>
            <CardTitle className="tabular text-xl">{r.rows.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="p-4">
            <CardDescription>Sin costo conocido</CardDescription>
            <CardTitle className="tabular text-xl">{r.withoutCost}</CardTitle>
            <p className="text-muted-foreground text-xs">No suman en lo que vale a costo</p>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Producto</TableHead>
                <TableHead className="text-right">Existencia</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Costo</TableHead>
                <TableHead className="text-right">A costo</TableHead>
                <TableHead className="hidden text-right md:table-cell">A precio</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    {isLoading ? "Cargando…" : "No hay productos con ese filtro."}
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((p) => (
                <TableRow key={p.variantId}>
                  <TableCell className="whitespace-normal font-medium">
                    {p.name}
                    <span className="block font-normal text-muted-foreground text-xs">
                      {[p.sku, p.category].filter(Boolean).join(" · ")}
                    </span>
                  </TableCell>
                  <TableCell
                    className={`tabular text-right ${p.stockMilli <= (p.minStockMilli ?? 0) ? "font-medium text-destructive" : ""}`}
                  >
                    {formatQty(p.stockMilli)}
                  </TableCell>
                  <TableCell className="tabular hidden text-right sm:table-cell">
                    {costOf(p)}
                  </TableCell>
                  <TableCell className="tabular text-right">{money(p.valueLegalMinor)}</TableCell>
                  <TableCell className="tabular hidden text-right md:table-cell">
                    {money(p.retailLegalMinor)}
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
