import type { PaymentMethodInfo } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import { Badge, Button, cn, Field, Input, NativeSelect } from "@millhiore/ui"
import { CheckIcon, Trash2Icon } from "lucide-react"
import { type Dispatch, type SetStateAction, useRef, useState } from "react"
import { toast } from "sonner"
import { formatMoney, formatPercent, parseAmount, toInputAmount } from "../../lib/format"
import {
  amountToSettle,
  type Checkout,
  type CreditEntry,
  changeIn,
  convertMinor,
  methodUsable,
  type PaymentEntry,
  type PosContext,
  type Ticket,
} from "./compute"

const QUICK_BILLS: Record<string, number[]> = {
  USD: [100, 500, 1000, 2000, 5000, 10000],
}

/** Vuelto de una cuenta pagada de más: en qué se entrega y cuánto. */
export function useChange(ctx: PosContext, checkout: Checkout) {
  const cashMethods = ctx.methods.filter((m) => methodUsable(ctx, m) && m.kind === "cash")
  const [methodId, setMethodId] = useState(
    cashMethods.find((m) => m.currency === ctx.docCurrency)?.id ?? cashMethods[0]?.id ?? "",
  )
  const method = cashMethods.find((m) => m.id === methodId)
  const overpaid = !checkout.settled && checkout.remaining.lt(0)
  const amount = overpaid && method ? changeIn(ctx, checkout, method.currency) : 0
  return { cashMethods, methodId, setMethodId, method, overpaid, amount }
}

/** Los pagos que se agregan a una cuenta: métodos, monto, referencia, vuelto y lo que falta. */
export function PaymentPanel({
  ctx,
  ticket,
  payments,
  setPayments,
  checkout,
  change,
  credit = null,
  quickBills = true,
}: {
  ctx: PosContext
  ticket: Ticket
  payments: PaymentEntry[]
  setPayments: Dispatch<SetStateAction<PaymentEntry[]>>
  checkout: Checkout
  change: ReturnType<typeof useChange>
  /** Lo que se deja a deber: cuenta como cubierto y se muestra aparte. */
  credit?: CreditEntry | null
  /** Botones de billetes rápidos (no tienen sentido al reembolsar una devolución). */
  quickBills?: boolean
}) {
  const methods = ctx.methods.filter((m) => methodUsable(ctx, m))
  const [method, setMethod] = useState<PaymentMethodInfo | null>(null)
  const [amountText, setAmountText] = useState("")
  const [reference, setReference] = useState("")
  const amountRef = useRef<HTMLInputElement>(null)

  const doc = ctx.docCurrency
  const ref = ctx.refCurrency
  const remainingMinor = Math.round(checkout.remaining.toNumber())
  const methodName = (id: string) => ctx.methods.find((m) => m.id === id)?.name ?? id
  const toRef = (minor: number) => convertMinor(ctx, minor, doc, ref)

  const choose = (m: PaymentMethodInfo) => {
    setMethod(m)
    setReference("")
    const suggested = amountToSettle(ctx, ticket, payments, m)
    setAmountText(suggested > 0 ? toInputAmount(suggested) : "")
    requestAnimationFrame(() => amountRef.current?.select())
  }

  const addPayment = (amountMinor?: number) => {
    if (!method) return
    const amount = amountMinor ?? parseAmount(amountText)
    if (amount === null || amount <= 0) {
      toast.error("Escribe un monto válido")
      return
    }
    if (method.requiresReference && !reference.trim()) {
      toast.error(`${method.name} necesita la referencia`)
      return
    }
    setPayments((p) => [
      ...p,
      {
        id: uuidv7(),
        methodId: method.id,
        currency: method.currency,
        amountMinor: amount,
        reference: reference.trim() || null,
      },
    ])
    setMethod(null)
    setAmountText("")
    setReference("")
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {methods.map((m) => (
          <Button
            key={m.id}
            variant={method?.id === m.id ? "default" : "outline"}
            className="h-auto min-h-14 flex-col gap-0.5 py-2"
            onClick={() => choose(m)}
          >
            <span>{m.name}</span>
            <span className="font-normal text-xs opacity-80">
              {m.currency === "VES" ? "Bs" : m.currency}
              {m.surcharge
                ? ` · +${formatPercent(m.surcharge.rateBp)} ${m.surcharge.name.split(" ")[0]}`
                : ""}
            </span>
          </Button>
        ))}
      </div>

      {method ? (
        <form
          className="grid grid-cols-1 gap-3 rounded-lg border p-3"
          onSubmit={(e) => {
            e.preventDefault()
            addPayment()
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={`Monto en ${method.currency === "VES" ? "Bs" : method.currency}`}
              htmlFor="amount"
            >
              <Input
                id="amount"
                ref={amountRef}
                inputMode="decimal"
                autoFocus
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                className="tabular h-12 text-lg"
              />
            </Field>
            {method.requiresReference ? (
              <Field label="Referencia" htmlFor="reference">
                <Input
                  id="reference"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  className="h-12"
                  placeholder="Últimos dígitos"
                />
              </Field>
            ) : null}
          </div>
          {quickBills && QUICK_BILLS[method.currency] && method.kind === "cash" ? (
            <div className="flex flex-wrap gap-2">
              {QUICK_BILLS[method.currency]?.map((bill) => (
                <Button key={bill} variant="secondary" size="sm" onClick={() => addPayment(bill)}>
                  {formatMoney(bill, method.currency, 2).replace(",00", "")}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setMethod(null)}>
              Cancelar
            </Button>
            <Button type="submit">Agregar pago</Button>
          </div>
        </form>
      ) : null}

      {payments.length ? (
        <ul className="divide-y rounded-lg border">
          {payments.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="flex-1">
                {methodName(p.methodId)}
                {p.reference ? (
                  <span className="text-muted-foreground"> · ref. {p.reference}</span>
                ) : null}
              </span>
              <span className="tabular font-medium">{formatMoney(p.amountMinor, p.currency)}</span>
              {p.currency !== doc ? (
                <span className="tabular text-muted-foreground text-xs">
                  = {formatMoney(convertMinor(ctx, p.amountMinor, p.currency, doc) ?? 0, doc)}
                </span>
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setPayments((list) => list.filter((x) => x.id !== p.id))}
                aria-label="Quitar pago"
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 rounded-lg p-3 text-sm",
          checkout.settled
            ? credit
              ? "bg-warning/20"
              : "bg-success/15"
            : change.overpaid
              ? "bg-warning/20"
              : "bg-muted/60",
        )}
      >
        {checkout.settled ? (
          credit ? (
            <span className="font-medium">
              Queda a deber:{" "}
              <span className="tabular text-lg">
                {formatMoney(credit.amountMinor, credit.currency)}
              </span>
            </span>
          ) : (
            <span className="flex items-center gap-2 font-medium text-success">
              <CheckIcon className="size-4" /> Pagado completo
            </span>
          )
        ) : change.overpaid ? (
          <>
            <span className="font-medium">
              Vuelto:{" "}
              <span className="tabular text-lg">
                {formatMoney(change.amount, change.method?.currency ?? doc)}
              </span>
            </span>
            <span className="flex items-center gap-2">
              <label htmlFor="change-method" className="text-muted-foreground">
                Entregar en
              </label>
              <NativeSelect
                id="change-method"
                value={change.methodId}
                onChange={(e) => change.setMethodId(e.target.value)}
                className="h-9 w-auto"
              >
                {change.cashMethods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </NativeSelect>
            </span>
          </>
        ) : (
          <span className="font-medium">
            Falta: <span className="tabular text-lg">{formatMoney(remainingMinor, doc)}</span>
            {ctx.rate && doc !== ref ? (
              <span className="tabular ml-2 text-muted-foreground">
                ≈ {formatMoney(toRef(remainingMinor) ?? 0, ref)}
              </span>
            ) : null}
          </span>
        )}
        {checkout.surchargeMinor > 0 ? <Badge variant="secondary">Incluye IGTF</Badge> : null}
      </div>
    </>
  )
}
