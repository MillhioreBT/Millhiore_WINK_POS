import type { Contact, PostedDocumentBody } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { BookOpenIcon, MinusIcon, PlusIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import {
  currencySymbol,
  formatDay,
  formatMoney,
  formatPercent,
  parseAmount,
  toInputAmount,
} from "../../lib/format"
import { bootstrapQuery, queryClient, statementQuery } from "../../lib/queries"
import { can, useFeatures, useMe } from "../../lib/session"
import { ContactPicker } from "../contacts/ContactPicker"
import {
  type CartLine,
  computeCheckout,
  convertMinor,
  creditToLeave,
  creditUsable,
  type PaymentEntry,
  type PosContext,
  paymentRate,
  type Ticket,
} from "./compute"
import { PaymentPanel, useChange } from "./PaymentPanel"
import { usePos } from "./store"

const DAY_MS = 86_400_000
/** Propinas sugeridas, en % del total de la venta. */
const TIP_PERCENTS = [5, 10, 15]

export function CheckoutDialog({
  ctx,
  lines,
  ticket: sale,
  saleId,
  terminalId,
  onClose,
  onPosted,
}: {
  ctx: PosContext
  lines: CartLine[]
  ticket: Ticket
  saleId: string
  terminalId: string
  onClose: () => void
  onPosted: (documentId: string) => void
}) {
  const me = useMe()
  const features = useFeatures()
  const staff = useQuery(bootstrapQuery).data?.staff ?? []
  const [payments, setPayments] = useState<PaymentEntry[]>([])
  const [busy, setBusy] = useState(false)
  const quote = usePos((s) => s.quote)
  const tab = usePos((s) => s.tab)
  // Una mesa que paga a partes iguales: cuánto le toca a cada quien.
  const [parts, setParts] = useState(1)
  const discountCode = usePos((s) => s.saleDiscount?.code)
  // Una venta que sale de una cotización viene con su cliente.
  const [customer, setCustomer] = useState<Contact | null>(quote?.contact ?? null)
  const [onCredit, setOnCredit] = useState(false)
  const { priceListId, setPriceList } = usePos()
  /** Lista del cliente elegido, si no es la que ya tiene la venta. */
  const customerList =
    customer?.priceListId && customer.priceListId !== priceListId
      ? ctx.priceLists.get(customer.priceListId)
      : undefined
  const currentList = priceListId ? ctx.priceLists.get(priceListId) : undefined

  const doc = ctx.docCurrency
  const ref = ctx.refCurrency

  // Propina: aparte del total (sin IVA ni IGTF), escrita en Bs o en divisas; va para quien atiende
  // la mesa o para quien se elija (vacío: para todo el equipo).
  const [tipText, setTipText] = useState("")
  const [tipCurrency, setTipCurrency] = useState(doc)
  const [tipUserId, setTipUserId] = useState(tab?.waiterId ?? "")
  const tipTyped = features.tips && tipText.trim() ? parseAmount(tipText, 2) : 0
  const tipMinor =
    tipTyped === null
      ? null
      : tipCurrency === doc
        ? tipTyped
        : convertMinor(ctx, tipTyped, tipCurrency, doc)
  const ticket = useMemo(() => (tipMinor ? { ...sale, tipMinor } : sale), [sale, tipMinor])
  const tipPercent = (pct: number) => {
    setTipCurrency(doc)
    setTipText(toInputAmount(Math.round((sale.totalMinor * pct) / 100)))
  }

  // Fiar: solo con un cliente registrado, si el negocio lo permite y la persona tiene permiso.
  // La deuda va en la moneda de referencia (dólares): en bolívares se devalúa.
  const creditAllowed = ctx.creditEnabled && can(me, "sale.credit") && creditUsable(ctx, ref)
  const canCredit = creditAllowed && customer !== null
  const plain = useMemo(() => computeCheckout(ctx, ticket, payments), [ctx, ticket, payments])
  const creditMinor = useMemo(
    () => (canCredit && onCredit ? creditToLeave(ctx, ticket, payments, ref) : 0),
    [canCredit, onCredit, ctx, ticket, payments, ref],
  )
  const offered = useMemo(
    () => (canCredit && !plain.settled ? creditToLeave(ctx, ticket, payments, ref) : 0),
    [canCredit, plain.settled, ctx, ticket, payments, ref],
  )
  const credit = creditMinor > 0 ? { currency: ref, amountMinor: creditMinor } : null
  const checkout = useMemo(
    () => computeCheckout(ctx, ticket, payments, credit),
    [ctx, ticket, payments, credit],
  )
  const change = useChange(ctx, checkout)
  const toRef = (minor: number) => convertMinor(ctx, minor, doc, ref)

  const statement = useQuery({
    ...statementQuery(customer?.id ?? ""),
    enabled: canCredit,
  })
  const owed = statement.data?.owedReferenceMinor ?? 0
  const limit = customer?.creditLimitMinor ?? null
  const overLimit = limit !== null && credit !== null && owed + credit.amountMinor > limit
  const dueAt = credit && customer?.creditDays ? Date.now() + customer.creditDays * DAY_MS : null

  const pickCustomer = (c: Contact | null) => {
    setCustomer(c)
    if (!c) setOnCredit(false)
    // Un cliente con lista de precios compra con ella; si ya se anotaron pagos, se ofrece.
    if (c?.priceListId && ctx.priceLists.has(c.priceListId) && payments.length === 0) {
      setPriceList(c.priceListId)
    }
  }

  const confirm = async () => {
    const final = [...payments]
    if (change.overpaid) {
      if (!change.method || change.amount <= 0) {
        toast.error("Elige en qué se entrega el vuelto")
        return
      }
      final.push({
        id: uuidv7(),
        methodId: change.method.id,
        currency: change.method.currency,
        amountMinor: -change.amount,
        reference: null,
      })
    }
    if (!computeCheckout(ctx, ticket, final, credit).settled) {
      toast.error("Los pagos no cubren el total")
      return
    }
    if (credit && !customer) {
      toast.error("Elige el cliente al que le fías")
      return
    }
    if (tipMinor === null) {
      toast.error("Escribe bien la propina")
      return
    }
    setBusy(true)
    try {
      const posted = await api<PostedDocumentBody>("/api/documents", {
        body: {
          id: saleId,
          type: "SALE",
          terminalId,
          currency: doc,
          rate: ctx.rate,
          pricesIncludeTax: ctx.fiscal.pricesIncludeTax,
          contactId: customer?.id ?? null,
          ...(quote ? { quoteId: quote.id } : {}),
          ...(tab ? { tab: { id: tab.id, lines: tab.lines } } : {}),
          ...(discountCode ? { discountCodeId: discountCode.id } : {}),
          ...(credit ? { creditMinor: credit.amountMinor, creditCurrency: credit.currency } : {}),
          ...(tipMinor ? { tipMinor, tipUserId: tipUserId || null } : {}),
          lines: lines.map((l) => ({
            variantId: l.variantId,
            qtyMilli: l.qtyMilli,
            unitPriceMinor: l.unitPriceMinor,
            discountMinor: l.discountMinor ?? 0,
            ...(l.modifiers?.length ? { modifierIds: l.modifiers.map((m) => m.id) } : {}),
            ...(l.note ? { note: l.note } : {}),
          })),
          // Recargos (delivery, servicio): el fijo con el monto que se ve; el % lo calcula el servidor.
          charges: ticket.charges.map((c) => ({
            chargeId: c.chargeId,
            ...(c.kind === "fixed" ? { amountMinor: c.amountMinor } : {}),
          })),
          payments: final.map((p) => ({
            id: p.id,
            paymentMethodId: p.methodId,
            currency: p.currency,
            amountMinor: p.amountMinor,
            rate: paymentRate(ctx, p.currency),
            reference: p.reference,
          })),
        },
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["products"] }),
        queryClient.invalidateQueries({ queryKey: ["documents"] }),
        queryClient.invalidateQueries({ queryKey: ["receivables"] }),
        ...(quote ? [queryClient.invalidateQueries({ queryKey: ["quotes"] })] : []),
        ...(tab
          ? [
              queryClient.invalidateQueries({ queryKey: ["dining"] }),
              queryClient.invalidateQueries({ queryKey: ["tabs"] }),
            ]
          : []),
      ])
      toast.success(`Venta ${posted.number} registrada${credit ? " a crédito" : ""}`)
      onPosted(posted.id)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cobrar</DialogTitle>
          <DialogDescription>
            Elige cómo paga el cliente. Puedes combinar métodos; el sistema calcula el vuelto.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-1 rounded-lg bg-muted/60 p-4 text-sm">
          <div className="flex justify-between">
            <span>Total de la venta</span>
            <span className="tabular">{formatMoney(ticket.totalMinor, doc)}</span>
          </div>
          {tipMinor ? (
            <div className="flex justify-between text-muted-foreground">
              <span>
                Propina
                {tipUserId ? ` para ${staff.find((u) => u.id === tipUserId)?.name ?? ""}` : ""}
              </span>
              <span className="tabular">{formatMoney(tipMinor, doc)}</span>
            </div>
          ) : null}
          {checkout.surcharges.map((s) => (
            <div key={s.surchargeId} className="flex justify-between text-muted-foreground">
              <span>
                IGTF {formatPercent(s.rateBp)} sobre {formatMoney(s.baseMinor, doc)} pagados en
                divisas
              </span>
              <span className="tabular">{formatMoney(s.amountMinor, doc)}</span>
            </div>
          ))}
          <div className="mt-1 flex items-baseline justify-between">
            <span className="font-medium">A cobrar</span>
            <span className="text-right">
              <span className="tabular block font-bold text-2xl">
                {formatMoney(checkout.dueMinor, doc)}
              </span>
              {ctx.rate ? (
                <span className="tabular text-muted-foreground">
                  ≈ {formatMoney(toRef(checkout.dueMinor) ?? 0, ref)}
                </span>
              ) : null}
            </span>
          </div>
        </div>

        {tab ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-muted-foreground">Partes iguales</span>
            <span className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Una parte menos"
                disabled={parts <= 1}
                onClick={() => setParts((n) => n - 1)}
              >
                <MinusIcon />
              </Button>
              <span className="tabular w-8 text-center">{parts}</span>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Una parte más"
                disabled={parts >= 30}
                onClick={() => setParts((n) => n + 1)}
              >
                <PlusIcon />
              </Button>
            </span>
            {parts > 1 ? (
              <span className="tabular">
                Cada una: {formatMoney(Math.ceil(ticket.totalMinor / parts), doc)}
                {ctx.rate
                  ? ` ≈ ${formatMoney(toRef(Math.ceil(ticket.totalMinor / parts)) ?? 0, ref)}`
                  : ""}
              </span>
            ) : null}
          </div>
        ) : null}

        {features.tips ? (
          <div className="grid grid-cols-1 gap-2 rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">Propina</span>
              {TIP_PERCENTS.map((pct) => (
                <Button
                  key={pct}
                  variant="outline"
                  size="sm"
                  disabled={payments.length > 0}
                  onClick={() => tipPercent(pct)}
                >
                  {pct} %
                </Button>
              ))}
              <span className="flex items-center gap-1">
                <Input
                  value={tipText}
                  inputMode="decimal"
                  className="tabular h-9 w-24 text-right sm:h-8"
                  aria-label="Propina"
                  placeholder="0,00"
                  disabled={payments.length > 0}
                  onChange={(e) => setTipText(e.target.value)}
                />
                {ctx.rate ? (
                  <NativeSelect
                    className="h-9 w-20 sm:h-8"
                    aria-label="Moneda de la propina"
                    value={tipCurrency}
                    disabled={payments.length > 0}
                    onChange={(e) => setTipCurrency(e.target.value)}
                  >
                    {[doc, ref].map((c) => (
                      <option key={c} value={c}>
                        {currencySymbol(c)}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <span className="text-muted-foreground">{currencySymbol(doc)}</span>
                )}
              </span>
            </div>
            {tipMinor ? (
              <NativeSelect
                aria-label="Para quién es la propina"
                value={tipUserId}
                onChange={(e) => setTipUserId(e.target.value)}
              >
                <option value="">Para todo el equipo</option>
                {staff.map((u) => (
                  <option key={u.id} value={u.id}>
                    Para {u.name}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
            {tipMinor === null ? (
              <p className="text-destructive">Escribe la propina como 2 o 2,50.</p>
            ) : payments.length > 0 ? (
              <p className="text-muted-foreground">Para cambiar la propina, quita los pagos.</p>
            ) : null}
          </div>
        ) : null}

        <ContactPicker
          kind="customer"
          value={customer}
          onChange={pickCustomer}
          placeholder="Cliente (opcional): nombre, cédula o teléfono"
        />
        {customerList ? (
          <Button
            variant="outline"
            onClick={() => {
              setPayments([])
              setPriceList(customerList.id)
            }}
          >
            Usar los precios «{customerList.name}» de este cliente
          </Button>
        ) : currentList ? (
          <p className="text-muted-foreground text-sm">Con los precios «{currentList.name}».</p>
        ) : null}

        <PaymentPanel
          ctx={ctx}
          ticket={ticket}
          payments={payments}
          setPayments={setPayments}
          checkout={checkout}
          change={change}
          credit={credit}
        />

        {creditAllowed && !plain.settled && !change.overpaid ? (
          customer ? (
            <div className="grid grid-cols-1 gap-2 rounded-lg border border-dashed p-3 text-sm">
              <Button
                variant={onCredit ? "default" : "outline"}
                disabled={!onCredit && offered <= 0}
                onClick={() => setOnCredit((v) => !v)}
              >
                <BookOpenIcon />
                {onCredit
                  ? "Quitar el fiado"
                  : `Fiar el resto a ${customer.name}${offered > 0 ? ` (${formatMoney(offered, ref)})` : ""}`}
              </Button>
              {owed > 0 || limit !== null ? (
                <p className="text-muted-foreground">
                  {owed > 0 ? `Ya debe ${formatMoney(owed, ref)}. ` : ""}
                  {limit !== null ? `Su límite es ${formatMoney(limit, ref)}.` : ""}
                </p>
              ) : null}
              {credit && dueAt ? (
                <p className="text-muted-foreground">
                  Tiene hasta el {formatDay(dueAt)} ({customer?.creditDays} días) para pagar.
                </p>
              ) : null}
              {overLimit ? (
                <p className="font-medium text-destructive">
                  Con esta venta supera su límite de crédito.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              Para dejar algo a deber, elige primero el cliente.
            </p>
          )
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Volver
          </Button>
          <Button
            variant="success"
            size="lg"
            onClick={confirm}
            disabled={busy || overLimit || !(checkout.settled || change.overpaid)}
          >
            {busy ? "Registrando…" : credit ? "Confirmar venta a crédito" : "Confirmar venta"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
