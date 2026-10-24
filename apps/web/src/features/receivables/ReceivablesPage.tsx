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
import { BookOpenIcon, HandCoinsIcon, PlusIcon, SearchIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { AgingBar } from "../../components/AgingBar"
import { formatDateTime, formatMoney } from "../../lib/format"
import { bootstrapQuery, rateStatusQuery, receivablesQuery } from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { ReceiptDialog } from "../sales/ReceiptDialog"
import { CollectDialog } from "./CollectDialog"
import { DebtDialog } from "./DebtDialog"
import { StatementDialog } from "./StatementDialog"

const day = (ms: number) => formatDateTime(ms).split(",")[0]

/** El «cuaderno» del fiado: quién debe, cuánto, desde cuándo, y desde aquí se cobra. */
export function ReceivablesPage() {
  const me = useMe()
  const boot = useQuery(bootstrapQuery)
  const rate = useQuery(rateStatusQuery)
  const owed = useQuery(receivablesQuery)
  const [search, setSearch] = useState("")
  const [statementOf, setStatementOf] = useState<string | null>(null)
  const [collecting, setCollecting] = useState<string | null>(null)
  const [receiptId, setReceiptId] = useState<string | null>(null)
  const [addingDebt, setAddingDebt] = useState(false)
  const canCollect = can(me, "payment.receive")
  const canAddDebt = can(me, "finance.manage")
  const legal = boot.data?.business.legalCurrency
  const reference = boot.data?.business.referenceCurrency
  const factor = rate.data?.current && Number(rate.data.current.value)

  const customers = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (owed.data?.customers ?? []).filter(
      (c) =>
        !term ||
        c.name.toLowerCase().includes(term) ||
        c.taxId?.toLowerCase().includes(term) ||
        c.phone?.includes(term),
    )
  }, [owed.data, search])

  const totals = owed.data?.totals ?? []
  const now = Date.now()

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-xl">Fiado</h1>
        {canAddDebt ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto sm:order-last sm:ml-0"
            onClick={() => setAddingDebt(true)}
          >
            <PlusIcon /> Anotar deuda
          </Button>
        ) : null}
        <div className="relative w-full sm:ml-auto sm:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar cliente"
            className="pl-9"
            aria-label="Buscar cliente"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {totals.length === 0 ? (
          <Card className="col-span-2">
            <CardHeader>
              <CardDescription>Por cobrar</CardDescription>
              <div className="font-semibold text-2xl">
                {owed.isLoading ? "…" : "Nadie te debe nada"}
              </div>
            </CardHeader>
          </Card>
        ) : (
          totals.map((t) => (
            <Card key={t.currency} className="col-span-2 sm:col-span-1">
              <CardHeader className="p-4 pb-1">
                <CardDescription>
                  Por cobrar en {t.currency === "VES" ? "Bs" : t.currency}
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
                  {t.customers} cliente{t.customers === 1 ? "" : "s"}
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
              <TableHead>Cliente</TableHead>
              <TableHead className="text-right">Debe</TableHead>
              <TableHead className="hidden sm:table-cell">Desde</TableHead>
              <TableHead className="hidden md:table-cell">Vence</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  {owed.isLoading
                    ? "Cargando…"
                    : search
                      ? "Nadie coincide con la búsqueda."
                      : "Cuando fíes una venta, o anotes lo que alguien ya te debía, aparecerá aquí."}
                </TableCell>
              </TableRow>
            ) : null}
            {customers.map((c) => (
              <TableRow key={`${c.contactId}-${c.currency}`}>
                <TableCell className="whitespace-normal font-medium">
                  {c.name}
                  {c.overdueMinor > 0 ? (
                    <Badge variant="destructive" className="ml-2">
                      Vencido
                    </Badge>
                  ) : null}
                  <span className="block font-normal text-muted-foreground text-xs">
                    {c.openCount} por cobrar
                    <span className="sm:hidden"> · desde {day(c.oldestPostedAt)}</span>
                  </span>
                </TableCell>
                <TableCell className="tabular text-right font-semibold">
                  {formatMoney(c.outstandingMinor, c.currency)}
                </TableCell>
                <TableCell className="hidden sm:table-cell">{day(c.oldestPostedAt)}</TableCell>
                <TableCell
                  className={`hidden md:table-cell ${c.nextDueAt !== null && c.nextDueAt < now ? "font-medium text-destructive" : ""}`}
                >
                  {c.nextDueAt ? day(c.nextDueAt) : "—"}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Estado de cuenta"
                      title="Estado de cuenta"
                      onClick={() => setStatementOf(c.contactId)}
                    >
                      <BookOpenIcon /> <span className="hidden lg:inline">Cuenta</span>
                    </Button>
                    {canCollect ? (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="Cobrar abono"
                        title="Cobrar abono"
                        onClick={() => setCollecting(c.contactId)}
                      >
                        <HandCoinsIcon /> <span className="hidden sm:inline">Cobrar</span>
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {statementOf ? (
        <StatementDialog
          contactId={statementOf}
          onClose={() => setStatementOf(null)}
          onCollect={() => {
            setCollecting(statementOf)
            setStatementOf(null)
          }}
        />
      ) : null}
      {collecting ? (
        <CollectDialog
          contactId={collecting}
          onClose={() => setCollecting(null)}
          onPosted={(id) => {
            setCollecting(null)
            setReceiptId(id)
          }}
        />
      ) : null}
      {addingDebt ? (
        <DebtDialog
          type="DEBT_IN"
          onClose={() => setAddingDebt(false)}
          onPosted={() => setAddingDebt(false)}
        />
      ) : null}
      <ReceiptDialog documentId={receiptId} onClose={() => setReceiptId(null)} done="Listo" />
    </div>
  )
}
