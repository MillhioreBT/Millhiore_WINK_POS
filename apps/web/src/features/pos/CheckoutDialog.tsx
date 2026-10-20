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
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { BookOpenIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatDay, formatMoney, formatPercent } from "../../lib/format"
import { queryClient, statementQuery } from "../../lib/queries"
import { can, useMe } from "../../lib/session"
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

const DAY_MS = 86_400_000

export function CheckoutDialog({
  ctx,
  lines,
  ticket,
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
  const [payments, setPayments] = useState<PaymentEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [customer, setCustomer] = useState<Contact | null>(null)
  const [onCredit, setOnCredit] = useState(false)

  const doc = ctx.docCurrency
  const ref = ctx.refCurrency

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
          ...(credit ? { creditMinor: credit.amountMinor, creditCurrency: credit.currency } : {}),
          lines: lines.map((l) => ({
            variantId: l.variantId,
            qtyMilli: l.qtyMilli,
            unitPriceMinor: l.unitPriceMinor,
            discountMinor: l.discountMinor ?? 0,
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

        <ContactPicker
          kind="customer"
          value={customer}
          onChange={pickCustomer}
          placeholder="Cliente (opcional): nombre, cédula o teléfono"
        />

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
