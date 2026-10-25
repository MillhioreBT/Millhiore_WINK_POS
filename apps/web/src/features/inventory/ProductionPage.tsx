import type { DocumentSummary } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  CardContent,
  Field,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { PlusIcon } from "lucide-react"
import { useState } from "react"
import { dayRange, todayInCaracas } from "../../lib/days"
import { formatDateTime, formatMoney, formatQty } from "../../lib/format"
import { useLocations } from "../../lib/locations"
import { bootstrapQuery, documentsQuery, productionQuery } from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { useTerminal } from "../../lib/terminal"
import { DocumentDialog } from "../sales/SalesPage"
import { NewProductionDialog } from "./NewProductionDialog"
import { PRESETS, presetRange } from "./period"

/** Lo que se produjo por tandas (salsas, panes, tortas), con lo que costó cada unidad. */
export function ProductionPage() {
  const me = useMe()
  const boot = useQuery(bootstrapQuery)
  const locations = useLocations()
  const terminal = useTerminal()
  const today = todayInCaracas()
  const [range, setRange] = useState(() => presetRange("month", today))
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<DocumentSummary | null>(null)
  const bounds = { from: dayRange(range.from).from, to: dayRange(range.to).to }
  const valid = range.from <= range.to
  const rows = useQuery({ ...productionQuery(bounds), enabled: valid })
  const summaries = useQuery({
    ...documentsQuery({ type: "PRODUCTION", from: bounds.from, to: bounds.to }),
    enabled: valid,
  })
  const preset = PRESETS.find((p) => {
    const r = presetRange(p.id, today)
    return r.from === range.from && r.to === range.to
  })

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-xl">Producción</h1>
        {can(me, "inventory.adjust") ? (
          <Button className="ml-auto" onClick={() => setCreating(true)}>
            <PlusIcon /> Nueva producción
          </Button>
        ) : null}
      </div>
      <p className="-mt-2 text-muted-foreground text-sm">
        Lo que se prepara por tandas para vender después: se gastan los ingredientes de su receta y
        entra a la existencia con su costo. Al anular una producción, los ingredientes vuelven.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[auto_auto_1fr]">
        <Field label="Desde" htmlFor="pr-from">
          <Input
            id="pr-from"
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))}
          />
        </Field>
        <Field label="Hasta" htmlFor="pr-to">
          <Input
            id="pr-to"
            type="date"
            value={range.to}
            min={range.from}
            max={today}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))}
          />
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

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Número</TableHead>
                <TableHead>Producto</TableHead>
                <TableHead className="text-right">Cantidad</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.data?.length ? null : (
                <TableRow>
                  <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                    {rows.isLoading ? "Cargando…" : "No se produjo nada en este período."}
                  </TableCell>
                </TableRow>
              )}
              {(rows.data ?? []).map((r) => {
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
                      <span className="block font-medium">{r.productName}</span>
                      <span className="block text-muted-foreground text-xs">
                        {[
                          r.unitCostMinor !== null && r.costCurrency
                            ? `${formatMoney(r.unitCostMinor, r.costCurrency)} c/u`
                            : null,
                          locations ? r.locationName : null,
                          r.note,
                          r.createdBy,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {r.reversedBy ? (
                        <Badge variant="destructive" className="mt-1">
                          Anulada
                        </Badge>
                      ) : r.reversesDocumentId ? (
                        <Badge variant="outline" className="mt-1">
                          Reverso
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular text-right">{formatQty(r.qtyMilli)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {creating && boot.data && terminal ? (
        <NewProductionDialog
          boot={boot.data}
          terminalId={terminal.id}
          defaultLocationId={terminal.locationId}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {open ? <DocumentDialog doc={open} onClose={() => setOpen(null)} /> : null}
    </div>
  )
}
