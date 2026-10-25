import type { CatalogItem, TabDetail, TabLine } from "@millhiore/contracts"
import { lineTotal } from "@millhiore/domain"
import {
  Button,
  Card,
  cn,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  ArrowLeftIcon,
  ArrowRightLeftIcon,
  BanIcon,
  CheckIcon,
  ChefHatIcon,
  EllipsisIcon,
  MessageSquareIcon,
  MinusIcon,
  PlusIcon,
  ReceiptTextIcon,
  SendIcon,
  SplitIcon,
  UsersIcon,
  XCircleIcon,
} from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatMoney, formatPercent, formatQty, formatTime } from "../../lib/format"
import { bootstrapQuery, productsQuery, rateStatusQuery, tabQuery } from "../../lib/queries"
import { can, useFeatures, useMe } from "../../lib/session"
import { useTerminal } from "../../lib/terminal"
import { CatalogPanel } from "../pos/CatalogPanel"
import {
  autoCharges,
  buildCart,
  convertMinor,
  makeContext,
  type PosContext,
  unitPriceInDoc,
  unitWithModifiers,
} from "../pos/compute"
import { ModifierDialog, modifiersText } from "../pos/ModifierDialog"
import { QuantityDialog } from "../pos/QuantityDialog"
import { usePos } from "../pos/store"
import {
  BillDialog,
  CancelTabDialog,
  ChargePartDialog,
  MoveTabDialog,
  NoteDialog,
  refreshTab,
  TabInfoDialog,
  VoidLineDialog,
} from "./TabDialogs"
import {
  chargeLines,
  type DraftLine,
  elapsed,
  isPending,
  type Takes,
  tabLabel,
  useDrafts,
} from "./tab"

type Dialog =
  | { kind: "move" | "part" | "bill" | "info" | "cancel" }
  | { kind: "void"; line: TabLine }
  | { kind: "note"; line: DraftLine }
  | { kind: "modifiers"; item: CatalogItem }
  | { kind: "qty"; item: CatalogItem }

/**
 * La cuenta de una mesa: el catálogo para armar el pedido, lo que ya se pidió y lo que falta por
 * cobrar. El pedido nuevo se guarda en el equipo hasta enviarlo.
 */
export function TabPage({ tabId }: { tabId: string }) {
  const me = useMe()
  const features = useFeatures()
  const navigate = useNavigate()
  const boot = useQuery(bootstrapQuery)
  const rate = useQuery(rateStatusQuery)
  const products = useQuery(productsQuery())
  const tab = useQuery(tabQuery(tabId))
  const terminal = useTerminal()
  const draft = useDrafts((s) => s.drafts[tabId]) ?? []
  const { add, setQty, setNote, clear } = useDrafts()
  const loadTab = usePos((s) => s.loadTab)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [sending, setSending] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const ctx = useMemo(
    () => (boot.data ? makeContext(boot.data, rate.data?.current?.value ?? null) : null),
    [boot.data, rate.data],
  )
  const t = tab.data
  const pendingCart = useMemo(
    () =>
      ctx && t ? buildCart(ctx, chargeLines(t.lines).lines, null, null, autoCharges(ctx)) : null,
    [ctx, t],
  )

  if (tab.isError) {
    return (
      <div className="grid gap-3 p-6">
        <p className="text-muted-foreground">
          No se pudo abrir la cuenta: {errorMessage(tab.error)}
        </p>
        <Button asChild variant="outline" className="justify-self-start">
          <Link to="/mesas">Volver a las mesas</Link>
        </Button>
      </div>
    )
  }
  if (!t || !ctx || !pendingCart || !terminal) {
    return <p className="p-6 text-muted-foreground">Cargando la cuenta…</p>
  }
  const doc = ctx.docCurrency
  const ref = ctx.refCurrency
  const label = tabLabel(t)
  const open = t.status === "open"
  const pending = t.lines.filter(isPending)
  const draftCount = draft.reduce((acc, l) => acc + l.qtyMilli, 0)
  const total = pendingCart.ticket.totalMinor
  const totalRef = convertMinor(ctx, total, doc, ref)
  const canCharge = can(me, "sale.create") && pending.length > 0 && !pendingCart.missingRate
  const canServe = can(me, "table.serve")

  const send = async () => {
    if (!draft.length) return
    setSending(true)
    try {
      const updated = await api<TabDetail>(`/api/tabs/${t.id}/lines`, {
        body: {
          lines: draft.map((l) => ({
            id: l.id,
            variantId: l.variantId,
            qtyMilli: l.qtyMilli,
            note: l.note,
            ...(l.modifiers.length ? { modifierIds: l.modifiers.map((m) => m.id) } : {}),
          })),
        },
      })
      clear(t.id)
      await refreshTab(updated)
      toast.success("Pedido enviado")
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSending(false)
    }
  }

  const charge = (takes?: Takes) => {
    if (draft.length) {
      toast.error("Envía o borra el pedido nuevo antes de cobrar")
      return
    }
    const { lines, refs } = chargeLines(t.lines, takes)
    if (!refs.length) return
    loadTab({ id: t.id, number: t.number, label, lines: refs, waiterId: t.waiterId }, lines)
    void navigate({ to: "/caja" })
  }

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 lg:h-[calc(100dvh-5.5rem)] lg:grid-cols-[minmax(0,1fr)_420px] lg:pb-0",
        open ? "pb-20" : "",
      )}
    >
      {open && canServe ? (
        <CatalogPanel
          ctx={ctx}
          products={products.data}
          priceListId={null}
          locationId={terminal.locationId}
          onAdd={(item, qtyMilli) =>
            features.modifiers && item.modifierGroupIds.length
              ? setDialog({ kind: "modifiers", item })
              : qtyMilli === undefined && item.unit !== "unit"
                ? setDialog({ kind: "qty", item })
                : add(t.id, item, undefined, qtyMilli)
          }
          paused={dialog !== null}
        />
      ) : (
        <div className="hidden lg:block" />
      )}

      <Card
        ref={listRef}
        className="flex min-h-[420px] scroll-mt-20 flex-col overflow-hidden lg:min-h-0"
      >
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <Button asChild variant="ghost" size="icon-sm" aria-label="Volver a las mesas">
            <Link to="/mesas">
              <ArrowLeftIcon />
            </Link>
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold leading-tight">
              {label}
              {t.tableName && t.label ? (
                <span className="font-normal text-muted-foreground"> · {t.label}</span>
              ) : null}
            </h1>
            <p className="truncate text-muted-foreground text-xs">
              {t.number} · {elapsed(t.openedAt)}
              {t.guests ? ` · ${t.guests} personas` : ""}
              {t.waiterName ? ` · ${t.waiterName}` : ""}
            </p>
          </div>
          {open && canServe ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" aria-label="Más opciones">
                  <EllipsisIcon /> Más
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="grid w-56 gap-1 p-1.5">
                <PopoverClose asChild>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    onClick={() => setDialog({ kind: "move" })}
                  >
                    <ArrowRightLeftIcon /> Pasar a otra mesa
                  </Button>
                </PopoverClose>
                <PopoverClose asChild>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    onClick={() => setDialog({ kind: "info" })}
                  >
                    <UsersIcon /> Personas y nota
                  </Button>
                </PopoverClose>
                {pending.length === 0 || can(me, "sale.void") ? (
                  <PopoverClose asChild>
                    <Button
                      variant="ghost"
                      className="justify-start text-destructive"
                      onClick={() => setDialog({ kind: "cancel" })}
                    >
                      <XCircleIcon /> Anular la cuenta
                    </Button>
                  </PopoverClose>
                ) : null}
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
        {t.note ? (
          <p className="border-b bg-muted/40 px-4 py-1.5 text-muted-foreground text-sm">{t.note}</p>
        ) : null}
        {!open ? (
          <div className="border-b bg-muted/60 px-4 py-3 text-sm">
            {t.status === "closed" ? "Esta cuenta ya se cobró." : "Esta cuenta se anuló."}
            {t.cancelReason ? ` ${t.cancelReason}.` : ""}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {draft.length ? (
            <section aria-label="Pedido nuevo" className="border-b bg-primary/5">
              <h2 className="px-4 pt-2.5 font-medium text-primary text-xs uppercase tracking-wide">
                Pedido nuevo
              </h2>
              <ul className="divide-y">
                {draft.map((l) => (
                  <DraftRow
                    key={l.id}
                    ctx={ctx}
                    line={l}
                    onQty={(q) => setQty(t.id, l.id, q)}
                    onNote={() => setDialog({ kind: "note", line: l })}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {t.lines.length === 0 && draft.length === 0 ? (
            <p className="p-8 text-center text-muted-foreground text-sm">
              {open ? "Toca los productos para armar el pedido." : "No se pidió nada."}
            </p>
          ) : null}
          <ul className="divide-y">
            {t.lines.map((l) => (
              <SavedRow
                key={l.id}
                ctx={ctx}
                line={l}
                onVoid={
                  open && isPending(l) && can(me, "sale.void")
                    ? () => setDialog({ kind: "void", line: l })
                    : null
                }
              />
            ))}
          </ul>
        </div>

        <div className="grid grid-cols-1 gap-1.5 border-t bg-muted/40 px-4 py-3 text-sm">
          {pendingCart.ticket.charges.map((c) => (
            <div key={c.chargeId} className="flex justify-between text-muted-foreground">
              <span>
                {c.name}
                {c.kind === "percent" ? ` ${formatPercent(c.rateBp)}` : ""}
              </span>
              <span className="tabular">{formatMoney(c.amountMinor, doc)}</span>
            </div>
          ))}
          <div className="flex items-baseline justify-between">
            <span className="font-medium">Por cobrar</span>
            <span className="tabular font-bold text-2xl">{formatMoney(total, doc)}</span>
          </div>
          {ctx.rate && totalRef !== null ? (
            <div className="tabular text-right text-muted-foreground">
              ≈ {formatMoney(totalRef, ref)}
            </div>
          ) : null}
          {open && draft.length ? (
            <Button size="xl" className="mt-1 w-full" disabled={sending} onClick={send}>
              <SendIcon /> {sending ? "Enviando…" : `Enviar pedido (${formatQty(draftCount)})`}
            </Button>
          ) : null}
          {open ? (
            <div className="mt-1 grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                disabled={pending.length === 0}
                onClick={() => setDialog({ kind: "bill" })}
              >
                <ReceiptTextIcon /> Precuenta
              </Button>
              {can(me, "sale.create") ? (
                <Button
                  variant="outline"
                  disabled={!canCharge || pending.length === 0}
                  onClick={() => setDialog({ kind: "part" })}
                >
                  <SplitIcon /> Cobrar una parte
                </Button>
              ) : null}
              {can(me, "sale.create") ? (
                <Button
                  size="lg"
                  variant="success"
                  className="col-span-2"
                  disabled={!canCharge}
                  onClick={() => charge()}
                >
                  Cobrar la cuenta
                </Button>
              ) : null}
            </div>
          ) : (
            <Button asChild variant="outline" className="mt-1">
              <Link to="/mesas">Volver a las mesas</Link>
            </Button>
          )}
        </div>
      </Card>

      {/* En el celular la cuenta queda debajo del catálogo: el total y enviar, siempre a mano. */}
      {open ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 px-3 py-2.5 shadow-[0_-4px_12px_rgb(0_0_0/0.06)] backdrop-blur lg:hidden">
          <div className="mx-auto flex max-w-[1600px] items-center gap-3">
            <button
              type="button"
              className="grid min-w-0 cursor-pointer text-left"
              onClick={() => listRef.current?.scrollIntoView({ behavior: "smooth" })}
            >
              <span className="truncate text-muted-foreground text-xs">{label} · Ver cuenta</span>
              <span className="tabular font-bold text-xl leading-tight">
                {formatMoney(total, doc)}
              </span>
            </button>
            {draft.length ? (
              <Button size="lg" className="ml-auto" disabled={sending} onClick={send}>
                <SendIcon /> Enviar ({formatQty(draftCount)})
              </Button>
            ) : can(me, "sale.create") ? (
              <Button
                size="lg"
                variant="success"
                className="ml-auto"
                disabled={!canCharge}
                onClick={() => charge()}
              >
                Cobrar
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {dialog?.kind === "move" ? (
        <MoveTabDialog
          tab={t}
          onClose={() => setDialog(null)}
          onMoved={(target) => {
            setDialog(null)
            if (target.id !== t.id)
              void navigate({ to: "/mesas/$tabId", params: { tabId: target.id } })
          }}
        />
      ) : null}
      {dialog?.kind === "part" ? (
        <ChargePartDialog
          ctx={ctx}
          tab={t}
          onClose={() => setDialog(null)}
          onCharge={(takes) => {
            setDialog(null)
            charge(takes)
          }}
        />
      ) : null}
      {dialog?.kind === "bill" ? (
        <BillDialog ctx={ctx} tab={t} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "info" ? <TabInfoDialog tab={t} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "cancel" ? (
        <CancelTabDialog
          tab={t}
          onClose={() => setDialog(null)}
          onCancelled={() => {
            setDialog(null)
            clear(t.id)
            void navigate({ to: "/mesas" })
          }}
        />
      ) : null}
      {dialog?.kind === "void" ? (
        <VoidLineDialog tab={t} line={dialog.line} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "qty" ? (
        <QuantityDialog
          item={dialog.item}
          ctx={ctx}
          unitPriceMinor={unitPriceInDoc(ctx, dialog.item.priceMinor, dialog.item.priceCurrency)}
          onClose={() => setDialog(null)}
          onConfirm={(qtyMilli) => {
            add(t.id, dialog.item, undefined, qtyMilli)
            setDialog(null)
          }}
        />
      ) : null}
      {dialog?.kind === "modifiers" && boot.data ? (
        <ModifierDialog
          item={dialog.item}
          groups={boot.data.modifierGroups}
          ctx={ctx}
          onClose={() => setDialog(null)}
          onConfirm={(extras) => {
            add(t.id, dialog.item, extras)
            setDialog(null)
          }}
        />
      ) : null}
      {dialog?.kind === "note" ? (
        <NoteDialog
          name={dialog.line.name}
          note={dialog.line.note}
          onClose={() => setDialog(null)}
          onSave={(note) => {
            setNote(t.id, dialog.line.id, note)
            setDialog(null)
          }}
        />
      ) : null}
    </div>
  )
}

/** Un producto del pedido nuevo: cantidad e indicaciones, todavía se puede cambiar. */
function DraftRow({
  ctx,
  line,
  onQty,
  onNote,
}: {
  ctx: PosContext
  line: DraftLine
  onQty: (qtyMilli: number) => void
  onNote: () => void
}) {
  const unit = unitWithModifiers(ctx, line.priceMinor, line.priceCurrency, line.modifiers)
  const chosen = modifiersText(line.modifiers)
  return (
    <li className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 px-4 py-2">
      <span className="min-w-0 font-medium leading-tight">
        {line.name}
        {chosen ? (
          <span className="block font-normal text-muted-foreground text-xs">{chosen}</span>
        ) : null}
        {line.note ? (
          <span className="block font-normal text-muted-foreground text-xs italic">
            {line.note}
          </span>
        ) : null}
      </span>
      <span className="tabular text-right font-semibold">
        {unit === null ? "—" : formatMoney(lineTotal(line.qtyMilli, unit), ctx.docCurrency)}
      </span>
      <span className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onQty(line.qtyMilli - 1000)}
          aria-label={`Quitar uno de ${line.name}`}
        >
          <MinusIcon />
        </Button>
        <span className="tabular w-10 text-center text-sm">{formatQty(line.qtyMilli)}</span>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onQty(line.qtyMilli + 1000)}
          aria-label={`Agregar uno de ${line.name}`}
        >
          <PlusIcon />
        </Button>
      </span>
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          "justify-self-end px-2",
          line.note ? "text-primary" : "text-muted-foreground",
        )}
        onClick={onNote}
        aria-label={`Indicaciones para ${line.name}`}
      >
        <MessageSquareIcon /> {line.note ? "Cambiar" : "Indicaciones"}
      </Button>
    </li>
  )
}

/** Lo ya pedido: pendiente, cobrado (con su venta) o anulado (tachado, con el motivo). */
function SavedRow({
  ctx,
  line,
  onVoid,
}: {
  ctx: PosContext
  line: TabLine
  onVoid: (() => void) | null
}) {
  const unit = unitWithModifiers(ctx, line.priceMinor, line.priceCurrency, line.modifiers)
  const chosen = modifiersText(line.modifiers)
  const voided = line.voidedAt !== null
  const paid = line.documentId !== null
  return (
    <li
      className={cn(
        "grid grid-cols-[auto_1fr_auto] items-start gap-x-2 px-4 py-2 text-sm",
        voided || paid ? "text-muted-foreground" : "",
      )}
    >
      <span className="tabular w-8 font-medium">{formatQty(line.qtyMilli)}</span>
      <span className="min-w-0">
        <span className={cn("block leading-tight", voided ? "line-through" : "font-medium")}>
          {line.name}
        </span>
        {chosen ? <span className="block text-xs">{chosen}</span> : null}
        {line.note ? <span className="block text-xs italic">{line.note}</span> : null}
        <span className="block text-muted-foreground text-xs">
          {formatTime(line.addedAt)}
          {line.addedBy ? ` · ${line.addedBy}` : ""}
          {voided ? ` · anulado: ${line.voidReason ?? ""}` : ""}
          {paid ? ` · cobrado en ${line.documentNumber ?? ""}` : ""}
        </span>
        {line.kitchen && !voided && !paid ? (
          <span
            className={cn(
              "mt-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-xs",
              line.kitchen === "ready"
                ? "bg-success/15 text-success"
                : "bg-muted text-muted-foreground",
            )}
          >
            {line.kitchen === "ready" ? (
              <CheckIcon className="size-3" />
            ) : (
              <ChefHatIcon className="size-3" />
            )}
            {line.kitchen === "ready" ? "Listo en la cocina" : "En la cocina"}
          </span>
        ) : null}
      </span>
      <span className="flex items-center gap-1">
        <span className={cn("tabular", voided ? "line-through" : "")}>
          {unit === null ? "—" : formatMoney(lineTotal(line.qtyMilli, unit), ctx.docCurrency)}
        </span>
        {onVoid ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={`Anular ${line.name}`}
            title="Anular"
            onClick={onVoid}
          >
            <BanIcon />
          </Button>
        ) : null}
      </span>
    </li>
  )
}
