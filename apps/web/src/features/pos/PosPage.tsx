import type { CatalogItem } from "@millhiore/contracts"
import { lineTotal } from "@millhiore/domain"
import {
  Button,
  Card,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  ArchiveIcon,
  ArrowLeftRightIcon,
  CheckIcon,
  ClockIcon,
  FileTextIcon,
  LockKeyholeIcon,
  MinusIcon,
  PauseIcon,
  PencilIcon,
  PercentIcon,
  PlayIcon,
  PlusIcon,
  ShoppingCartIcon,
  SquareMenuIcon,
  TicketPercentIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { TerminalPicker } from "../../components/TerminalPicker"
import { formatMoney, formatPercent, formatQty, formatTime } from "../../lib/format"
import { stockAt } from "../../lib/locations"
import { openDrawer } from "../../lib/printing"
import {
  bootstrapQuery,
  currentShiftQuery,
  productsQuery,
  rateStatusQuery,
} from "../../lib/queries"
import { can, useFeatures, useMe } from "../../lib/session"
import { useTerminal } from "../../lib/terminal"
import { QuoteDialog } from "../quotes/QuoteDialog"
import { SaveQuoteDialog } from "../quotes/SaveQuoteDialog"
import { ReceiptDialog } from "../sales/ReceiptDialog"
import { CashMoveDialog, CloseShiftDialog, OpenShiftCard } from "../shifts/ShiftDialogs"
import { CatalogPanel, finePointer } from "./CatalogPanel"
import { ChargeAmountDialog } from "./ChargeAmountDialog"
import { CheckoutDialog } from "./CheckoutDialog"
import {
  autoCharges,
  buildCart,
  type CartLine,
  convertMinor,
  type DiscountSpec,
  lineKey,
  makeContext,
  type PosContext,
} from "./compute"
import { DiscountCodeDialog } from "./DiscountCodeDialog"
import { DiscountDialog } from "./DiscountDialog"
import { ModifierDialog, modifiersText } from "./ModifierDialog"
import { type HeldTicket, type TicketLine, usePos } from "./store"

/** Ventas aparcadas: cuánto suman hoy y con qué productos, para retomarlas o descartarlas. */
function HeldDialog({ ctx, onClose }: { ctx: PosContext; onClose: () => void }) {
  const { held, resume, discardHeld, lines } = usePos()
  const total = (t: HeldTicket) =>
    buildCart(
      ctx,
      t.lines,
      t.saleDiscount ?? null,
      t.priceListId ?? null,
      t.charges ?? autoCharges(ctx),
    ).ticket.totalMinor
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ventas en espera</DialogTitle>
          <DialogDescription>
            {lines.length
              ? "Al retomar una, la venta actual pasa a espera."
              : "Retoma la del cliente que volvió."}
          </DialogDescription>
        </DialogHeader>
        {held.length === 0 ? (
          <p className="text-muted-foreground text-sm">No hay ventas en espera.</p>
        ) : (
          <ul className="grid gap-2">
            {held.map((t) => (
              <li key={t.saleId} className="grid gap-2 rounded-lg border p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-muted-foreground text-sm">
                    Desde las {formatTime(t.heldAt)}
                  </span>
                  <span className="tabular font-semibold">
                    {formatMoney(total(t), ctx.docCurrency)}
                  </span>
                </div>
                <p className="line-clamp-2 text-sm">
                  {t.lines.map((l) => `${formatQty(l.qtyMilli)} × ${l.name}`).join(" · ")}
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => discardHeld(t.saleId)}>
                    Descartar
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      resume(t.saleId)
                      onClose()
                    }}
                  >
                    <PlayIcon /> Retomar
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function PosPage() {
  const me = useMe()
  const boot = useQuery(bootstrapQuery)
  const rate = useQuery(rateStatusQuery)
  const products = useQuery(productsQuery())
  const {
    lines,
    add,
    setQty,
    remove,
    reset,
    saleId,
    held,
    hold,
    saleDiscount,
    setLineDiscount,
    setSaleDiscount,
    priceListId,
    setPriceList,
    charges: chosenCharges,
    setCharges,
    quote,
    detachQuote,
    tab,
  } = usePos()
  const navigate = useNavigate()
  // Tras cobrar una mesa, al cerrar el recibo se vuelve a las mesas.
  const [backToTables, setBackToTables] = useState(false)
  const [savingQuote, setSavingQuote] = useState(false)
  const [quoteShown, setQuoteShown] = useState<string | null>(null)
  const [editingCharge, setEditingCharge] = useState<string | null>(null)
  const canDiscount = can(me, "sale.discount")
  // El de un código lo usa cualquiera; uno a mano, solo quien puede dar descuentos.
  const saleDiscountUsed = saleDiscount?.code || canDiscount ? saleDiscount : null
  const [askingCode, setAskingCode] = useState(false)
  const features = useFeatures()
  const [discountFor, setDiscountFor] = useState<{ key: string | null } | null>(null)
  // Producto con opciones y extras: se eligen antes de agregarlo.
  const [choosing, setChoosing] = useState<CatalogItem | null>(null)
  const [heldOpen, setHeldOpen] = useState(false)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [receiptId, setReceiptId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<"cash" | "close" | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const ticketRef = useRef<HTMLDivElement>(null)
  const terminal = useTerminal()
  const terminalId = terminal?.id
  const shift = useQuery({ ...currentShiftQuery(terminalId ?? ""), enabled: !!terminalId })

  const ctx = useMemo(
    () => (boot.data ? makeContext(boot.data, rate.data?.current?.value ?? null) : null),
    [boot.data, rate.data],
  )

  // Recargos de la venta: los elegidos o, si no se ha tocado nada, los que se agregan solos.
  const activeCharges = useMemo(
    () => chosenCharges ?? (ctx ? autoCharges(ctx) : []),
    [chosenCharges, ctx],
  )
  // Ticket en Bs con la tasa vigente. Una línea sin precio convertible bloquea el cobro.
  const cart = useMemo(
    () => (ctx ? buildCart(ctx, lines, saleDiscountUsed, priceListId, activeCharges) : null),
    [ctx, lines, saleDiscountUsed, priceListId, activeCharges],
  )
  const toggleCharge = (chargeId: string) =>
    setCharges(
      activeCharges.some((c) => c.chargeId === chargeId)
        ? activeCharges.filter((c) => c.chargeId !== chargeId)
        : [...activeCharges, { chargeId }],
    )

  const canCharge =
    cart !== null && cart.lines.length > 0 && !cart.missingRate && cart.ticket.totalMinor > 0

  // F12 cobra.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F12" && canCharge) {
        e.preventDefault()
        setCheckoutOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [canCharge])

  const addItem = (item: CatalogItem) => {
    // Lo de una mesa se pide en la mesa: aquí solo se cobra.
    if (tab) {
      toast.info(`Para agregar productos, vuelve a ${tab.label}`)
      return
    }
    const expired = terminal && item.expiry?.expiredByLocation[terminal.locationId]
    if (terminal && expired && stockAt(item, terminal.locationId) - expired <= 0) {
      toast.warning(`Lo que queda de ${item.name} está vencido: revisa antes de venderlo`)
    }
    if (features.modifiers && item.modifierGroupIds.length) setChoosing(item)
    else add(item)
  }

  if (!ctx || !cart || !boot.data || !terminal || !terminalId || shift.isPending) {
    return <p className="p-6 text-muted-foreground">Cargando la caja…</p>
  }
  if (!shift.data) {
    return (
      <OpenShiftCard boot={boot.data} terminalId={terminalId} canOpen={can(me, "shift.manage")} />
    )
  }
  const openShift = shift.data
  const doc = ctx.docCurrency
  const ref = ctx.refCurrency
  const toRef = (minor: number) => convertMinor(ctx, minor, doc, ref)
  const busy =
    checkoutOpen || dialog !== null || receiptId !== null || heldOpen || choosing !== null

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 lg:h-[calc(100dvh-5.5rem)] lg:grid-cols-[minmax(0,1fr)_420px] lg:pb-0",
        cart.lines.length ? "pb-20" : "",
      )}
    >
      {/* Catálogo */}
      <CatalogPanel
        ctx={ctx}
        products={products.data}
        priceListId={priceListId}
        locationId={terminal.locationId}
        onAdd={addItem}
        paused={busy}
        searchRef={searchRef}
        banner={
          !ctx.rate ? (
            <div className="flex items-center gap-2 rounded-lg border border-warning/50 bg-warning/15 p-3 text-sm">
              <TriangleAlertIcon className="size-4 shrink-0" />
              No hay tasa del día: no se pueden convertir precios en divisas.
              {can(me, "rate.manage") ? (
                <Link to="/ajustes" className="font-medium underline">
                  Cargar tasa
                </Link>
              ) : null}
            </div>
          ) : null
        }
      />

      {/* Ticket */}
      <Card
        ref={ticketRef}
        className="flex min-h-[420px] scroll-mt-20 flex-col overflow-hidden lg:min-h-0"
      >
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs">
          <TerminalPicker boot={boot.data} id="pos-terminal" className="h-7 py-0 text-xs" />
          <span className="text-muted-foreground">
            Turno desde {formatTime(openShift.openedAt)}
            {openShift.openedBy ? ` · ${openShift.openedBy}` : ""}
          </span>
          {can(me, "shift.manage") ? (
            <span className="ml-auto flex flex-wrap justify-end gap-1">
              {boot.data.printer.mode !== "browser" ? (
                <Button variant="ghost" size="sm" onClick={() => void openDrawer()}>
                  <ArchiveIcon /> Gaveta
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => setDialog("cash")}>
                <ArrowLeftRightIcon /> Ingreso/retiro
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDialog("close")}>
                <LockKeyholeIcon /> Cerrar turno
              </Button>
            </span>
          ) : null}
        </div>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="flex items-center gap-2 font-semibold">
            <ShoppingCartIcon className="size-5" /> Venta
          </h2>
          <span className="flex flex-wrap justify-end gap-1">
            {held.length ? (
              <Button variant="outline" size="sm" onClick={() => setHeldOpen(true)}>
                <ClockIcon /> En espera ({held.length})
              </Button>
            ) : null}
            {lines.length ? (
              <>
                {features.quotes && !tab && !lines.some((l) => l.modifiers?.length) ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSavingQuote(true)}
                    title="Guarda esta venta como cotización para el cliente"
                    disabled={cart.missingRate}
                  >
                    <FileTextIcon /> Cotizar
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    hold()
                    toast.success("Venta en espera: puedes atender a otro cliente")
                  }}
                  title="Aparca esta venta para atender a otro cliente"
                >
                  <PauseIcon /> Esperar
                </Button>
                <Button variant="ghost" size="sm" onClick={reset}>
                  Vaciar
                </Button>
              </>
            ) : null}
          </span>
        </div>
        {quote ? (
          <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2 text-sm">
            <FileTextIcon className="size-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              Cotización <span className="font-medium">{quote.number}</span>
              {quote.contact ? ` · ${quote.contact.name}` : ""}
              {quote.validUntil < Date.now() ? (
                <span className="block text-warning-foreground text-xs dark:text-warning">
                  Vencida: se venden los precios cotizados
                </span>
              ) : null}
            </span>
            <Button variant="ghost" size="sm" onClick={detachQuote}>
              Quitar
            </Button>
          </div>
        ) : null}
        {tab ? (
          <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2 text-sm">
            <SquareMenuIcon className="size-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              Cobrando <span className="font-medium">{tab.label}</span> · {tab.number}
              <span className="block text-muted-foreground text-xs">
                Lo que se pide se agrega en la mesa
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                reset()
                void navigate({ to: "/mesas/$tabId", params: { tabId: tab.id } })
              }}
            >
              Volver a la mesa
            </Button>
          </div>
        ) : null}
        {ctx.priceLists.size && !quote && !tab ? (
          <div className="flex items-center gap-2 border-b px-4 py-2 text-sm">
            <label htmlFor="pos-price-list" className="text-muted-foreground">
              Precios
            </label>
            <NativeSelect
              id="pos-price-list"
              value={priceListId && ctx.priceLists.has(priceListId) ? priceListId : ""}
              onChange={(e) => setPriceList(e.target.value || null)}
              className="h-8 w-auto min-w-40 py-1"
            >
              <option value="">Normales</option>
              {[...ctx.priceLists.values()].map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
          {cart.lines.length === 0 ? (
            <li className="p-8 text-center text-muted-foreground text-sm">
              Toca un producto o escanea su código para agregarlo.
            </li>
          ) : null}
          {cart.lines.map((l, i) => (
            <li
              key={`${l.key}-${l.unitPriceMinor}`}
              className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 px-4 py-2.5"
            >
              <span className="min-w-0 font-medium leading-tight">
                {l.name}
                {modifiersText(l.modifiers, l.note) ? (
                  <span className="block font-normal text-muted-foreground text-xs">
                    {modifiersText(l.modifiers, l.note)}
                  </span>
                ) : null}
              </span>
              <span className="tabular text-right font-semibold">
                {formatMoney(cart.ticket.lineTotals[i] ?? 0, doc)}
                {l.discountMinor ? (
                  <span className="block font-normal text-success text-xs">
                    -{formatMoney(l.discountMinor, doc)}
                  </span>
                ) : null}
              </span>
              <span className="flex items-center gap-1">
                {tab ? (
                  <span className="tabular text-sm">{formatQty(l.qtyMilli)}</span>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      onClick={() => setQty(lineKey(l), l.qtyMilli - 1000)}
                      aria-label={`Quitar uno de ${l.name}`}
                    >
                      <MinusIcon />
                    </Button>
                    <span className="tabular w-10 text-center text-sm">
                      {formatQty(l.qtyMilli)}
                    </span>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      onClick={() => setQty(lineKey(l), l.qtyMilli + 1000)}
                      aria-label={`Agregar uno de ${l.name}`}
                    >
                      <PlusIcon />
                    </Button>
                  </>
                )}
                <span className="tabular ml-2 text-muted-foreground text-xs">
                  × {formatMoney(l.unitPriceMinor, doc)}
                </span>
              </span>
              <span className="flex justify-self-end">
                {canDiscount ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={lines[i]?.discount ? "text-success" : "text-muted-foreground"}
                    onClick={() => setDiscountFor({ key: lineKey(l) })}
                    aria-label={`Descuento a ${l.name}`}
                    title="Descuento a este producto"
                  >
                    <PercentIcon />
                  </Button>
                ) : null}
                {tab ? null : (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    onClick={() => remove(lineKey(l))}
                    aria-label={`Eliminar ${l.name}`}
                  >
                    <Trash2Icon />
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-1 gap-1.5 border-t bg-muted/40 px-4 py-3 text-sm">
          {cart.ticket.taxes
            .filter((t) => t.taxMinor !== 0)
            .map((t) => (
              <div
                key={`${t.taxId}-${t.rateBp}`}
                className="flex justify-between text-muted-foreground"
              >
                <span>
                  Base {formatPercent(t.rateBp)} {formatMoney(t.baseMinor, doc)} · IVA
                </span>
                <span className="tabular">{formatMoney(t.taxMinor, doc)}</span>
              </div>
            ))}
          {ctx.charges.size && cart.lines.length ? (
            <fieldset className="flex min-w-0 flex-wrap gap-1.5">
              <legend className="sr-only">Recargos</legend>
              {[...ctx.charges.values()].map((c) => {
                const on = activeCharges.some((a) => a.chargeId === c.id)
                return (
                  <Button
                    key={c.id}
                    variant={on ? "secondary" : "outline"}
                    size="sm"
                    className="h-7 rounded-full px-2.5 text-xs"
                    aria-pressed={on}
                    onClick={() => toggleCharge(c.id)}
                  >
                    {on ? <CheckIcon /> : <PlusIcon />} {c.name}
                    {c.kind === "percent" ? ` ${formatPercent(c.rateBp)}` : ""}
                  </Button>
                )
              })}
            </fieldset>
          ) : null}
          {cart.ticket.charges.map((c) => (
            <div key={c.chargeId} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1">
                {c.name}
                {c.kind === "percent" ? ` ${formatPercent(c.rateBp)}` : ""}
                {c.kind === "fixed" ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-6 text-muted-foreground"
                    aria-label={`Cambiar el monto de ${c.name}`}
                    title="Cambiar el monto"
                    onClick={() => setEditingCharge(c.chargeId)}
                  >
                    <PencilIcon />
                  </Button>
                ) : null}
              </span>
              <span className="tabular">{formatMoney(c.amountMinor, doc)}</span>
            </div>
          ))}
          {cart.ticket.discountMinor > 0 ? (
            <div className="flex justify-between text-success">
              <span>Descuentos</span>
              <span className="tabular">-{formatMoney(cart.ticket.discountMinor, doc)}</span>
            </div>
          ) : null}
          {saleDiscount?.code && cart.lines.length ? (
            <div className="flex items-center justify-between gap-2 text-success">
              <span className="flex items-center gap-1">
                <TicketPercentIcon className="size-4" /> Código {saleDiscount.code.code}
                {saleDiscount.kind === "percent" ? ` (${formatPercent(saleDiscount.bp)})` : ""}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6 text-muted-foreground"
                aria-label={`Quitar el código ${saleDiscount.code.code}`}
                title="Quitar el código"
                onClick={() => setSaleDiscount(null)}
              >
                <XIcon />
              </Button>
            </div>
          ) : null}
          {cart.lines.length &&
          (canDiscount || (boot.data.discountCodes > 0 && !saleDiscount?.code)) ? (
            <span className="flex flex-wrap gap-1">
              {canDiscount ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-2 text-muted-foreground"
                  onClick={() => setDiscountFor({ key: null })}
                >
                  <PercentIcon />{" "}
                  {saleDiscount && !saleDiscount.code
                    ? "Cambiar el descuento de la venta"
                    : "Descuento a toda la venta"}
                </Button>
              ) : null}
              {boot.data.discountCodes > 0 && !saleDiscount?.code ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-2 text-muted-foreground"
                  onClick={() => setAskingCode(true)}
                >
                  <TicketPercentIcon /> Código de descuento
                </Button>
              ) : null}
            </span>
          ) : null}
          <div className="flex items-baseline justify-between">
            <span className="font-medium">Total</span>
            <span className="tabular font-bold text-2xl">
              {formatMoney(cart.ticket.totalMinor, doc)}
            </span>
          </div>
          {ctx.rate ? (
            <div className="tabular text-right text-muted-foreground">
              ≈ {formatMoney(toRef(cart.ticket.totalMinor) ?? 0, ref)}
            </div>
          ) : null}
          <Button
            size="xl"
            variant="success"
            className={cn("mt-2 w-full")}
            disabled={!canCharge || !terminalId}
            onClick={() => setCheckoutOpen(true)}
          >
            Cobrar <span className="hidden lg:inline">(F12)</span>
          </Button>
        </div>
      </Card>

      {askingCode ? (
        <DiscountCodeDialog
          onApply={(spec) => {
            setSaleDiscount(spec)
            setAskingCode(false)
            toast.success(`Código ${spec.code?.code} aplicado`)
          }}
          onClose={() => setAskingCode(false)}
        />
      ) : null}
      {checkoutOpen && terminalId ? (
        <CheckoutDialog
          ctx={ctx}
          lines={cart.lines}
          ticket={cart.ticket}
          saleId={saleId}
          terminalId={terminalId}
          onClose={() => setCheckoutOpen(false)}
          onPosted={(id) => {
            setCheckoutOpen(false)
            setBackToTables(tab !== null)
            reset()
            setReceiptId(id)
          }}
        />
      ) : null}
      {dialog === "cash" ? (
        <CashMoveDialog boot={boot.data} terminalId={terminalId} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "close" ? (
        <CloseShiftDialog boot={boot.data} shift={openShift} onClose={() => setDialog(null)} />
      ) : null}
      {heldOpen ? <HeldDialog ctx={ctx} onClose={() => setHeldOpen(false)} /> : null}
      {savingQuote ? (
        <SaveQuoteDialog
          ctx={ctx}
          lines={lines}
          ticket={cart.ticket}
          priceListId={priceListId}
          saleDiscount={saleDiscountUsed}
          charges={activeCharges}
          initialContact={quote?.contact ?? null}
          onClose={() => setSavingQuote(false)}
          onSaved={(saved) => {
            setSavingQuote(false)
            reset()
            setQuoteShown(saved.id)
          }}
        />
      ) : null}
      {quoteShown ? <QuoteDialog quoteId={quoteShown} onClose={() => setQuoteShown(null)} /> : null}
      {editingCharge ? (
        <ChargeAmountDialog
          ctx={ctx}
          chargeId={editingCharge}
          current={activeCharges.find((c) => c.chargeId === editingCharge)?.amount}
          onApply={(amount) => {
            setCharges(
              activeCharges.map((c) =>
                c.chargeId === editingCharge ? { chargeId: c.chargeId, amount } : c,
              ),
            )
            setEditingCharge(null)
          }}
          onClose={() => setEditingCharge(null)}
        />
      ) : null}
      {choosing ? (
        <ModifierDialog
          item={choosing}
          groups={boot.data.modifierGroups}
          ctx={ctx}
          onClose={() => setChoosing(null)}
          onConfirm={(extras) => {
            add(choosing, 1000, extras)
            setChoosing(null)
          }}
        />
      ) : null}
      {discountFor ? (
        <DiscountForm
          ctx={ctx}
          lines={lines}
          cartLines={cart.lines}
          priceListId={priceListId}
          saleDiscount={saleDiscount}
          target={discountFor.key}
          onLine={setLineDiscount}
          onSale={setSaleDiscount}
          onClose={() => setDiscountFor(null)}
        />
      ) : null}
      <ReceiptDialog
        documentId={receiptId}
        onClose={() => {
          setReceiptId(null)
          if (backToTables) {
            setBackToTables(false)
            void navigate({ to: "/mesas" })
          } else if (finePointer) searchRef.current?.focus()
        }}
      />

      {/* En el celular el ticket queda debajo del catálogo: total y cobro siempre a mano. */}
      {cart.lines.length ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 px-3 py-2.5 shadow-[0_-4px_12px_rgb(0_0_0/0.06)] backdrop-blur lg:hidden">
          <div className="mx-auto flex max-w-[1600px] items-center gap-3">
            <button
              type="button"
              className="grid min-w-0 cursor-pointer text-left"
              onClick={() => ticketRef.current?.scrollIntoView({ behavior: "smooth" })}
            >
              <span className="truncate text-muted-foreground text-xs">
                {formatQty(lines.reduce((acc, l) => acc + l.qtyMilli, 0))} artículo
                {lines.reduce((acc, l) => acc + l.qtyMilli, 0) === 1000 ? "" : "s"} · Ver venta
              </span>
              <span className="tabular font-bold text-xl leading-tight">
                {formatMoney(cart.ticket.totalMinor, doc)}
              </span>
            </button>
            <Button
              size="lg"
              variant="success"
              className="ml-auto"
              disabled={!canCharge || !terminalId}
              onClick={() => setCheckoutOpen(true)}
            >
              Cobrar
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Elige el importe base y a quién se aplica el descuento: una línea o toda la venta. */
function DiscountForm({
  ctx,
  lines,
  cartLines,
  priceListId,
  saleDiscount,
  target,
  onLine,
  onSale,
  onClose,
}: {
  ctx: PosContext
  lines: TicketLine[]
  cartLines: CartLine[]
  priceListId: string | null
  saleDiscount: DiscountSpec | null
  target: string | null
  onLine: (key: string, spec: DiscountSpec | null) => void
  onSale: (spec: DiscountSpec | null) => void
  onClose: () => void
}) {
  if (target === null) {
    // A toda la venta: la base es lo que vale el ticket sin el propio descuento de la venta.
    const base = buildCart(ctx, lines, null, priceListId).ticket
    const gross = base.lineTotals.reduce((acc, n) => acc + n, 0)
    return (
      <DiscountDialog
        ctx={ctx}
        title="Descuento a toda la venta"
        description="Se reparte entre los productos del ticket. El IVA se calcula sobre lo que queda."
        baseMinor={gross}
        initial={saleDiscount}
        onApply={(spec) => {
          onSale(spec)
          onClose()
        }}
        onClose={onClose}
      />
    )
  }
  const i = lines.findIndex((l) => lineKey(l) === target)
  const line = lines[i]
  const priced = cartLines[i]
  if (!(line && priced)) return null
  const gross = lineTotal(priced.qtyMilli, priced.unitPriceMinor)
  return (
    <DiscountDialog
      ctx={ctx}
      title={`Descuento: ${line.name}`}
      description="Solo a este producto."
      baseMinor={gross}
      initial={line.discount ?? null}
      onApply={(spec) => {
        onLine(target, spec)
        onClose()
      }}
      onClose={onClose}
    />
  )
}
