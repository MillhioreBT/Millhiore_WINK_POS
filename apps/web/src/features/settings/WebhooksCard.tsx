import { WEBHOOK_EVENTS, type Webhook, type WebhookEvent } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { CopyIcon, PencilIcon, PlusIcon, SendIcon, WebhookIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { ApiError, api, errorMessage } from "../../lib/api"
import { formatDateTime } from "../../lib/format"
import { queryClient, webhookDeliveriesQuery, webhooksQuery } from "../../lib/queries"

/** Qué avisa cada evento, dicho como en el negocio. */
export const EVENT_LABELS: Record<WebhookEvent | "ping", string> = {
  "sale.posted": "Cada venta",
  "document.posted": "Cada documento (ventas, compras, gastos, pagos…)",
  "document.voided": "Cada anulación",
  "shift.opened": "Apertura de turno",
  "shift.closed": "Cierre de turno",
  "rate.updated": "Tasa nueva",
  "order.created": "Pedido desde el catálogo en línea",
  ping: "Prueba",
}

const refresh = () => queryClient.invalidateQueries({ queryKey: ["webhooks"] })

const copy = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text)
    toast.success("Copiado")
  } catch {
    toast.error("No se pudo copiar: selecciónalo y cópialo a mano")
  }
}

/**
 * Webhooks: otro sistema recibe un aviso (POST con JSON, firmado) cada vez que pasa lo que eligió.
 * Si no responde se reintenta solo; aquí se ve cómo le fue a cada aviso.
 */
export function WebhooksCard() {
  // El estado del último aviso cambia solo (reintentos): se pone al día cada 10 s.
  const hooks = useQuery({ ...webhooksQuery, refetchInterval: 10_000 })
  const [editing, setEditing] = useState<Webhook | null | undefined>(undefined)
  const [open, setOpen] = useState<string | null>(null)

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn()
      await refresh()
      toast.success(done)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-56 flex-1 gap-1.5">
          <CardTitle>Webhooks</CardTitle>
          <CardDescription>
            Avisan a otro sistema cada vez que pasa algo: una venta, un cierre de turno, la tasa
            nueva. Cada aviso va firmado con el secreto del webhook y, si no responde, se reintenta
            solo durante casi un día.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setEditing(null)}>
          <PlusIcon /> Nuevo webhook
        </Button>
      </CardHeader>
      <CardContent>
        {hooks.data?.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
            Todavía no hay webhooks.
          </p>
        ) : null}
        <ul className="divide-y rounded-lg border empty:hidden">
          {(hooks.data ?? []).map((w) => (
            <li
              key={w.id}
              className={`grid gap-2 px-3 py-2.5 text-sm ${w.active ? "" : "opacity-70"}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-56 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <WebhookIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="font-medium">{w.name}</span>
                    {w.active ? null : <Badge variant="outline">Apagado</Badge>}
                    <LastBadge hook={w} />
                  </p>
                  <p className="break-all font-mono text-muted-foreground text-xs">{w.url}</p>
                  <p className="text-muted-foreground text-xs">
                    {w.events.map((e) => EVENT_LABELS[e]).join(" · ")}
                  </p>
                </div>
                <span className="flex flex-wrap justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void act(async () => {
                        await api(`/api/webhooks/${w.id}/ping`, { method: "POST" })
                        setOpen(w.id)
                      }, "Prueba en camino")
                    }
                  >
                    <SendIcon /> Probar
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setOpen(open === w.id ? null : w.id)}
                  >
                    {open === w.id ? "Ocultar avisos" : "Avisos"}
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Editar ${w.name}`}
                    onClick={() => setEditing(w)}
                  >
                    <PencilIcon />
                  </Button>
                </span>
              </div>
              {open === w.id ? <Deliveries hook={w} /> : null}
            </li>
          ))}
        </ul>
      </CardContent>
      {editing !== undefined ? (
        <WebhookDialog hook={editing} onClose={() => setEditing(undefined)} />
      ) : null}
    </Card>
  )
}

function LastBadge({ hook }: { hook: Webhook }) {
  if (!hook.last) return null
  const { status, lastStatus } = hook.last
  return status === "delivered" ? (
    <Badge variant="secondary">Entregado{lastStatus ? ` (${lastStatus})` : ""}</Badge>
  ) : status === "failed" ? (
    <Badge variant="destructive">Falló</Badge>
  ) : (
    <Badge variant="warning">{lastStatus ? "Reintentando" : "En camino"}</Badge>
  )
}

/** El secreto y los últimos avisos, con cómo le fue a cada uno. Se actualiza solo. */
function Deliveries({ hook }: { hook: Webhook }) {
  const list = useQuery({ ...webhookDeliveriesQuery(hook.id), refetchInterval: 5_000 })
  const retry = async (id: string) => {
    try {
      await api(`/api/webhooks/deliveries/${id}/retry`, { method: "POST" })
      await queryClient.invalidateQueries({ queryKey: ["webhooks"] })
      toast.success("Se vuelve a intentar")
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <div className="grid min-w-0 gap-2 rounded-lg bg-muted/50 p-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Secreto para comprobar la firma:</span>
        <code className="min-w-0 break-all font-mono">{hook.secret}</code>
        <Button size="sm" variant="ghost" className="h-7" onClick={() => void copy(hook.secret)}>
          <CopyIcon /> Copiar
        </Button>
      </div>
      {list.data?.length === 0 ? (
        <p className="text-muted-foreground text-xs">Todavía no hay avisos.</p>
      ) : null}
      <ul className="grid gap-1 empty:hidden">
        {(list.data ?? []).map((d) => (
          <li
            key={d.id}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md bg-background px-2.5 py-1.5 text-xs"
          >
            <span className="min-w-0">
              <span className="font-medium">
                {EVENT_LABELS[d.event as WebhookEvent] ?? d.event}
              </span>{" "}
              <span className="text-muted-foreground">· {formatDateTime(d.createdAt)}</span>
              <span className="block text-muted-foreground">
                {d.status === "delivered"
                  ? `Entregado${d.lastStatus ? ` (${d.lastStatus})` : ""}${d.attempts > 1 ? ` al intento ${d.attempts}` : ""}`
                  : d.status === "failed"
                    ? `Falló tras ${d.attempts} intentos: ${d.lastError ?? ""}`
                    : d.attempts === 0
                      ? "En camino"
                      : `${d.lastError ?? "Falló"} · intento ${d.attempts}; el próximo ${d.nextAttemptAt ? formatDateTime(d.nextAttemptAt) : "pronto"}`}
              </span>
            </span>
            {d.status === "delivered" ? null : (
              <Button size="sm" variant="outline" className="h-7" onClick={() => void retry(d.id)}>
                Reintentar ya
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function WebhookDialog({ hook, onClose }: { hook: Webhook | null; onClose: () => void }) {
  const [name, setName] = useState(hook?.name ?? "")
  const [url, setUrl] = useState(hook?.url ?? "https://")
  const [events, setEvents] = useState<Set<WebhookEvent>>(new Set(hook?.events ?? ["sale.posted"]))
  const [active, setActive] = useState(hook?.active ?? true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const toggle = (e: WebhookEvent) =>
    setEvents((s) => {
      const next = new Set(s)
      if (next.has(e)) next.delete(e)
      else next.add(e)
      return next
    })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErrors({})
    const body = {
      name: name.trim(),
      url: url.trim(),
      events: WEBHOOK_EVENTS.filter((x) => events.has(x)),
    }
    try {
      if (hook) {
        await api(`/api/webhooks/${hook.id}`, { method: "PATCH", body: { ...body, active } })
        toast.success("Webhook guardado")
      } else {
        await api("/api/webhooks", { body })
        toast.success(`Webhook «${body.name}» creado`)
      }
      await refresh()
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.issues.length) {
        setErrors(Object.fromEntries(err.issues.map((i) => [i.path, i.message])))
      } else {
        toast.error(errorMessage(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{hook ? `Editar ${hook.name}` : "Nuevo webhook"}</DialogTitle>
          <DialogDescription>
            Cada aviso es un POST con JSON a esta dirección, con la firma en la cabecera
            x-millhiore-signature.
          </DialogDescription>
        </DialogHeader>
        <form id="webhook-form" onSubmit={submit} className="grid min-w-0 gap-4">
          <Field label="Para qué es" htmlFor="wh-name" error={errors.name}>
            <Input
              id="wh-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tienda en línea"
              required
              autoFocus
            />
          </Field>
          <Field label="Dirección" htmlFor="wh-url" error={errors.url}>
            <Input
              id="wh-url"
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="font-mono"
              required
            />
          </Field>
          <fieldset className="grid min-w-0 gap-1">
            <legend className="mb-1.5 font-medium text-sm">Qué avisa</legend>
            {WEBHOOK_EVENTS.map((ev) => (
              <label
                key={ev}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent"
              >
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--primary)]"
                  checked={events.has(ev)}
                  onChange={() => toggle(ev)}
                />
                {EVENT_LABELS[ev]}
              </label>
            ))}
            {errors.events ? <p className="text-destructive text-xs">{errors.events}</p> : null}
          </fieldset>
          {hook ? (
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Encendido (apagado no recibe avisos de lo que pase mientras tanto)
            </label>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="webhook-form"
            disabled={busy || !name.trim() || events.size === 0}
          >
            {hook ? "Guardar" : "Crear webhook"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
