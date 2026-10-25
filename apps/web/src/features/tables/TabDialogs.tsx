import type { DiningFloor, PrintBillBody, TabDetail, TabLine } from "@millhiore/contracts"
import {
  Button,
  cn,
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
import { MinusIcon, PlusIcon, PrinterIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatDateTime, formatMoney, formatPercent, formatQty, formatRate } from "../../lib/format"
import { bootstrapQuery, diningQuery, queryClient } from "../../lib/queries"
import { autoCharges, buildCart, convertMinor, type PosContext } from "../pos/compute"
import { BusinessHeader } from "../sales/ReceiptDialog"
import { chargeLines, isPending, type Takes, tabLabel, tableName } from "./tab"

/** Guarda la cuenta que devolvió el servidor y refresca el plano. */
export async function refreshTab(tab: TabDetail) {
  queryClient.setQueryData(["tabs", tab.id], tab)
  await queryClient.invalidateQueries({ queryKey: ["dining"] })
}

/** − cantidad +, de a una unidad y sin pasar de lo que hay. */
function Stepper({
  value,
  max,
  label,
  onChange,
}: {
  value: number
  max: number
  label: string
  onChange: (v: number) => void
}) {
  return (
    <span className="flex items-center gap-1">
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={`Uno menos de ${label}`}
        disabled={value <= 0}
        onClick={() => onChange(Math.max(0, value - 1000))}
      >
        <MinusIcon />
      </Button>
      <span className="tabular w-10 text-center text-sm">{formatQty(value)}</span>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={`Uno más de ${label}`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1000))}
      >
        <PlusIcon />
      </Button>
    </span>
  )
}

/** Elegir cuánto de cada producto pendiente (para cobrar una parte o pasarlo a otra mesa). */
function PickLines({
  lines,
  takes,
  setTakes,
}: {
  lines: TabLine[]
  takes: Takes
  setTakes: (t: Takes) => void
}) {
  return (
    <ul className="grid max-h-[45dvh] grid-cols-1 divide-y overflow-y-auto rounded-lg border">
      {lines.filter(isPending).map((l) => (
        <li key={l.id} className="flex items-center justify-between gap-2 px-3 py-2">
          <span className="min-w-0 text-sm">
            <span className="block truncate font-medium">{l.name}</span>
            <span className="text-muted-foreground text-xs">
              de {formatQty(l.qtyMilli)}
              {l.note ? ` · ${l.note}` : ""}
            </span>
          </span>
          <Stepper
            value={takes[l.id] ?? 0}
            max={l.qtyMilli}
            label={l.name}
            onChange={(v) => setTakes({ ...takes, [l.id]: v })}
          />
        </li>
      ))}
    </ul>
  )
}

/** Cobrar solo una parte: lo que se elige va a la caja; el resto sigue en la cuenta. */
export function ChargePartDialog({
  ctx,
  tab,
  onCharge,
  onClose,
}: {
  ctx: PosContext
  tab: TabDetail
  onCharge: (takes: Takes) => void
  onClose: () => void
}) {
  const [takes, setTakes] = useState<Takes>({})
  const picked = useMemo(() => chargeLines(tab.lines, takes), [tab.lines, takes])
  const total = buildCart(ctx, picked.lines, null, null, autoCharges(ctx)).ticket.totalMinor
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cobrar una parte</DialogTitle>
          <DialogDescription>
            Elige lo que paga esta persona. Lo demás sigue en la cuenta.
          </DialogDescription>
        </DialogHeader>
        <PickLines lines={tab.lines} takes={takes} setTakes={setTakes} />
        <p className="flex justify-between font-medium">
          <span>Esta parte</span>
          <span className="tabular">{formatMoney(total, ctx.docCurrency)}</span>
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="success"
            disabled={picked.refs.length === 0}
            onClick={() => onCharge(takes)}
          >
            Cobrar esto
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Pasar la cuenta (o lo elegido) a otra mesa; si está ocupada, se juntan. */
export function MoveTabDialog({
  tab,
  onMoved,
  onClose,
}: {
  tab: TabDetail
  onMoved: (target: TabDetail) => void
  onClose: () => void
}) {
  const floor = useQuery(diningQuery)
  const [target, setTarget] = useState<{ tableId?: string; tabId?: string } | null>(null)
  const [partial, setPartial] = useState(false)
  const [takes, setTakes] = useState<Takes>({})
  const [busy, setBusy] = useState(false)
  const lines = Object.entries(takes)
    .filter(([, q]) => q > 0)
    .map(([lineId, qtyMilli]) => ({ lineId, qtyMilli }))

  const submit = async () => {
    if (!target) return
    setBusy(true)
    try {
      const moved = await api<TabDetail>(`/api/tabs/${tab.id}/move`, {
        body: { ...target, ...(partial ? { lines } : {}) },
      })
      await queryClient.invalidateQueries({ queryKey: ["tabs"] })
      await refreshTab(moved)
      toast.success(
        moved.id === tab.id
          ? `La cuenta pasó a ${tabLabel(moved)}`
          : `${partial ? "Lo elegido" : "La cuenta"} pasó a ${tabLabel(moved)}`,
      )
      onMoved(moved)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  type Target = { tableId?: string; tabId?: string }
  const options = (
    f: DiningFloor,
  ): { key: string; value: Target; name: string; area: string | null; busy: boolean }[] => [
    ...f.areas.flatMap((a) =>
      a.tables
        .filter((t) => t.tab?.id !== tab.id)
        .map((t) => ({
          key: t.id,
          value: { tableId: t.id },
          name: tableName(t.name),
          area: f.areas.length > 1 ? a.name : null,
          busy: t.tab !== null,
        })),
    ),
    ...f.others
      .filter((t) => t.id !== tab.id)
      .map((t) => ({
        key: t.id,
        value: { tabId: t.id },
        name: tabLabel(t),
        area: "Sin mesa",
        busy: true,
      })),
  ]

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Pasar a otra mesa</DialogTitle>
          <DialogDescription>
            Si la mesa está ocupada, las cuentas se juntan en una.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {floor.data
            ? options(floor.data).map((o) => {
                const on = target?.tableId === o.value.tableId && target?.tabId === o.value.tabId
                return (
                  <button
                    key={o.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setTarget(o.value)}
                    className={cn(
                      "grid min-w-0 cursor-pointer rounded-lg border p-2 text-left text-sm",
                      on ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
                      !on && o.busy ? "bg-primary/10" : "",
                    )}
                  >
                    <span className="truncate font-medium">{o.name}</span>
                    <span className={cn("truncate text-xs", on ? "" : "text-muted-foreground")}>
                      {o.busy ? "Ocupada: se juntan" : "Libre"}
                      {o.area ? ` · ${o.area}` : ""}
                    </span>
                  </button>
                )
              })
            : null}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={partial}
            onChange={(e) => setPartial(e.target.checked)}
          />
          Pasar solo algunos productos
        </label>
        {partial ? <PickLines lines={tab.lines} takes={takes} setTakes={setTakes} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={busy || !target || (partial && lines.length === 0)}>
            Pasar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const VOID_REASONS = ["Se equivocaron al pedir", "El cliente no lo quiso", "Se demoró mucho"]

/** Anular algo ya pedido: cuánto y por qué (queda a la vista en la cuenta y en la bitácora). */
export function VoidLineDialog({
  tab,
  line,
  onClose,
}: {
  tab: TabDetail
  line: TabLine
  onClose: () => void
}) {
  const [qty, setQty] = useState(line.qtyMilli)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const updated = await api<TabDetail>(`/api/tabs/${tab.id}/lines/${line.id}/void`, {
        body: { qtyMilli: qty, reason: reason.trim() },
      })
      await refreshTab(updated)
      toast.success(`${line.name} anulado`)
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
        <form onSubmit={submit} className="grid grid-cols-1 gap-4">
          <DialogHeader>
            <DialogTitle>Anular {line.name}</DialogTitle>
            <DialogDescription>
              Ya se pidió: queda tachado en la cuenta, con el motivo y quién lo anuló.
            </DialogDescription>
          </DialogHeader>
          {line.qtyMilli > 1000 ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm">Cuántos</span>
              <Stepper value={qty} max={line.qtyMilli} label={line.name} onChange={setQty} />
            </div>
          ) : null}
          <Field label="Motivo" htmlFor="void-reason">
            <Input
              id="void-reason"
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-1.5">
            {VOID_REASONS.map((r) => (
              <Button
                key={r}
                type="button"
                variant="outline"
                size="sm"
                className="h-7 rounded-full text-xs"
                onClick={() => setReason(r)}
              >
                {r}
              </Button>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={busy || qty <= 0 || reason.trim().length < 2}
            >
              Anular
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Personas, nombre y nota de la cuenta. */
export function TabInfoDialog({ tab, onClose }: { tab: TabDetail; onClose: () => void }) {
  const [guests, setGuests] = useState(tab.guests ? String(tab.guests) : "")
  const [label, setLabel] = useState(tab.label ?? "")
  const [note, setNote] = useState(tab.note ?? "")
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const n = Number.parseInt(guests, 10)
      const updated = await api<TabDetail>(`/api/tabs/${tab.id}`, {
        method: "PATCH",
        body: { guests: n > 0 ? n : null, label: label.trim() || null, note: note.trim() || null },
      })
      await refreshTab(updated)
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
        <form onSubmit={submit} className="grid grid-cols-1 gap-4">
          <DialogHeader>
            <DialogTitle>{tabLabel(tab)}</DialogTitle>
            <DialogDescription>
              Cuenta {tab.number}
              {tab.waiterName ? ` · atiende ${tab.waiterName}` : ""}
            </DialogDescription>
          </DialogHeader>
          <Field label="Personas" htmlFor="tab-guests">
            <Input
              id="tab-guests"
              inputMode="numeric"
              value={guests}
              onChange={(e) => setGuests(e.target.value.replace(/\D/g, "").slice(0, 3))}
            />
          </Field>
          <Field
            label="Nombre"
            htmlFor="tab-name"
            hint={tab.tableId ? "Opcional: el del cliente, para encontrarla" : undefined}
          >
            <Input
              id="tab-name"
              value={label}
              maxLength={40}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Field label="Nota" htmlFor="tab-note">
            <Input
              id="tab-note"
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Cumpleaños, alergias…"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || (!tab.tableId && !label.trim())}>
              Guardar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Cerrar la cuenta sin cobrar; lo pendiente se anula con el motivo. */
export function CancelTabDialog({
  tab,
  onCancelled,
  onClose,
}: {
  tab: TabDetail
  onCancelled: () => void
  onClose: () => void
}) {
  const pending = tab.lines.some(isPending)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const updated = await api<TabDetail>(`/api/tabs/${tab.id}/cancel`, {
        body: { reason: reason.trim() || null },
      })
      await refreshTab(updated)
      toast.success(`Cuenta ${tab.number} anulada`)
      onCancelled()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-sm">
        <form onSubmit={submit} className="grid grid-cols-1 gap-4">
          <DialogHeader>
            <DialogTitle>Anular la cuenta</DialogTitle>
            <DialogDescription>
              {pending
                ? "Se cierra sin cobrar y lo que quedaba por cobrar se anula."
                : "La mesa queda libre."}
            </DialogDescription>
          </DialogHeader>
          {pending ? (
            <Field label="Motivo" htmlFor="cancel-reason">
              <Input
                id="cancel-reason"
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Se fueron sin pedir, invitación de la casa…"
              />
            </Field>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Volver
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={busy || (pending && reason.trim().length < 2)}
            >
              Anular la cuenta
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * La precuenta: lo que la mesa debe hasta ahora, para que la revisen antes de pagar. No es una
 * factura: la venta se registra al cobrar.
 */
export function BillDialog({
  ctx,
  tab,
  onClose,
}: {
  ctx: PosContext
  tab: TabDetail
  onClose: () => void
}) {
  const boot = useQuery(bootstrapQuery)
  const [printing, setPrinting] = useState(false)
  const cart = useMemo(
    () => buildCart(ctx, chargeLines(tab.lines).lines, null, null, autoCharges(ctx)),
    [ctx, tab.lines],
  )
  const doc = ctx.docCurrency
  const ref = ctx.refCurrency
  const totalRef = convertMinor(ctx, cart.ticket.totalMinor, doc, ref)
  const now = Date.now()
  const info = [
    `${tabLabel(tab)} · ${tab.number}`,
    [
      tab.guests ? `${tab.guests} personas` : null,
      tab.waiterName ? `Atendió: ${tab.waiterName}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    formatDateTime(now),
  ].filter(Boolean)
  const rows: PrintBillBody["rows"] = [
    ...cart.ticket.charges.map((c) => ({
      label: `${c.name}${c.kind === "percent" ? ` ${formatPercent(c.rateBp)}` : ""}`,
      amount: formatMoney(c.amountMinor, doc),
    })),
    ...cart.ticket.taxes
      .filter((t) => t.taxMinor !== 0)
      .map((t) => ({
        label: `IVA ${formatPercent(t.rateBp)} s/ ${formatMoney(t.baseMinor, doc)}`,
        amount: formatMoney(t.taxMinor, doc),
      })),
    { label: "TOTAL", amount: formatMoney(cart.ticket.totalMinor, doc), bold: true },
  ]
  const footer = [
    ctx.rate && totalRef !== null
      ? `Tasa BCV ${formatRate(ctx.rate.value)} · Ref. ${formatMoney(totalRef, ref)}`
      : null,
    "Precuenta: no es una factura",
  ].filter((t): t is string => t !== null)

  const print = async () => {
    if ((boot.data?.printer.mode ?? "browser") === "browser") {
      window.print()
      return
    }
    setPrinting(true)
    try {
      const body: PrintBillBody = {
        title: "PRECUENTA · NO FISCAL",
        info,
        items: cart.lines.map((l, i) => ({
          name: [l.name, ...(l.modifiers ?? []).map((m) => `+ ${m.name}`)].join(" "),
          detail: `${formatQty(l.qtyMilli)} × ${formatMoney(l.unitPriceMinor, doc)}`,
          amount: formatMoney(cart.ticket.lineTotals[i] ?? 0, doc),
        })),
        rows,
        footer,
      }
      await api("/api/print/bill", { body })
      toast.success("Precuenta impresa")
    } catch (e) {
      toast.error(`No se pudo imprimir: ${errorMessage(e)}`)
    } finally {
      setPrinting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Precuenta</DialogTitle>
        <DialogDescription>Lo que debe {tabLabel(tab)} hasta ahora.</DialogDescription>
        <div className="max-h-[60dvh] overflow-y-auto rounded-lg border bg-white p-4 text-black">
          <div
            id="receipt"
            className="mx-auto w-full max-w-[320px] font-mono text-[12px] leading-snug"
          >
            <div className="text-center">
              <BusinessHeader business={boot.data?.business} />
              <p className="mt-1">PRECUENTA · NO FISCAL</p>
              {info.map((t) => (
                <p key={t}>{t}</p>
              ))}
            </div>
            <hr className="my-2 border-dashed border-current" />
            {cart.lines.map((l, i) => (
              <div key={`${l.key}-${l.unitPriceMinor}`} className="mb-1">
                <p>{l.name}</p>
                {l.modifiers?.map((m) => (
                  <p key={m.id}>&nbsp;&nbsp;+ {m.name}</p>
                ))}
                <p className="flex justify-between">
                  <span>
                    {formatQty(l.qtyMilli)} × {formatMoney(l.unitPriceMinor, doc)}
                  </span>
                  <span>{formatMoney(cart.ticket.lineTotals[i] ?? 0, doc)}</span>
                </p>
              </div>
            ))}
            <hr className="my-2 border-dashed border-current" />
            {rows.map((r) => (
              <p key={r.label} className={cn("flex justify-between", r.bold ? "font-bold" : "")}>
                <span>{r.label}</span>
                <span>{r.amount}</span>
              </p>
            ))}
            {footer.map((t) => (
              <p key={t} className="mt-1 text-center">
                {t}
              </p>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
          <Button onClick={print} disabled={printing || cart.lines.length === 0}>
            <PrinterIcon /> {printing ? "Imprimiendo…" : "Imprimir"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Indicaciones para la cocina de un producto del pedido. */
export function NoteDialog({
  name,
  note,
  onSave,
  onClose,
}: {
  name: string
  note: string | null
  onSave: (note: string | null) => void
  onClose: () => void
}) {
  const [text, setText] = useState(note ?? "")
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <form
          className="grid grid-cols-1 gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            onSave(text.trim() || null)
          }}
        >
          <DialogHeader>
            <DialogTitle>{name}</DialogTitle>
            <DialogDescription>Indicaciones para la cocina.</DialogDescription>
          </DialogHeader>
          <Field label="Indicaciones" htmlFor="line-note">
            <Input
              id="line-note"
              autoFocus
              value={text}
              maxLength={140}
              onChange={(e) => setText(e.target.value)}
              placeholder="Sin cebolla, bien cocido…"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit">Listo</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
