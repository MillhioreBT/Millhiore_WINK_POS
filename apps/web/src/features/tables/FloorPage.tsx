import type { TabDetail, TabSummary } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
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
import { useNavigate } from "@tanstack/react-router"
import { ClockIcon, PencilIcon, PlusIcon, UsersIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { ApiError, api, errorMessage } from "../../lib/api"
import { formatMoney } from "../../lib/format"
import { bootstrapQuery, diningQuery, queryClient, rateStatusQuery } from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { convertMinor, makeContext, type PosContext } from "../pos/compute"
import { LayoutDialog } from "./LayoutDialog"
import { elapsed, tabLabel, tableName } from "./tab"

/** Lo que debe la cuenta en la moneda del documento (Bs) y en la de referencia; null sin tasa. */
export function pendingTotal(ctx: PosContext, t: Pick<TabSummary, "pending">) {
  let doc = 0
  for (const p of t.pending) {
    const minor = convertMinor(ctx, p.amountMinor, p.currency, ctx.docCurrency)
    if (minor === null) return null
    doc += minor
  }
  return { doc, ref: convertMinor(ctx, doc, ctx.docCurrency, ctx.refCurrency) }
}

/**
 * El plano del restaurante: cada sala con sus mesas, libres u ocupadas (con lo que deben y desde
 * cuándo), y las cuentas sin mesa. Se actualiza solo cuando otro equipo abre o cobra una mesa.
 */
export function FloorPage() {
  const me = useMe()
  const navigate = useNavigate()
  const boot = useQuery(bootstrapQuery)
  const rate = useQuery(rateStatusQuery)
  const floor = useQuery(diningQuery)
  const [editing, setEditing] = useState(false)
  const [naming, setNaming] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const ctx = useMemo(
    () => (boot.data ? makeContext(boot.data, rate.data?.current?.value ?? null) : null),
    [boot.data, rate.data],
  )
  const canEdit = can(me, "settings.manage")
  const canServe = can(me, "table.serve")

  const openTable = async (tableId: string) => {
    setOpening(tableId)
    try {
      const tab = await api<TabDetail>("/api/tabs", { body: { id: uuidv7(), tableId } })
      await queryClient.invalidateQueries({ queryKey: ["dining"] })
      void navigate({ to: "/mesas/$tabId", params: { tabId: tab.id } })
    } catch (e) {
      // Otro mesonero la abrió en ese momento: se ve su cuenta.
      if (e instanceof ApiError && e.code === "TABLE_BUSY") {
        const fresh = await queryClient.fetchQuery(diningQuery)
        const busy = fresh.areas.flatMap((a) => a.tables).find((t) => t.id === tableId)?.tab
        if (busy) {
          void navigate({ to: "/mesas/$tabId", params: { tabId: busy.id } })
          return
        }
      }
      toast.error(errorMessage(e))
    } finally {
      setOpening(null)
    }
  }

  if (!floor.data || !ctx) return <p className="p-6 text-muted-foreground">Cargando las mesas…</p>
  const data = floor.data
  const empty = data.areas.every((a) => a.tables.length === 0)

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-semibold text-xl">Mesas</h1>
        <span className="flex flex-wrap gap-2">
          {canServe ? (
            <Button variant="outline" onClick={() => setNaming(true)}>
              <PlusIcon /> Cuenta sin mesa
            </Button>
          ) : null}
          {canEdit ? (
            <Button variant="outline" onClick={() => setEditing(true)}>
              <PencilIcon /> Editar mesas
            </Button>
          ) : null}
        </span>
      </div>

      {empty ? (
        <div className="grid place-items-center gap-2 rounded-xl border border-dashed p-10 text-center text-muted-foreground">
          <p>Aún no hay mesas.</p>
          {canEdit ? (
            <Button variant="outline" onClick={() => setEditing(true)}>
              Armar las salas y mesas
            </Button>
          ) : (
            <p className="text-sm">Pídele al dueño que las arme en Ajustes.</p>
          )}
        </div>
      ) : null}

      {data.areas
        .filter((a) => a.tables.length)
        .map((area) => (
          <section key={area.id} className="grid grid-cols-1 gap-2" aria-label={area.name}>
            {data.areas.length > 1 ? (
              <h2 className="font-medium text-muted-foreground text-sm">{area.name}</h2>
            ) : null}
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-7">
              {area.tables.map((t) => (
                <TableCard
                  key={t.id}
                  ctx={ctx}
                  name={t.name}
                  seats={t.seats}
                  tab={t.tab}
                  busy={opening === t.id}
                  disabled={!t.tab && !canServe}
                  onClick={() =>
                    t.tab
                      ? void navigate({ to: "/mesas/$tabId", params: { tabId: t.tab.id } })
                      : void openTable(t.id)
                  }
                />
              ))}
            </div>
          </section>
        ))}

      {data.others.length ? (
        <section className="grid grid-cols-1 gap-2" aria-label="Sin mesa">
          <h2 className="font-medium text-muted-foreground text-sm">Sin mesa</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {data.others.map((t) => (
              <TableCard
                key={t.id}
                ctx={ctx}
                name={tabLabel(t)}
                seats={null}
                tab={t}
                busy={false}
                disabled={false}
                onClick={() => void navigate({ to: "/mesas/$tabId", params: { tabId: t.id } })}
              />
            ))}
          </div>
        </section>
      ) : null}

      {editing ? <LayoutDialog floor={data} onClose={() => setEditing(false)} /> : null}
      {naming ? (
        <NewTabDialog
          onClose={() => setNaming(false)}
          onOpened={(id) => void navigate({ to: "/mesas/$tabId", params: { tabId: id } })}
        />
      ) : null}
    </div>
  )
}

function TableCard({
  ctx,
  name,
  seats,
  tab,
  busy,
  disabled,
  onClick,
}: {
  ctx: PosContext
  name: string
  seats: number | null
  tab: TabSummary | null
  busy: boolean
  disabled: boolean
  onClick: () => void
}) {
  const total = tab ? pendingTotal(ctx, tab) : null
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      aria-label={`${tableName(name)}, ${tab ? "ocupada" : "libre"}`}
      className={cn(
        "flex min-h-24 min-w-0 cursor-pointer flex-col justify-between gap-1 rounded-xl border p-2.5 text-left shadow-xs transition-colors active:scale-[0.99] disabled:cursor-default disabled:opacity-60",
        tab
          ? "border-primary/60 bg-primary/10 hover:bg-primary/15"
          : "border-dashed bg-card hover:border-primary hover:bg-accent/50",
      )}
    >
      <span className="flex items-start justify-between gap-1">
        <span className="truncate font-semibold text-lg leading-tight">{name}</span>
        {tab?.guests ? (
          <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground text-xs">
            <UsersIcon className="size-3" />
            {tab.guests}
          </span>
        ) : null}
      </span>
      {tab ? (
        <span className="grid min-w-0 text-xs">
          <span className="tabular truncate font-semibold text-sm">
            {total ? formatMoney(total.doc, ctx.docCurrency) : "—"}
          </span>
          {total?.ref != null && ctx.refCurrency !== ctx.docCurrency ? (
            <span className="tabular truncate text-muted-foreground">
              {formatMoney(total.ref, ctx.refCurrency)}
            </span>
          ) : null}
          <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
            <ClockIcon className="size-3 shrink-0" />
            <span className="truncate">
              {elapsed(tab.openedAt)}
              {tab.waiterName ? ` · ${tab.waiterName.split(" ")[0]}` : ""}
            </span>
          </span>
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">
          {busy ? "Abriendo…" : "Libre"}
          {seats ? ` · ${seats} puestos` : ""}
        </span>
      )}
    </button>
  )
}

/** Cuenta para la barra o para llevar: solo hace falta un nombre. */
function NewTabDialog({
  onClose,
  onOpened,
}: {
  onClose: () => void
  onOpened: (id: string) => void
}) {
  const [label, setLabel] = useState("")
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!label.trim()) return
    setBusy(true)
    try {
      const tab = await api<TabDetail>("/api/tabs", { body: { id: uuidv7(), label: label.trim() } })
      await queryClient.invalidateQueries({ queryKey: ["dining"] })
      onClose()
      onOpened(tab.id)
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
            <DialogTitle>Cuenta sin mesa</DialogTitle>
            <DialogDescription>
              Para la barra, para llevar o un cliente que espera.
            </DialogDescription>
          </DialogHeader>
          <Field label="Nombre" htmlFor="tab-label">
            <Input
              id="tab-label"
              autoFocus
              value={label}
              maxLength={40}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Juan, Para llevar 3…"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || !label.trim()}>
              Abrir la cuenta
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
