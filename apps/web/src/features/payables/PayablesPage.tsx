import type { DocumentSummary } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { HandCoinsIcon, SearchIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { AgingBar } from "../../components/AgingBar"
import { formatDateTime, formatMoney } from "../../lib/format"
import { bootstrapQuery, documentsQuery, payablesQuery, rateStatusQuery } from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { ReceiptDialog } from "../sales/ReceiptDialog"
import { DocumentDialog } from "../sales/SalesPage"
import { PayDialog } from "./PayDialog"

const day = (ms: number) => formatDateTime(ms).split(",")[0]

/** Lo que el negocio le debe a sus proveedores: a quién, cuánto, desde cuándo, y desde aquí se paga. */
export function PayablesPage() {
  const me = useMe()
  const boot = useQuery(bootstrapQuery)
  const rate = useQuery(rateStatusQuery)
  const owing = useQuery(payablesQuery)
  const [search, setSearch] = useState("")
  const [paying, setPaying] = useState<string | null>(null)
  const [receiptId, setReceiptId] = useState<string | null>(null)
  const [open, setOpen] = useState<DocumentSummary | null>(null)
  // Los pagos de los últimos 60 días, por si hay que ver el comprobante o anular uno equivocado.
  // La fecha se fija una vez: si cambiara en cada render, la consulta se repetiría sin parar.
  const [since] = useState(() => Date.now() - 60 * 86_400_000)
  const recent = useQuery({
    ...documentsQuery({ type: "PAYMENT_OUT", from: since }),
    enabled: can(me, "payable.manage", "report.view"),
  })
  const canPay = can(me, "payable.manage")
  const legal = boot.data?.business.legalCurrency
  const reference = boot.data?.business.referenceCurrency
  const factor = rate.data?.current && Number(rate.data.current.value)

  const suppliers = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (owing.data?.suppliers ?? []).filter(
      (s) =>
        !term ||
        s.name.toLowerCase().includes(term) ||
        s.taxId?.toLowerCase().includes(term) ||
        s.phone?.includes(term),
    )
  }, [owing.data, search])

  const totals = owing.data?.totals ?? []
  const now = Date.now()

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-xl">Por pagar</h1>
        <div className="relative ml-auto w-full sm:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar proveedor"
            className="pl-9"
            aria-label="Buscar proveedor"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {totals.length === 0 ? (
          <Card className="col-span-2">
            <CardHeader>
              <CardDescription>Por pagar</CardDescription>
              <div className="font-semibold text-2xl">
                {owing.isLoading ? "…" : "No le debes nada a nadie"}
              </div>
            </CardHeader>
          </Card>
        ) : (
          totals.map((t) => (
            <Card key={t.currency} className="col-span-2 sm:col-span-1">
              <CardHeader className="p-4 pb-1">
                <CardDescription>
                  Por pagar en {t.currency === "VES" ? "Bs" : t.currency}
                </CardDescription>
                <div className="tabular font-semibold text-2xl">
                  {formatMoney(t.outstandingMinor, t.currency)}
                </div>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-3 p-4 pt-0 text-muted-foreground text-sm">
                <span>
                  {factor && legal && reference && t.currency === reference ? (
                    <span className="tabular block">
                      ≈ {formatMoney(Math.round(t.outstandingMinor * factor), legal)}
                    </span>
                  ) : null}
                  {t.suppliers} proveedor{t.suppliers === 1 ? "" : "es"}
                  {t.overdueMinor > 0 ? (
                    <span className="ml-2 font-medium text-destructive">
                      · {formatMoney(t.overdueMinor, t.currency)} vencido
                    </span>
                  ) : null}
                </span>
                <AgingBar aging={t.aging} currency={t.currency} />
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Proveedor</TableHead>
              <TableHead className="text-right">Se le debe</TableHead>
              <TableHead className="hidden sm:table-cell">Desde</TableHead>
              <TableHead className="hidden md:table-cell">Vence</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {suppliers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  {owing.isLoading
                    ? "Cargando…"
                    : search
                      ? "Nadie coincide con la búsqueda."
                      : "Cuando dejes a deber una compra o un gasto aparecerá aquí."}
                </TableCell>
              </TableRow>
            ) : null}
            {suppliers.map((s) => (
              <TableRow key={`${s.contactId}-${s.currency}`}>
                <TableCell className="whitespace-normal font-medium">
                  {s.name}
                  {s.overdueMinor > 0 ? (
                    <Badge variant="destructive" className="ml-2">
                      Vencido
                    </Badge>
                  ) : null}
                  <span className="block font-normal text-muted-foreground text-xs">
                    {s.openCount} factura{s.openCount === 1 ? "" : "s"}
                    <span className="sm:hidden"> · desde {day(s.oldestPostedAt)}</span>
                  </span>
                </TableCell>
                <TableCell className="tabular text-right font-semibold">
                  {formatMoney(s.outstandingMinor, s.currency)}
                </TableCell>
                <TableCell className="hidden sm:table-cell">{day(s.oldestPostedAt)}</TableCell>
                <TableCell
                  className={`hidden md:table-cell ${s.nextDueAt !== null && s.nextDueAt < now ? "font-medium text-destructive" : ""}`}
                >
                  {s.nextDueAt ? day(s.nextDueAt) : "—"}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {canPay ? (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Pagar a ${s.name}`}
                        title="Pagar"
                        onClick={() => setPaying(s.contactId)}
                      >
                        <HandCoinsIcon /> <span className="hidden sm:inline">Pagar</span>
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {recent.data?.length ? (
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardDescription>Pagos recientes a proveedores</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableBody>
                {recent.data.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="whitespace-nowrap font-medium">
                      <button
                        type="button"
                        className="cursor-pointer text-primary underline-offset-4 hover:underline"
                        onClick={() => setOpen(d)}
                      >
                        {d.number}
                      </button>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {d.contactName ?? "—"}
                      <span className="block text-muted-foreground text-xs">
                        {formatDateTime(d.postedAt)}
                      </span>
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {formatMoney(d.totalMinor, d.currency)}
                    </TableCell>
                    <TableCell className="w-0">
                      {d.reversedBy ? (
                        <Badge variant="destructive">Anulado</Badge>
                      ) : d.reversesDocumentId ? (
                        <Badge variant="outline">Reverso</Badge>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {open ? <DocumentDialog doc={open} onClose={() => setOpen(null)} /> : null}
      {paying ? (
        <PayDialog
          contactId={paying}
          onClose={() => setPaying(null)}
          onPosted={(id) => {
            setPaying(null)
            setReceiptId(id)
          }}
        />
      ) : null}
      <ReceiptDialog documentId={receiptId} onClose={() => setReceiptId(null)} done="Listo" />
    </div>
  )
}
