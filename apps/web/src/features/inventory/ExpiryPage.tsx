import type { LotRow } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { PackageMinusIcon, PencilIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatDate, formatQty } from "../../lib/format"
import { useLocations } from "../../lib/locations"
import { bootstrapQuery, lotsQuery, queryClient } from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { useTerminal } from "../../lib/terminal"

type Status = "all" | "expired" | "expiring"

const FILTERS: { id: Status; label: string }[] = [
  { id: "all", label: "Todos" },
  { id: "expired", label: "Vencidos" },
  { id: "expiring", label: "Por vencer" },
]

const ALERT_OPTIONS = [7, 15, 30, 60, 90]

const refresh = () =>
  Promise.all(
    ["lots", "products", "stock-adjustments", "reports", "documents"].map((k) =>
      queryClient.invalidateQueries({ queryKey: [k] }),
    ),
  )

/** Cuándo vence, en palabras: «en 5 días», «vence hoy», «venció hace 3 días». */
function whenText(daysLeft: number | null): string {
  if (daysLeft === null) return "sin fecha"
  if (daysLeft === 0) return "vence hoy"
  if (daysLeft === 1) return "vence mañana"
  if (daysLeft > 0) return `en ${daysLeft} días`
  return daysLeft === -1 ? "venció ayer" : `venció hace ${-daysLeft} días`
}

/** Los lotes con existencia y su vencimiento: lo vencido arriba, para darlo de baja. */
export function ExpiryPage() {
  const me = useMe()
  const locations = useLocations()
  const [status, setStatus] = useState<Status>("all")
  const [locationId, setLocationId] = useState("")
  const [editing, setEditing] = useState<LotRow | null>(null)
  const [writingOff, setWritingOff] = useState<LotRow | null>(null)
  const lots = useQuery(lotsQuery({ status, ...(locationId ? { locationId } : {}) }))
  const canAdjust = can(me, "inventory.adjust")
  const data = lots.data

  const setAlert = async (alertDays: number) => {
    try {
      await api("/api/settings/lots", { method: "PUT", body: { alertDays } })
      await refresh()
      toast.success(`Se avisará ${alertDays} días antes de vencer`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <h1 className="font-semibold text-xl">Vencimientos</h1>
      <p className="-mt-2 text-muted-foreground text-sm">
        Lotes con existencia, el que vence primero arriba. La caja vende primero lo que vence antes
        y deja lo vencido para el final: dalo de baja aquí.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Button
              key={f.id}
              size="sm"
              variant={status === f.id ? "default" : "outline"}
              onClick={() => setStatus(f.id)}
            >
              {f.label}
            </Button>
          ))}
        </div>
        {locations ? (
          <NativeSelect
            aria-label="Ubicación"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="h-8 w-full py-0 text-sm sm:w-48"
          >
            <option value="">Todas las ubicaciones</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </NativeSelect>
        ) : null}
        {data && canAdjust ? (
          <div className="flex items-center gap-2 text-sm sm:ml-auto">
            <span>Avisar</span>
            <NativeSelect
              aria-label="Días de aviso"
              value={data.alertDays}
              onChange={(e) => void setAlert(Number(e.target.value))}
              className="h-8 w-auto py-0 text-sm"
            >
              {[...new Set([...ALERT_OPTIONS, data.alertDays])]
                .sort((a, b) => a - b)
                .map((d) => (
                  <option key={d} value={d}>
                    {d} días antes
                  </option>
                ))}
            </NativeSelect>
          </div>
        ) : null}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Producto</TableHead>
                <TableHead>Vence</TableHead>
                <TableHead className="text-right">Cantidad</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.rows.length ? null : (
                <TableRow>
                  <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                    {lots.isLoading
                      ? "Cargando…"
                      : status === "expired"
                        ? "No hay nada vencido."
                        : status === "expiring"
                          ? `Nada vence en los próximos ${data?.alertDays ?? 30} días.`
                          : "No hay lotes con existencia."}
                  </TableCell>
                </TableRow>
              )}
              {(data?.rows ?? []).map((r) => {
                const expired = r.daysLeft !== null && r.daysLeft < 0
                const soon = !expired && r.daysLeft !== null && data && r.daysLeft <= data.alertDays
                return (
                  <TableRow key={`${r.lotId}-${r.locationId}`}>
                    <TableCell className="min-w-0 whitespace-normal text-sm">
                      <span className="font-medium">{r.productName}</span>
                      <span className="block text-muted-foreground text-xs">
                        {[
                          r.code ? `Lote ${r.code}` : null,
                          locations ? r.locationName : null,
                          r.documentNumber,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {canAdjust ? (
                        <span className="mt-1 flex flex-wrap gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => setEditing(r)}
                          >
                            <PencilIcon /> Corregir
                          </Button>
                          {expired ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-destructive text-xs"
                              onClick={() => setWritingOff(r)}
                            >
                              <PackageMinusIcon /> Dar de baja
                            </Button>
                          ) : null}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {r.expiresOn ? formatDate(r.expiresOn) : "—"}
                      <span className="block">
                        {expired ? (
                          <Badge variant="destructive">{whenText(r.daysLeft)}</Badge>
                        ) : soon ? (
                          <Badge variant="warning">{whenText(r.daysLeft)}</Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">
                            {whenText(r.daysLeft)}
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="tabular text-right font-medium">
                      {formatQty(r.qtyMilli)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {editing ? <EditLotDialog lot={editing} onClose={() => setEditing(null)} /> : null}
      {writingOff ? <WriteOffDialog lot={writingOff} onClose={() => setWritingOff(null)} /> : null}
    </div>
  )
}

/** Corrige el código o la fecha de un lote mal anotado; queda en la bitácora. */
function EditLotDialog({ lot, onClose }: { lot: LotRow; onClose: () => void }) {
  const [code, setCode] = useState(lot.code ?? "")
  const [expiresOn, setExpiresOn] = useState(lot.expiresOn ?? "")
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/api/lots/${lot.lotId}`, {
        method: "PATCH",
        body: { code: code.trim() || null, expiresOn: expiresOn || null },
      })
      await refresh()
      toast.success("Lote corregido")
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Corregir lote</DialogTitle>
          <DialogDescription>
            {lot.productName} · entró con {lot.documentNumber}
          </DialogDescription>
        </DialogHeader>
        <form id="lot-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <Field label="Código del lote" htmlFor="lot-code">
            <Input
              id="lot-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Opcional"
              maxLength={40}
            />
          </Field>
          <Field label="Vence" htmlFor="lot-expires">
            <Input
              id="lot-expires"
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
            />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form="lot-form" disabled={busy}>
            {busy ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Saca de la existencia lo que queda de un lote vencido, con el motivo «Vencido». */
function WriteOffDialog({ lot, onClose }: { lot: LotRow; onClose: () => void }) {
  const { data: boot } = useQuery(bootstrapQuery)
  const terminal = useTerminal()
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!boot || !terminal) return
    setBusy(true)
    try {
      await api("/api/documents", {
        body: {
          id: uuidv7(),
          type: "ADJUSTMENT",
          terminalId: terminal.id,
          currency: boot.business.legalCurrency,
          rate: null,
          locationId: lot.locationId,
          stockReasonId: "stk-out-expired",
          lines: [
            {
              variantId: lot.variantId,
              qtyMilli: -lot.qtyMilli,
              unitPriceMinor: 0,
              lotId: lot.lotId,
            },
          ],
          note: note.trim() || null,
        },
      })
      await refresh()
      toast.success(`Baja de ${formatQty(lot.qtyMilli)} de ${lot.productName}`)
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Dar de baja lo vencido</DialogTitle>
          <DialogDescription>
            Sale {formatQty(lot.qtyMilli)} de {lot.productName}
            {lot.code ? ` (lote ${lot.code})` : ""}
            {lot.expiresOn ? `, vencido el ${formatDate(lot.expiresOn)}` : ""}. Queda como ajuste
            con el motivo «Vencido» y su costo cuenta como pérdida.
          </DialogDescription>
        </DialogHeader>
        <Field label="Nota (opcional)" htmlFor="wo-note">
          <Input
            id="wo-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Se botó, se devolvió al proveedor…"
            maxLength={500}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={submit} disabled={busy || !boot || !terminal}>
            {busy ? "Guardando…" : "Dar de baja"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
