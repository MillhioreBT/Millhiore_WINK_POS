import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@millhiore/ui"
import { CloudOffIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { formatDateTime, formatMoney } from "../../lib/format"
import { can, useMe } from "../../lib/session"
import { type QueuedSale, sendQueued, useOfflineSales } from "./offline"

/** Ventas cobradas sin conexión en este equipo, con el reintento y el descarte de cada una. */
function OfflineSalesDialog({ onClose }: { onClose: () => void }) {
  const me = useMe()
  const { sales, retry, discard } = useOfflineSales()
  const [discarding, setDiscarding] = useState<QueuedSale | null>(null)
  // Descartar la de otra persona: solo quien puede anular ventas.
  const canDiscard = (s: QueuedSale) => s.userId === me.id || can(me, "sale.void")
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cobradas sin conexión</DialogTitle>
          <DialogDescription>
            Quedaron guardadas en este equipo y se registran solas al volver la conexión, a nombre
            de quien las cobró.
          </DialogDescription>
        </DialogHeader>
        {sales.length === 0 ? (
          <p className="text-muted-foreground text-sm">Ya se registraron todas.</p>
        ) : (
          <ul className="grid max-h-[60dvh] gap-2 overflow-y-auto">
            {sales.map((s) => (
              <li key={s.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted-foreground">
                    {formatDateTime(s.queuedAt)} · {s.items}{" "}
                    {s.items === 1 ? "producto" : "productos"}
                  </span>
                  <span className="tabular font-semibold">
                    {formatMoney(s.totalMinor, s.currency)}
                  </span>
                </div>
                {s.status === "failed" ? (
                  <p className="text-destructive">No se registró: {s.error}</p>
                ) : s.userId !== me.id ? (
                  <p className="text-muted-foreground">
                    La cobró {s.userName}: se envía cuando entre en este equipo.
                  </p>
                ) : (
                  <p className="text-muted-foreground">Pendiente de enviar.</p>
                )}
                {discarding?.id === s.id ? (
                  <div className="grid gap-2 rounded-md bg-destructive/10 p-2">
                    <p>
                      Si la descartas, la venta no queda registrada: el dinero cobrado y lo vendido
                      no aparecen en el turno ni en el inventario.
                    </p>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setDiscarding(null)}>
                        Conservar
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          discard(s.id)
                          setDiscarding(null)
                        }}
                      >
                        Descartar
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap justify-end gap-2">
                    {canDiscard(s) ? (
                      <Button variant="ghost" size="sm" onClick={() => setDiscarding(s)}>
                        Descartar
                      </Button>
                    ) : null}
                    {s.status === "failed" && s.userId === me.id ? (
                      <Button
                        size="sm"
                        onClick={() => {
                          retry(s.id)
                          void sendQueued(me.id)
                        }}
                      >
                        <RotateCwIcon /> Reintentar
                      </Button>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Aviso en la caja mientras queden ventas cobradas sin conexión en este equipo. */
export function OfflineSalesBanner() {
  const me = useMe()
  const sales = useOfflineSales((s) => s.sales)
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const failed = sales.filter((s) => s.status === "failed").length
  const mine = sales.filter((s) => s.status === "pending" && s.userId === me.id).length
  if (sales.length === 0 && !open) return null
  return (
    <>
      {sales.length ? (
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-3 text-sm",
            failed ? "border-destructive/50 bg-destructive/10" : "border-warning/50 bg-warning/15",
          )}
        >
          <span className="flex min-w-48 flex-1 items-center gap-2">
            {failed ? (
              <TriangleAlertIcon className="size-4 shrink-0" />
            ) : (
              <CloudOffIcon className="size-4 shrink-0" />
            )}
            {failed === 1
              ? "Una venta cobrada sin conexión no se registró: revísala"
              : failed
                ? `${failed} ventas cobradas sin conexión no se registraron: revísalas`
                : sales.length === 1
                  ? "Una venta cobrada sin conexión por enviar: se envía sola"
                  : `${sales.length} ventas cobradas sin conexión por enviar: se envían solas`}
          </span>
          <span className="flex gap-2">
            {mine ? (
              <Button
                variant="outline"
                size="sm"
                disabled={sending}
                onClick={async () => {
                  setSending(true)
                  try {
                    const { waiting } = await sendQueued(me.id)
                    if (waiting) toast.warning("Todavía no hay conexión con el servidor")
                  } finally {
                    setSending(false)
                  }
                }}
              >
                <RotateCwIcon /> Enviar ahora
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              Ver
            </Button>
          </span>
        </div>
      ) : null}
      {open ? <OfflineSalesDialog onClose={() => setOpen(false)} /> : null}
    </>
  )
}
