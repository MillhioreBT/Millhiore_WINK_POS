import type { DocumentSummary } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  CardContent,
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
import { ArrowRightIcon, PlusIcon } from "lucide-react"
import { useState } from "react"
import { dayRange, todayInCaracas } from "../../lib/days"
import { formatDateTime } from "../../lib/format"
import { useLocations } from "../../lib/locations"
import { bootstrapQuery, documentsQuery } from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { useTerminal } from "../../lib/terminal"
import { DocumentDialog } from "../sales/SalesPage"
import { NewTransferDialog } from "./NewTransferDialog"
import { PRESETS, presetRange } from "./period"

/** La mercancía que pasó de una ubicación a otra (del depósito a la tienda, entre tiendas). */
export function TransfersPage() {
  const me = useMe()
  const boot = useQuery(bootstrapQuery)
  const locations = useLocations()
  const terminal = useTerminal()
  const today = todayInCaracas()
  const [range, setRange] = useState(() => presetRange("month", today))
  const [locationId, setLocationId] = useState("")
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<DocumentSummary | null>(null)
  const bounds = { from: dayRange(range.from).from, to: dayRange(range.to).to }
  const valid = range.from <= range.to
  const docs = useQuery({
    ...documentsQuery({ type: "STOCK_TRANSFER", from: bounds.from, to: bounds.to }),
    enabled: valid,
  })
  const rows = (docs.data ?? []).filter(
    (d) => !locationId || d.locationId === locationId || d.toLocationId === locationId,
  )
  const preset = PRESETS.find((p) => {
    const r = presetRange(p.id, today)
    return r.from === range.from && r.to === range.to
  })
  const canMove = can(me, "inventory.adjust") && locations !== null

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-xl">Traslados</h1>
        {canMove ? (
          <Button className="ml-auto" onClick={() => setCreating(true)}>
            <PlusIcon /> Nuevo traslado
          </Button>
        ) : null}
      </div>
      <p className="-mt-2 text-muted-foreground text-sm">
        {locations
          ? "Mercancía que pasó de una ubicación a otra. Al anular un traslado, vuelve al origen."
          : "Para trasladar hace falta más de una ubicación: créalas en Ajustes → Negocio → Ubicaciones y cajas."}
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[auto_auto_1fr]">
        <Field label="Desde" htmlFor="tl-from">
          <Input
            id="tl-from"
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))}
          />
        </Field>
        <Field label="Hasta" htmlFor="tl-to">
          <Input
            id="tl-to"
            type="date"
            value={range.to}
            min={range.from}
            max={today}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))}
          />
        </Field>
        {locations ? (
          <Field label="Ubicación" htmlFor="tl-location" className="col-span-2 sm:col-span-1">
            <NativeSelect
              id="tl-location"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
            >
              <option value="">Todas</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
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
                <TableHead>De → a</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length ? null : (
                <TableRow>
                  <TableCell colSpan={2} className="py-10 text-center text-muted-foreground">
                    {docs.isLoading ? "Cargando…" : "No hay traslados en este período."}
                  </TableCell>
                </TableRow>
              )}
              {rows.map((d) => {
                // El reverso devuelve la mercancía: se lee del destino al origen.
                const [a, b] = d.reversesDocumentId
                  ? [d.toLocationName, d.locationName]
                  : [d.locationName, d.toLocationName]
                return (
                  <TableRow key={d.id}>
                    <TableCell className="whitespace-nowrap font-medium">
                      <button
                        type="button"
                        className="cursor-pointer text-primary underline-offset-4 hover:underline"
                        onClick={() => setOpen(d)}
                      >
                        {d.number}
                      </button>
                      <span className="block font-normal text-muted-foreground text-xs">
                        {formatDateTime(d.postedAt)}
                      </span>
                    </TableCell>
                    <TableCell className="min-w-0 whitespace-normal text-sm">
                      <span className="flex flex-wrap items-center gap-1 font-medium">
                        {a} <ArrowRightIcon className="size-3.5 text-muted-foreground" /> {b}
                      </span>
                      <span className="block text-muted-foreground text-xs">
                        {[d.note, d.createdBy].filter(Boolean).join(" · ")}
                      </span>
                      {d.reversedBy ? (
                        <Badge variant="destructive" className="mt-1">
                          Anulado
                        </Badge>
                      ) : d.reversesDocumentId ? (
                        <Badge variant="outline" className="mt-1">
                          Reverso
                        </Badge>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {creating && boot.data && locations && terminal ? (
        <NewTransferDialog
          boot={boot.data}
          locations={locations}
          terminalId={terminal.id}
          defaultFrom={
            // Lo usual es reponer la tienda desde el depósito.
            locations.find((l) => l.kind === "warehouse")?.id ?? terminal.locationId
          }
          onClose={() => setCreating(false)}
        />
      ) : null}
      {open ? <DocumentDialog doc={open} onClose={() => setOpen(null)} /> : null}
    </div>
  )
}
