import type { DocumentSummary } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  NativeSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { ListIcon, PlusIcon } from "lucide-react"
import { useState } from "react"
import { dayRange, daysBefore, todayInCaracas } from "../../lib/days"
import { formatDateTime, formatMoney } from "../../lib/format"
import {
  bootstrapQuery,
  expenseCategoriesQuery,
  expensesQuery,
  payablesQuery,
  rateStatusQuery,
  recurringQuery,
} from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { ReceiptDialog } from "../sales/ReceiptDialog"
import { DocumentDialog } from "../sales/SalesPage"
import { ExpenseCategoriesDialog } from "./ExpenseCategoriesDialog"
import { ExpenseDialog } from "./ExpenseDialog"
import { RecurringTab } from "./RecurringTab"

const PRESETS = [
  { id: "today", label: "Hoy" },
  { id: "week", label: "7 días" },
  { id: "month", label: "Este mes" },
] as const

function presetRange(id: (typeof PRESETS)[number]["id"], today: string) {
  if (id === "today") return { from: today, to: today }
  if (id === "week") return { from: daysBefore(today, 6), to: today }
  return { from: `${today.slice(0, 7)}-01`, to: today }
}

/** En qué se va el dinero del negocio: alquiler, servicios, sueldos… por período y categoría. */
export function ExpensesPage() {
  const me = useMe()
  const boot = useQuery(bootstrapQuery)
  const rate = useQuery(rateStatusQuery)
  const categories = useQuery(expenseCategoriesQuery({ all: true }))
  const today = todayInCaracas()
  const [range, setRange] = useState(() => presetRange("month", today))
  const [categoryId, setCategoryId] = useState("")
  const [creating, setCreating] = useState(false)
  const [managing, setManaging] = useState(false)
  const [open, setOpen] = useState<DocumentSummary | null>(null)
  const [receiptId, setReceiptId] = useState<string | null>(null)
  const bounds = { from: dayRange(range.from).from, to: dayRange(range.to).to }
  const expenses = useQuery({
    ...expensesQuery({ ...bounds, categoryId }),
    enabled: range.from <= range.to,
  })

  const data = expenses.data
  // Los recurrentes que esperan que alguien los registre (o que no se pudieron registrar solos).
  const recurring = useQuery(recurringQuery)
  const waiting = (recurring.data ?? []).filter((r) => r.due && (!r.auto || r.lastError)).length
  // Lo que todavía se le debe al proveedor de cada gasto a deber (si se puede ver).
  const owing = useQuery({
    ...payablesQuery,
    enabled: can(me, "payable.manage", "finance.view", "report.view"),
  })
  const stillOwed = new Map(
    (owing.data?.suppliers ?? []).flatMap((s) => s.open.map((o) => [o.id, o] as const)),
  )
  const legal = data?.legalCurrency ?? boot.data?.business.legalCurrency ?? "VES"
  const reference = boot.data?.business.referenceCurrency
  const current = rate.data?.current
  const factor = current && current.quote === legal ? Number(current.value) : null
  const biggest = Math.max(1, ...(data?.byCategory ?? []).map((c) => c.totalLegalMinor))
  const preset = PRESETS.find((p) => {
    const r = presetRange(p.id, today)
    return r.from === range.from && r.to === range.to
  })

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-xl">Gastos</h1>
        <div className="ml-auto flex flex-wrap gap-2">
          {can(me, "finance.manage") ? (
            <Button variant="outline" onClick={() => setManaging(true)}>
              <ListIcon /> Categorías
            </Button>
          ) : null}
          {can(me, "expense.create") ? (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon /> Nuevo gasto
            </Button>
          ) : null}
        </div>
      </div>

      <Tabs defaultValue="gastos">
        <TabsList>
          <TabsTrigger value="gastos">Gastos</TabsTrigger>
          <TabsTrigger value="recurrentes">
            Recurrentes
            {waiting > 0 ? (
              <Badge variant="warning" className="ml-2">
                {waiting}
              </Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="recurrentes">
          <RecurringTab onPosted={setReceiptId} />
        </TabsContent>
        <TabsContent value="gastos" className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[auto_auto_1fr]">
            <Field label="Desde" htmlFor="exp-from">
              <Input
                id="exp-from"
                type="date"
                value={range.from}
                max={range.to}
                onChange={(e) =>
                  e.target.value && setRange((r) => ({ ...r, from: e.target.value }))
                }
              />
            </Field>
            <Field label="Hasta" htmlFor="exp-to">
              <Input
                id="exp-to"
                type="date"
                value={range.to}
                min={range.from}
                max={today}
                onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))}
              />
            </Field>
            <Field label="Categoría" htmlFor="exp-filter" className="col-span-2 sm:col-span-1">
              <NativeSelect
                id="exp-filter"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">Todas</option>
                {(categories.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.active ? "" : " (inactiva)"}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={preset?.id === p.id ? "default" : "outline"}
                onClick={() => setRange(presetRange(p.id, today))}
              >
                {p.label}
              </Button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_2fr]">
            <Card>
              <CardHeader>
                <CardDescription>Total gastado (neto de anulaciones)</CardDescription>
                <CardTitle className="tabular text-2xl">
                  {formatMoney(data?.totalLegalMinor ?? 0, legal)}
                </CardTitle>
                {factor && reference && reference !== legal && data ? (
                  <p className="tabular text-muted-foreground text-sm">
                    ≈ {formatMoney(Math.round(data.totalLegalMinor / factor), reference)} a la tasa
                    de hoy
                  </p>
                ) : null}
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Por categoría</CardTitle>
              </CardHeader>
              <CardContent>
                {data?.byCategory.length ? (
                  <ul className="grid grid-cols-1 gap-3 text-sm">
                    {data.byCategory.map((c) => (
                      <li key={c.categoryId ?? "sin"} className="grid grid-cols-1 gap-1">
                        <span className="flex justify-between gap-3">
                          <span className="min-w-0 truncate">
                            {c.name}{" "}
                            <span className="text-muted-foreground text-xs">
                              ({c.count} gasto{c.count === 1 ? "" : "s"})
                            </span>
                          </span>
                          <span className="tabular shrink-0 font-medium">
                            {formatMoney(c.totalLegalMinor, legal)}
                          </span>
                        </span>
                        <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <span
                            className="block h-full rounded-full bg-primary"
                            style={{
                              width: `${Math.max(2, (c.totalLegalMinor / biggest) * 100)}%`,
                            }}
                          />
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    {expenses.isLoading ? "Cargando…" : "No hay gastos en este período."}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Número</TableHead>
                    <TableHead className="hidden sm:table-cell">Fecha</TableHead>
                    <TableHead>Gasto</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="hidden sm:table-cell">Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.rows.length ? null : (
                    <TableRow>
                      <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                        {expenses.isLoading ? "Cargando…" : "No hay gastos con ese filtro."}
                      </TableCell>
                    </TableRow>
                  )}
                  {(data?.rows ?? []).map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="whitespace-nowrap font-medium">
                        <button
                          type="button"
                          className="cursor-pointer text-primary underline-offset-4 hover:underline"
                          onClick={() => setOpen(d)}
                        >
                          {d.number}
                        </button>
                        <span className="block font-normal text-muted-foreground text-xs sm:hidden">
                          {formatDateTime(d.postedAt)}
                        </span>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap sm:table-cell">
                        {formatDateTime(d.postedAt)}
                      </TableCell>
                      <TableCell className="min-w-0 text-sm">
                        <span className="font-medium">{d.note || d.expenseCategoryName}</span>
                        <span className="block text-muted-foreground text-xs">
                          {[
                            d.expenseCategoryName,
                            d.contactName,
                            d.externalRef && `Fact. ${d.externalRef}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        {d.reversedBy || d.reversesDocumentId ? (
                          <Badge
                            variant={d.reversedBy ? "destructive" : "outline"}
                            className="mt-1 sm:hidden"
                          >
                            {d.reversedBy ? "Anulado" : "Reverso"}
                          </Badge>
                        ) : d.creditMinor > 0 ? (
                          <Badge
                            variant={stillOwed.has(d.id) ? "warning" : "success"}
                            className="mt-1 sm:hidden"
                          >
                            {stillOwed.has(d.id) ? "A deber" : "Pagado"}
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {formatMoney(d.totalMinor, d.currency)}
                        {d.currency !== d.legalCurrency ? (
                          <span className="block text-muted-foreground text-xs">
                            {formatMoney(d.totalLegalMinor, d.legalCurrency)}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {d.reversedBy ? (
                          <Badge variant="destructive">Anulado</Badge>
                        ) : d.reversesDocumentId ? (
                          <Badge variant="outline">Reverso</Badge>
                        ) : d.creditMinor > 0 ? (
                          stillOwed.has(d.id) ? (
                            <Badge variant="warning">
                              Debes{" "}
                              {formatMoney(
                                stillOwed.get(d.id)?.outstandingMinor ?? 0,
                                d.creditCurrency ?? d.currency,
                              )}
                            </Badge>
                          ) : (
                            <Badge variant="success">Pagado</Badge>
                          )
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {open ? <DocumentDialog doc={open} onClose={() => setOpen(null)} /> : null}
      {creating ? (
        <ExpenseDialog
          onClose={() => setCreating(false)}
          onPosted={(id) => {
            setCreating(false)
            setReceiptId(id)
          }}
        />
      ) : null}
      {managing ? (
        <ExpenseCategoriesDialog
          onClose={() => setManaging(false)}
          canManage={can(me, "finance.manage")}
        />
      ) : null}
      <ReceiptDialog documentId={receiptId} done="Listo" onClose={() => setReceiptId(null)} />
    </div>
  )
}
