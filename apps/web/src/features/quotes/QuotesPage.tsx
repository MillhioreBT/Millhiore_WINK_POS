import type { QuoteSummary } from "@millhiore/contracts"
import {
  Badge,
  Card,
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
import { formatDay, formatMoney } from "../../lib/format"
import { bootstrapQuery, quotesQuery } from "../../lib/queries"
import { QuoteDialog } from "./QuoteDialog"
import { isExpired, QUOTE_STATUS } from "./quoteTicket"

const STATUS_VARIANT: Record<QuoteSummary["status"], "secondary" | "outline" | "success"> = {
  open: "secondary",
  converted: "success",
  cancelled: "outline",
}

/** Cotizaciones: las abiertas por vender, las vendidas y las anuladas. */
export function QuotesPage() {
  const { data: boot } = useQuery(bootstrapQuery)
  const [status, setStatus] = useState("open")
  const [search, setSearch] = useState("")
  const quotes = useQuery(quotesQuery({ status, search }))
  const [viewing, setViewing] = useState<string | null>(null)
  const legal = boot?.business.legalCurrency ?? "VES"
  const ref = boot?.business.referenceCurrency ?? "USD"
  const rows = quotes.data ?? []

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-xl">Cotizaciones</h1>
        <div className="relative ml-auto w-full sm:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por número o cliente"
            className="pl-9"
            aria-label="Buscar cotizaciones"
          />
        </div>
        <NativeSelect
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-40"
          aria-label="Estado"
        >
          <option value="open">Abiertas</option>
          <option value="converted">Vendidas</option>
          <option value="cancelled">Anuladas</option>
          <option value="">Todas</option>
        </NativeSelect>
      </div>
      <p className="text-muted-foreground text-sm">
        Se hacen desde la caja con «Cotizar». Al venderla, sus precios se respetan y queda ligada a
        la venta.
      </p>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Cotización</TableHead>
              <TableHead className="hidden md:table-cell">Fecha</TableHead>
              <TableHead className="hidden sm:table-cell">Vence</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="hidden sm:table-cell">Estado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  {quotes.isLoading ? "Cargando…" : "No hay cotizaciones que mostrar."}
                </TableCell>
              </TableRow>
            ) : null}
            {rows.map((q) => {
              const expired = isExpired(q)
              return (
                <TableRow
                  key={q.id}
                  className="cursor-pointer"
                  onClick={() => setViewing(q.id)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && setViewing(q.id)}
                >
                  <TableCell className="whitespace-normal">
                    <span className="font-medium">{q.number}</span>
                    <span className="block text-muted-foreground text-xs">
                      {q.contactName ?? "Sin cliente"} ·{" "}
                      {q.lineCount === 1 ? "1 producto" : `${q.lineCount} productos`}
                    </span>
                    <span className="text-xs sm:hidden">
                      {QUOTE_STATUS[q.status]}
                      {expired ? " · vencida" : ""}
                    </span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{formatDay(q.createdAt)}</TableCell>
                  <TableCell
                    className={`hidden sm:table-cell ${expired ? "text-destructive" : ""}`}
                  >
                    {formatDay(q.validUntil)}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {q.totalRefMinor !== null
                      ? formatMoney(q.totalRefMinor, ref)
                      : formatMoney(q.totalLegalMinor, legal)}
                    {q.totalRefMinor !== null ? (
                      <span className="block text-muted-foreground text-xs">
                        {formatMoney(q.totalLegalMinor, legal)} al cotizar
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge variant={expired ? "warning" : STATUS_VARIANT[q.status]}>
                      {expired ? "Vencida" : QUOTE_STATUS[q.status]}
                    </Badge>
                    {q.documentNumber ? (
                      <span className="block text-muted-foreground text-xs">
                        {q.documentNumber}
                      </span>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>
      {viewing ? <QuoteDialog quoteId={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  )
}
