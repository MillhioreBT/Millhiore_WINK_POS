import type { CatalogItem } from "@millhiore/contracts"
import { lineTotal } from "@millhiore/domain"
import {
  Badge,
  Button,
  Card,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  ArchiveIcon,
  ArrowLeftRightIcon,
  ClockIcon,
  LockKeyholeIcon,
  MinusIcon,
  PauseIcon,
  PercentIcon,
  PlayIcon,
  PlusIcon,
  ScanBarcodeIcon,
  SearchIcon,
  ShoppingCartIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { formatMoney, formatPercent, formatQty, formatTime } from "../../lib/format"
import { openDrawer } from "../../lib/printing"
import {
  bootstrapQuery,
  categoriesQuery,
  currentShiftQuery,
  productsQuery,
  rateStatusQuery,
} from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { ReceiptDialog } from "../sales/ReceiptDialog"
import { CashMoveDialog, CloseShiftDialog, OpenShiftCard } from "../shifts/ShiftDialogs"
import { CheckoutDialog } from "./CheckoutDialog"
import {
  buildCart,
  type CartLine,
  convertMinor,
  type DiscountSpec,
  makeContext,
  type PosContext,
  unitPriceInDoc,
} from "./compute"
import { DiscountDialog } from "./DiscountDialog"
import { type HeldTicket, type TicketLine, usePos } from "./store"

/**
 * Con mouse (o lector de códigos) la búsqueda vuelve a tener el foco tras cada producto; en una
 * pantalla táctil eso abriría el teclado en cada toque.
 */
const finePointer = typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches

/** Ventas aparcadas: cuánto suman hoy y con qué productos, para retomarlas o descartarlas. */
function HeldDialog({ ctx, onClose }: { ctx: PosContext; onClose: () => void }) {
  const { held, resume, discardHeld, lines } = usePos()
  const total = (t: HeldTicket) => buildCart(ctx, t.lines, t.saleDiscount ?? null).ticket.totalMinor
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

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
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
  } = usePos()
  const canDiscount = can(me, "sale.discount")
  const [discountFor, setDiscountFor] = useState<{ variantId: string | null } | null>(null)
  const [heldOpen, setHeldOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [receiptId, setReceiptId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<"cash" | "close" | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const ticketRef = useRef<HTMLDivElement>(null)
  const terminalId = boot.data?.terminals[0]?.id
  const shift = useQuery({ ...currentShiftQuery(terminalId ?? ""), enabled: !!terminalId })

  const ctx = useMemo(
    () => (boot.data ? makeContext(boot.data, rate.data?.current?.value ?? null) : null),
    [boot.data, rate.data],
  )

  // Ticket en Bs con la tasa vigente. Una línea sin precio convertible bloquea el cobro.
  const cart = useMemo(
    () => (ctx ? buildCart(ctx, lines, canDiscount ? saleDiscount : null) : null),
    [ctx, lines, saleDiscount, canDiscount],
  )

  const categories = useQuery(categoriesQuery())
  const [category, setCategory] = useState("")
  // Solo se ofrecen las categorías que tienen productos a la venta (y «Sin categoría» si hay).
  const chips = useMemo(() => {
    const items = products.data ?? []
    const used = new Set(items.map((p) => p.categoryId))
    return {
      list: (categories.data ?? []).filter((c) => used.has(c.id)),
      hasNone: used.has(null) && used.size > 1,
    }
  }, [products.data, categories.data])
  // Si la categoría elegida deja de existir (se desactivó o ya no tiene productos), vuelve «Todas».
  const activeCategory =
    category === "none"
      ? chips.hasNone
        ? "none"
        : ""
      : chips.list.some((c) => c.id === category)
        ? category
        : ""

  const filtered = useMemo(() => {
    const all = products.data ?? []
    const q = normalize(search.trim())
    // Buscar escribiendo recorre todo el catálogo; las categorías solo filtran sin búsqueda.
    if (!q) {
      return activeCategory === "none"
        ? all.filter((p) => p.categoryId === null)
        : activeCategory
          ? all.filter((p) => p.categoryId === activeCategory)
          : all
    }
    return all.filter(
      (p) =>
        normalize(p.name).includes(q) || p.sku.toLowerCase() === q || p.barcode === search.trim(),
    )
  }, [products.data, search, activeCategory])

  const canCharge =
    cart !== null && cart.lines.length > 0 && !cart.missingRate && cart.ticket.totalMinor > 0

  // F2 busca, F12 cobra, Esc limpia la búsqueda.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === "F12" && canCharge) {
        e.preventDefault()
        setCheckoutOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [canCharge])

  const addItem = (item: CatalogItem) => {
    add(item)
    setSearch("")
    if (finePointer) searchRef.current?.focus()
  }

  // Lector de códigos USB sin foco: teclea como un teclado, pero en ráfaga (pocos ms entre
  // teclas) y termina con Enter. Así se escanea aunque el cursor no esté en el buscador.
  const scan = useRef({ code: "", last: 0 })
  const busy = checkoutOpen || dialog !== null || receiptId !== null || heldOpen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return
      const target = e.target as HTMLElement | null
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return
      const now = performance.now()
      const s = scan.current
      if (e.key === "Enter") {
        if (s.code.length >= 4 && now - s.last < 100) {
          e.preventDefault()
          const code = s.code
          const item = products.data?.find(
            (p) => p.barcode === code || p.sku.toLowerCase() === code.toLowerCase(),
          )
          if (item) addItem(item)
          else toast.error(`No hay ningún producto con el código ${code}`)
        }
        s.code = ""
        return
      }
      if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return
      if (now - s.last > 50) s.code = ""
      s.code += e.key
      s.last = now
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  // Enter en la búsqueda: código de barras/SKU exacto, o el único resultado.
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") setSearch("")
    if (e.key !== "Enter") return
    const term = search.trim()
    if (!term) return
    const exact = products.data?.find(
      (p) => p.barcode === term || p.sku.toLowerCase() === term.toLowerCase(),
    )
    const pick = exact ?? (filtered.length === 1 ? filtered[0] : undefined)
    if (pick) addItem(pick)
  }

  if (!ctx || !cart || !boot.data || !terminalId || shift.isPending) {
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

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 lg:h-[calc(100dvh-5.5rem)] lg:grid-cols-[minmax(0,1fr)_420px] lg:pb-0",
        cart.lines.length ? "pb-20" : "",
      )}
    >
      {/* Catálogo */}
      <section className="flex min-h-0 flex-col gap-3">
        {!ctx.rate ? (
          <div className="flex items-center gap-2 rounded-lg border border-warning/50 bg-warning/15 p-3 text-sm">
            <TriangleAlertIcon className="size-4 shrink-0" />
            No hay tasa del día: no se pueden convertir precios en divisas.
            {can(me, "rate.manage") ? (
              <Link to="/ajustes" className="font-medium underline">
                Cargar tasa
              </Link>
            ) : null}
          </div>
        ) : null}
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            autoFocus={finePointer}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder={
              finePointer ? "Buscar producto o escanear código (F2)" : "Buscar producto o código"
            }
            className="h-12 pr-10 pl-10 text-base"
            aria-label="Buscar producto"
          />
          <ScanBarcodeIcon className="pointer-events-none absolute top-1/2 right-3 size-5 -translate-y-1/2 text-muted-foreground" />
        </div>
        {chips.list.length ? (
          <div
            className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
            role="tablist"
            aria-label="Categorías"
          >
            {[
              { id: "", name: "Todas" },
              ...chips.list,
              ...(chips.hasNone ? [{ id: "none", name: "Sin categoría" }] : []),
            ].map((c) => (
              <Button
                key={c.id || "all"}
                role="tab"
                aria-selected={activeCategory === c.id}
                variant={activeCategory === c.id ? "default" : "outline"}
                size="sm"
                className="shrink-0 rounded-full"
                onClick={() => setCategory(c.id)}
              >
                {c.name}
              </Button>
            ))}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {products.data?.length === 0 ? (
            <div className="grid place-items-center gap-2 rounded-xl border border-dashed p-10 text-center text-muted-foreground">
              <p>Aún no hay productos.</p>
              {can(me, "catalog.manage") ? (
                <Button asChild variant="outline">
                  <Link to="/productos">Crear productos</Link>
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {filtered.map((p) => {
              const unit = unitPriceInDoc(ctx, p.priceMinor, p.priceCurrency)
              return (
                <button
                  key={p.variantId}
                  type="button"
                  onClick={() => addItem(p)}
                  className="flex min-h-24 cursor-pointer flex-col justify-between gap-2 rounded-xl border bg-card p-3 text-left shadow-xs transition-colors hover:border-primary hover:bg-accent/50 active:scale-[0.99]"
                >
                  <span className="line-clamp-2 font-medium leading-tight">{p.name}</span>
                  <span className="flex items-end justify-between gap-2">
                    <span className="grid">
                      <span className="tabular font-semibold">
                        {unit === null ? "—" : formatMoney(unit, doc)}
                      </span>
                      {p.priceCurrency !== doc ? (
                        <span className="tabular text-muted-foreground text-xs">
                          {formatMoney(p.priceMinor, p.priceCurrency)}
                        </span>
                      ) : null}
                    </span>
                    {p.tracksStock ? (
                      <Badge
                        variant={p.stockMilli > 0 ? "secondary" : "warning"}
                        className="tabular"
                      >
                        {formatQty(p.stockMilli)}
                      </Badge>
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </section>

      {/* Ticket */}
      <Card
        ref={ticketRef}
        className="flex min-h-[420px] scroll-mt-20 flex-col overflow-hidden lg:min-h-0"
      >
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs">
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
        <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
          {cart.lines.length === 0 ? (
            <li className="p-8 text-center text-muted-foreground text-sm">
              Toca un producto o escanea su código para agregarlo.
            </li>
          ) : null}
          {cart.lines.map((l, i) => (
            <li key={l.variantId} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 px-4 py-2.5">
              <span className="font-medium leading-tight">{l.name}</span>
              <span className="tabular text-right font-semibold">
                {formatMoney(cart.ticket.lineTotals[i] ?? 0, doc)}
                {l.discountMinor ? (
                  <span className="block font-normal text-success text-xs">
                    -{formatMoney(l.discountMinor, doc)}
                  </span>
                ) : null}
              </span>
              <span className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => setQty(l.variantId, l.qtyMilli - 1000)}
                  aria-label={`Quitar uno de ${l.name}`}
                >
                  <MinusIcon />
                </Button>
                <span className="tabular w-10 text-center text-sm">{formatQty(l.qtyMilli)}</span>
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => setQty(l.variantId, l.qtyMilli + 1000)}
                  aria-label={`Agregar uno de ${l.name}`}
                >
                  <PlusIcon />
                </Button>
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
                    onClick={() => setDiscountFor({ variantId: l.variantId })}
                    aria-label={`Descuento a ${l.name}`}
                    title="Descuento a este producto"
                  >
                    <PercentIcon />
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  onClick={() => remove(l.variantId)}
                  aria-label={`Eliminar ${l.name}`}
                >
                  <Trash2Icon />
                </Button>
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
          {cart.ticket.discountMinor > 0 ? (
            <div className="flex justify-between text-success">
              <span>Descuentos</span>
              <span className="tabular">-{formatMoney(cart.ticket.discountMinor, doc)}</span>
            </div>
          ) : null}
          {canDiscount && cart.lines.length ? (
            <Button
              variant="ghost"
              size="sm"
              className="justify-self-start px-2 text-muted-foreground"
              onClick={() => setDiscountFor({ variantId: null })}
            >
              <PercentIcon />{" "}
              {saleDiscount ? "Cambiar el descuento de la venta" : "Descuento a toda la venta"}
            </Button>
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
      {discountFor ? (
        <DiscountForm
          ctx={ctx}
          lines={lines}
          cartLines={cart.lines}
          saleDiscount={saleDiscount}
          target={discountFor.variantId}
          onLine={setLineDiscount}
          onSale={setSaleDiscount}
          onClose={() => setDiscountFor(null)}
        />
      ) : null}
      <ReceiptDialog
        documentId={receiptId}
        onClose={() => {
          setReceiptId(null)
          if (finePointer) searchRef.current?.focus()
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
  saleDiscount,
  target,
  onLine,
  onSale,
  onClose,
}: {
  ctx: PosContext
  lines: TicketLine[]
  cartLines: CartLine[]
  saleDiscount: DiscountSpec | null
  target: string | null
  onLine: (variantId: string, spec: DiscountSpec | null) => void
  onSale: (spec: DiscountSpec | null) => void
  onClose: () => void
}) {
  if (target === null) {
    // A toda la venta: la base es lo que vale el ticket sin el propio descuento de la venta.
    const base = buildCart(ctx, lines, null).ticket
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
  const i = lines.findIndex((l) => l.variantId === target)
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
