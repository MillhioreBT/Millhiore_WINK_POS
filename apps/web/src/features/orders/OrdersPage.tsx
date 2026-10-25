import type { WebOrder } from "@millhiore/contracts"
import { uuidv7, whatsappNumber } from "@millhiore/domain"
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
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { CheckIcon, MessageCircleIcon, ShoppingCartIcon, XIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatDateTime, formatMoney, formatQtyUnit } from "../../lib/format"
import {
  bootstrapQuery,
  ordersCountQuery,
  ordersQuery,
  productsQuery,
  queryClient,
} from "../../lib/queries"
import { can, useFeatures, useMe } from "../../lib/session"
import { type TicketLine, usePos } from "../pos/store"

const STATUS: Record<
  WebOrder["status"],
  { label: string; variant: "warning" | "success" | "outline" }
> = {
  new: { label: "Nuevo", variant: "warning" },
  done: { label: "Atendido", variant: "success" },
  cancelled: { label: "Descartado", variant: "outline" },
}

/** Precio × cantidad en milésimas, como lo calcula el servidor. */
const lineTotal = (unitMinor: number, qtyMilli: number) =>
  Math.floor((unitMinor * qtyMilli + 500) / 1000)

const refresh = () => queryClient.invalidateQueries({ queryKey: ["orders"] })

/** Pedidos que llegan del catálogo en línea: se pasan a la caja, se responden o se descartan. */
export function OrdersPage() {
  const [status, setStatus] = useState<WebOrder["status"] | "all">("new")
  const orders = useQuery(ordersQuery(status))
  const [cancelling, setCancelling] = useState<WebOrder | null>(null)
  const rows = orders.data ?? []

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-xl">Pedidos</h1>
        <NativeSelect
          value={status}
          onChange={(e) => setStatus(e.target.value as WebOrder["status"] | "all")}
          className="ml-auto w-40"
          aria-label="Estado"
        >
          <option value="new">Nuevos</option>
          <option value="done">Atendidos</option>
          <option value="cancelled">Descartados</option>
          <option value="all">Todos</option>
        </NativeSelect>
      </div>
      <p className="text-muted-foreground text-sm">
        Llegan desde el catálogo en línea (y por WhatsApp). «Pasar a la caja» lo carga en el ticket;
        al cobrarlo queda atendido.
      </p>
      {orders.isPending ? (
        <p className="text-muted-foreground text-sm">Cargando…</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground text-sm">
            {status === "new" ? "No hay pedidos por atender." : "No hay pedidos aquí."}
          </CardContent>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {rows.map((o) => (
            <li key={o.id} className="min-w-0">
              <OrderCard order={o} onCancel={() => setCancelling(o)} />
            </li>
          ))}
        </ul>
      )}
      {cancelling ? <CancelDialog order={cancelling} onClose={() => setCancelling(null)} /> : null}
    </div>
  )
}

function OrderCard({ order: o, onCancel }: { order: WebOrder; onCancel: () => void }) {
  const boot = useQuery(bootstrapQuery)
  const products = useQuery(productsQuery())
  const loadOrder = usePos((s) => s.loadOrder)
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const phone = whatsappNumber(o.customerPhone)
  const business = boot.data?.business.name ?? "la tienda"
  const reply = `Hola ${o.customerName}, te escribimos de ${business} por tu pedido ${o.number}.`
  const status = STATUS[o.status]

  const toTill = () => {
    const items = new Map((products.data ?? []).map((p) => [p.variantId, p]))
    const missing: string[] = []
    const lines: TicketLine[] = []
    for (const l of o.lines) {
      const item = items.get(l.variantId)
      if (!item?.active) {
        missing.push(l.name)
        continue
      }
      lines.push({
        variantId: item.variantId,
        name: item.name,
        qtyMilli: l.qtyMilli,
        ...(item.unit !== "unit" ? { unit: item.unit } : {}),
        priceMinor: item.priceMinor,
        priceCurrency: item.priceCurrency,
        taxId: item.taxId,
        // Con indicaciones va en su propia línea, como en la caja.
        ...(l.note ? { key: uuidv7(), modifiers: [], note: l.note } : {}),
      })
    }
    if (lines.length === 0) {
      toast.error("Ninguno de sus productos se vende ya")
      return
    }
    if (missing.length) toast.warning(`Ya no se vende: ${missing.join(", ")}`)
    loadOrder(
      {
        id: o.id,
        number: o.number,
        customerName: o.customerName,
        customerPhone: o.customerPhone,
      },
      lines,
      o.priceListId,
    )
    void navigate({ to: "/caja" })
  }

  const markDone = async () => {
    setBusy(true)
    try {
      await api(`/api/orders/${o.id}/done`, { method: "POST" })
      await refresh()
      toast.success(`Pedido ${o.number} atendido`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="h-full">
      <CardContent className="grid gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{o.number}</span>
          <span className="text-muted-foreground text-xs">{formatDateTime(o.createdAt)}</span>
          <Badge variant={status.variant} className="ml-auto">
            {status.label}
          </Badge>
        </div>
        <div className="grid gap-0.5">
          <span className="font-medium">
            {o.customerName} · <span className="tabular">{o.customerPhone}</span>
          </span>
          <span className="text-muted-foreground">
            {o.delivery === "delivery" ? `Delivery a ${o.address ?? "—"}` : "Retira en la tienda"}
            {o.payment ? ` · Paga con ${o.payment}` : ""}
          </span>
          {o.note ? <span className="whitespace-pre-line">«{o.note}»</span> : null}
        </div>
        <ul className="grid gap-1 border-t pt-2">
          {o.lines.map((l) => (
            <li key={`${l.variantId}-${l.note ?? ""}`} className="flex gap-2">
              <span className="min-w-0 flex-1">
                {formatQtyUnit(l.qtyMilli, l.unit)} × {l.name}
                {l.note ? (
                  <span className="block text-muted-foreground text-xs">{l.note}</span>
                ) : null}
              </span>
              {l.referenceMinor !== null ? (
                <span className="tabular">
                  {formatMoney(lineTotal(l.referenceMinor, l.qtyMilli), o.referenceCurrency)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-t pt-2">
          <span className="font-medium">Total</span>
          <span className="tabular">
            {o.totalReferenceMinor !== null ? (
              <span className="font-semibold">
                {formatMoney(o.totalReferenceMinor, o.referenceCurrency)}
              </span>
            ) : null}
            {o.totalLegalMinor !== null ? (
              <span className="ml-2 text-muted-foreground">
                {formatMoney(o.totalLegalMinor, o.legalCurrency)}
              </span>
            ) : null}
          </span>
        </div>
        {o.status === "done" ? (
          <p className="text-muted-foreground text-xs">
            {o.documentNumber ? `Cobrado en ${o.documentNumber}` : "Atendido"}
            {o.handledByName ? ` por ${o.handledByName}` : ""}
            {o.handledAt ? ` · ${formatDateTime(o.handledAt)}` : ""}
          </p>
        ) : o.status === "cancelled" ? (
          <p className="text-muted-foreground text-xs">
            Descartado{o.cancelReason ? `: ${o.cancelReason}` : ""}
            {o.handledByName ? ` · ${o.handledByName}` : ""}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {o.status === "new" ? (
            <Button size="sm" onClick={toTill} disabled={products.isPending}>
              <ShoppingCartIcon /> Pasar a la caja
            </Button>
          ) : null}
          {phone ? (
            <Button asChild size="sm" variant="outline">
              <a
                href={`https://wa.me/${phone}?text=${encodeURIComponent(reply)}`}
                target="_blank"
                rel="noreferrer"
              >
                <MessageCircleIcon /> Responder
              </a>
            </Button>
          ) : null}
          {o.status === "new" ? (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void markDone()}>
                <CheckIcon /> Atendido
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
                <XIcon /> Descartar
              </Button>
            </>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

function CancelDialog({ order, onClose }: { order: WebOrder; onClose: () => void }) {
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/api/orders/${order.id}/cancel`, { body: { reason: reason.trim() || null } })
      await refresh()
      toast.success(`Pedido ${order.number} descartado`)
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Descartar el pedido {order.number}</DialogTitle>
          <DialogDescription>
            No se vende nada. Si el cliente escribió por WhatsApp, avísale.
          </DialogDescription>
        </DialogHeader>
        <form id="cancel-order" onSubmit={submit} className="grid gap-3">
          <Field label="Motivo" htmlFor="cancel-reason" hint="Opcional">
            <Input
              id="cancel-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
              placeholder="No contestó, se acabó…"
            />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Volver
          </Button>
          <Button type="submit" form="cancel-order" variant="destructive" disabled={busy}>
            Descartar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Avisa cuando llega un pedido nuevo mientras se trabaja en otra pantalla (con el catálogo
 * encendido y a quien vende). El primero que se ve al entrar no avisa.
 */
export function useOrderAlerts(): number {
  const me = useMe()
  const features = useFeatures()
  const enabled = features.catalog && can(me, "sale.create")
  // undefined mientras no llega la primera respuesta: lo que ya esperaba al entrar no avisa.
  const count = useQuery({ ...ordersCountQuery, enabled }).data?.new
  const last = useRef<number | null>(null)
  const navigate = useNavigate()
  useEffect(() => {
    if (!enabled || count === undefined) return
    if (last.current !== null && count > last.current) {
      toast.info(count - last.current === 1 ? "Llegó un pedido nuevo" : "Llegaron pedidos nuevos", {
        action: { label: "Ver", onClick: () => void navigate({ to: "/pedidos" }) },
      })
    }
    last.current = count
  }, [count, enabled, navigate])
  return enabled ? (count ?? 0) : 0
}
