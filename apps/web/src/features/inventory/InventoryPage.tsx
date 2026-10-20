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
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { ListIcon } from "lucide-react"
import { useState } from "react"
import { dayRange, daysBefore, todayInCaracas } from "../../lib/days"
import { formatDateTime, formatMoney, formatQty } from "../../lib/format"
import { documentsQuery, stockAdjustmentsQuery, stockReasonsQuery } from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { DocumentDialog } from "../sales/SalesPage"
import { StockReasonsDialog } from "./StockReasonsDialog"

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

/** Qué mercancía salió o entró sin venta ni compra (merma, vencido, uso interno, conteos) y cuánto vale. */
export function InventoryPage() {
  const me = useMe()
  const reasons = useQuery(stockReasonsQuery({ all: true }))
  const today = todayInCaracas()
  const [range, setRange] = useState(() => presetRange("month", today))
  const [reasonId, setReasonId] = useState("")
  const [managing, setManaging] = useState(false)
  const [open, setOpen] = useState<DocumentSummary | null>(null)
  const bounds = { from: dayRange(range.from).from, to: dayRange(range.to).to }
  const valid = range.from <= range.to
  const data = useQuery({ ...stockAdjustmentsQuery({ ...bounds, reasonId }), enabled: valid }).data
  const summaries = useQuery({
    ...documentsQuery({ type: "ADJUSTMENT", from: bounds.from, to: bounds.to }),
    enabled: valid,
  })
  const legal = data?.legalCurrency ?? "VES"
  const seeCost = data ? data.outLegalMinor !== null : true
  const preset = PRESETS.find((p) => {
    const r = presetRange(p.id, today)
    return r.from === range.from && r.to === range.to
  })

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-xl">Inventario</h1>
        {can(me, "inventory.adjust") ? (
          <Button variant="outline" className="ml-auto" onClick={() => setManaging(true)}>
            <ListIcon /> Motivos
          </Button>
        ) : null}
      </div>
      <p className="-mt-2 text-muted-foreground text-sm">
        Ajustes de existencia: merma, vencido, uso interno, sobrantes y faltantes. Se registran
        desde Productos → Ajustar existencia.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[auto_auto_1fr]">
        <Field label="Desde" htmlFor="inv-from">
          <Input
            id="inv-from"
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))}
          />
        </Field>
        <Field label="Hasta" htmlFor="inv-to">
          <Input
            id="inv-to"
            type="date"
            value={range.to}
            min={range.from}
            max={today}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))}
          />
        </Field>
        <Field label="Motivo" htmlFor="inv-reason" className="col-span-2 sm:col-span-1">
          <NativeSelect
            id="inv-reason"
            value={reasonId}
            onChange={(e) => setReasonId(e.target.value)}
          >
            <option value="">Todos</option>
            {(reasons.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.active ? "" : " (inactivo)"}
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
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
          <Card>
            <CardHeader className="p-4">
              <CardDescription>Salidas (a costo)</CardDescription>
              <CardTitle className="tabular text-2xl">
                {data?.outLegalMinor != null ? formatMoney(data.outLegalMinor, legal) : "—"}
              </CardTitle>
              <p className="text-muted-foreground text-xs">
                {seeCost
                  ? "Lo que costó la mercancía que salió, neto de anulaciones"
                  : "Tu rol no ve los costos"}
              </p>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="p-4">
              <CardDescription>Entradas por ajuste</CardDescription>
              <CardTitle className="tabular text-2xl">
                {data?.inLegalMinor != null ? formatMoney(data.inLegalMinor, legal) : "—"}
              </CardTitle>
              {data?.withoutCost ? (
                <p className="text-muted-foreground text-xs">
                  {data.withoutCost} producto{data.withoutCost === 1 ? "" : "s"} sin costo conocido:
                  no suma{data.withoutCost === 1 ? "" : "n"} en el valor
                </p>
              ) : null}
            </CardHeader>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Por motivo</CardTitle>
          </CardHeader>
          <CardContent>
            {data?.byReason.length ? (
              <ul className="grid grid-cols-1 gap-2 text-sm">
                {data.byReason.map((r) => (
                  <li key={r.reasonId ?? "sin"} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate">
                      {r.reasonName}{" "}
                      <span className="text-muted-foreground text-xs">
                        ({r.count} ajuste{r.count === 1 ? "" : "s"})
                      </span>
                    </span>
                    <span className="tabular shrink-0 font-medium">
                      {r.valueLegalMinor !== null
                        ? formatMoney(Math.abs(r.valueLegalMinor), legal)
                        : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">No hay ajustes en este período.</p>
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
                <TableHead>Producto</TableHead>
                <TableHead className="text-right">Cantidad</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.rows.length ? null : (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                    No hay ajustes con ese filtro.
                  </TableCell>
                </TableRow>
              )}
              {(data?.rows ?? []).map((r) => {
                const summary = summaries.data?.find((d) => d.id === r.id)
                return (
                  <TableRow key={`${r.id}-${r.variantId}`}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {summary ? (
                        <button
                          type="button"
                          className="cursor-pointer text-primary underline-offset-4 hover:underline"
                          onClick={() => setOpen(summary)}
                        >
                          {r.number}
                        </button>
                      ) : (
                        r.number
                      )}
                      <span className="block font-normal text-muted-foreground text-xs">
                        {formatDateTime(r.postedAt)}
                      </span>
                    </TableCell>
                    <TableCell className="min-w-0 whitespace-normal text-sm">
                      <span className="font-medium">{r.productName}</span>
                      <span className="block text-muted-foreground text-xs">
                        {[r.reasonName ?? "Sin motivo", r.note, r.createdBy]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {r.reversedBy ? (
                        <Badge variant="destructive" className="mt-1">
                          Anulado
                        </Badge>
                      ) : r.reversesDocumentId ? (
                        <Badge variant="outline" className="mt-1">
                          Reverso
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell
                      className={`tabular whitespace-nowrap text-right font-medium ${r.qtyMilli < 0 ? "text-destructive" : ""}`}
                    >
                      {r.qtyMilli > 0 ? "+" : ""}
                      {formatQty(r.qtyMilli)}
                      {r.valueLegalMinor !== null ? (
                        <span className="block font-normal text-muted-foreground text-xs sm:hidden">
                          {formatMoney(Math.abs(r.valueLegalMinor), legal)}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular hidden whitespace-nowrap text-right sm:table-cell">
                      {r.valueLegalMinor !== null
                        ? formatMoney(Math.abs(r.valueLegalMinor), legal)
                        : "—"}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {managing ? (
        <StockReasonsDialog
          onClose={() => setManaging(false)}
          canManage={can(me, "inventory.adjust")}
        />
      ) : null}
      {open ? <DocumentDialog doc={open} onClose={() => setOpen(null)} /> : null}
    </div>
  )
}
