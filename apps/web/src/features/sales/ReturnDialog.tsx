import type { PostedDocumentBody, Returnable } from "@millhiore/contracts"
import { computeTaxes, lineTotal, returnLineDiscount, uuidv7 } from "@millhiore/domain"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatMoney, formatQty, parseAmount, toInputQty } from "../../lib/format"
import { bootstrapQuery, queryClient, rateStatusQuery } from "../../lib/queries"
import {
  computeCheckout,
  convertMinor,
  creditUsable,
  makeContext,
  type PaymentEntry,
  paymentRate,
  type Ticket,
} from "../pos/compute"
import { PaymentPanel, useChange } from "../pos/PaymentPanel"

const identity = (n: number) => n

type Pick = { l: Returnable["lines"][number]; q: number }

/** El total de lo que se devuelve, con el precio, el descuento y el IVA originales. */
function buildReturnTicket(picked: Pick[], pricesIncludeTax: boolean): Ticket {
  const lines = picked.map(({ l, q }) => {
    const discount = returnLineDiscount({
      discountMinor: l.discountMinor,
      qtyMilli: l.qtyMilli,
      returnQtyMilli: q,
      returnedQtyMilli: l.returnedMilli,
      returnedDiscountMinor: l.returnedDiscountMinor,
    })
    return {
      lineTotalMinor: lineTotal(q, l.unitPriceMinor) - discount,
      discountMinor: discount,
      tax: l.taxId ? { taxId: l.taxId, kind: l.taxKind ?? "exempt", rateBp: l.taxRateBp } : null,
    }
  })
  const taxes = computeTaxes(lines, pricesIncludeTax, identity)
  return {
    lineTotals: lines.map((l) => l.lineTotalMinor),
    discountMinor: lines.reduce((acc, l) => acc + l.discountMinor, 0),
    taxes,
    totalMinor: taxes.reduce((acc, t) => acc + t.baseMinor + t.taxMinor, 0),
    taxMinor: taxes.reduce((acc, t) => acc + t.taxMinor, 0),
  }
}

/** Devolver parte de una venta: qué productos, cuánto, y cómo se le devuelve el dinero al cliente. */
export function ReturnDialog({
  saleId,
  onClose,
  onPosted,
}: {
  saleId: string
  onClose: () => void
  onPosted: (documentId: string) => void
}) {
  const info = useQuery({
    queryKey: ["returnable", saleId],
    queryFn: () => api<Returnable>(`/api/documents/${saleId}/returnable`),
    staleTime: 0,
  })
  const boot = useQuery(bootstrapQuery)
  const rate = useQuery(rateStatusQuery)

  if (!(info.data && boot.data)) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogTitle>Devolución</DialogTitle>
          <DialogDescription>
            {info.isError ? errorMessage(info.error) : "Cargando…"}
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cerrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }
  return (
    <ReturnBody
      data={info.data}
      boot={boot.data}
      rateValue={rate.data?.current?.value ?? null}
      onClose={onClose}
      onPosted={onPosted}
    />
  )
}

function ReturnBody({
  data,
  boot,
  rateValue,
  onClose,
  onPosted,
}: {
  data: Returnable
  boot: NonNullable<ReturnType<typeof useQuery<import("@millhiore/contracts").Bootstrap>>["data"]>
  rateValue: string | null
  onClose: () => void
  onPosted: (documentId: string) => void
}) {
  // En una devolución no hay IGTF: ni se cobra ni se reembolsa por el método (el servidor tampoco).
  const ctx = useMemo(() => {
    const base = makeContext(boot, rateValue)
    return {
      ...base,
      docCurrency: data.currency,
      methods: base.methods.map((m) => ({ ...m, surcharge: null })),
    }
  }, [boot, rateValue, data.currency])
  const doc = data.currency
  const [qty, setQty] = useState<Record<number, string>>({})
  const [payments, setPayments] = useState<PaymentEntry[]>([])
  const [useDebt, setUseDebt] = useState(true)
  const [busy, setBusy] = useState(false)
  const [documentId] = useState(() => uuidv7())

  const rows = useMemo(
    () =>
      data.lines.map((l) => {
        const text = qty[l.lineNo] ?? ""
        const q = text.trim() ? parseAmount(text, 3) : 0
        return { l, text, q: q ?? Number.NaN }
      }),
    [data, qty],
  )
  const invalid = rows.some((r) => Number.isNaN(r.q) || r.q < 0 || r.q > r.l.remainingMilli)
  const picked = useMemo(() => rows.filter((r) => r.q > 0 && r.q <= r.l.remainingMilli), [rows])
  const ticket = useMemo(
    () => buildReturnTicket(picked, data.pricesIncludeTax),
    [picked, data.pricesIncludeTax],
  )

  // Si la venta quedó a deber, lo devuelto se descuenta primero de esa deuda.
  const debt = data.debt
  const debtUsable = debt !== null && creditUsable(ctx, debt.currency)
  const inDebtCurrency =
    debt && ticket.totalMinor > 0 ? convertMinor(ctx, ticket.totalMinor, doc, debt.currency) : null
  const applied =
    useDebt && debt && debtUsable && inDebtCurrency !== null
      ? Math.min(debt.outstandingMinor, inDebtCurrency)
      : 0
  const debtCurrency = debt?.currency
  const credit = useMemo(
    () => (applied > 0 && debtCurrency ? { currency: debtCurrency, amountMinor: applied } : null),
    [applied, debtCurrency],
  )
  const checkout = useMemo(
    () => computeCheckout(ctx, ticket, payments, credit),
    [ctx, ticket, payments, credit],
  )
  const change = useChange(ctx, checkout)
  const ready = picked.length > 0 && !invalid && ticket.totalMinor > 0 && checkout.settled

  const confirm = async () => {
    setBusy(true)
    try {
      const posted = await api<PostedDocumentBody>(`/api/documents/${data.documentId}/return`, {
        body: {
          id: documentId,
          terminalId: boot.terminals[0]?.id,
          rate: ctx.rate,
          lines: picked.map(({ l, q }) => ({ lineNo: l.lineNo, qtyMilli: q })),
          creditAppliedMinor: applied,
          payments: payments.map((p) => ({
            id: p.id,
            paymentMethodId: p.methodId,
            currency: p.currency,
            amountMinor: p.amountMinor,
            rate: paymentRate(ctx, p.currency),
            reference: p.reference,
          })),
        },
      })
      await Promise.all(
        ["documents", "document", "products", "receivables", "reports", "shifts", "returnable"].map(
          (k) => queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      )
      toast.success(`Devolución ${posted.number} registrada`)
      onPosted(posted.id)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const everything = rows.every((r) => r.l.remainingMilli === 0)

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Devolución de la venta {data.number}</DialogTitle>
          <DialogDescription>
            Elige qué productos devuelve{data.contactName ? ` ${data.contactName}` : " el cliente"}.
            Se devuelven con el precio, el descuento y el IVA con que se vendieron.
          </DialogDescription>
        </DialogHeader>

        {everything ? (
          <p className="rounded-lg bg-muted/60 p-4 text-center text-muted-foreground text-sm">
            Ya se devolvió todo lo de esta venta.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {rows.map(({ l, text, q }) => (
              <li
                key={l.lineNo}
                className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-2"
              >
                <span className="font-medium">{l.name}</span>
                <span className="flex items-center gap-1.5">
                  <Input
                    inputMode="decimal"
                    value={text}
                    disabled={l.remainingMilli === 0}
                    onChange={(e) => {
                      setQty((s) => ({ ...s, [l.lineNo]: e.target.value }))
                      setPayments([])
                    }}
                    placeholder="0"
                    aria-label={`Cantidad a devolver de ${l.name}`}
                    aria-invalid={Number.isNaN(q) || q > l.remainingMilli}
                    className="tabular h-9 w-20 text-right"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={l.remainingMilli === 0}
                    onClick={() => {
                      setQty((s) => ({ ...s, [l.lineNo]: toInputQty(l.remainingMilli) }))
                      setPayments([])
                    }}
                  >
                    Todo
                  </Button>
                </span>
                <span className="text-muted-foreground text-xs">
                  Vendido {formatQty(l.qtyMilli)} × {formatMoney(l.unitPriceMinor, doc)}
                  {l.discountMinor ? ` (desc. ${formatMoney(l.discountMinor, doc)})` : ""}
                  {l.returnedMilli ? ` · ya devuelto ${formatQty(l.returnedMilli)}` : ""}
                </span>
                <span className="text-right text-muted-foreground text-xs">
                  {Number.isNaN(q) || q > l.remainingMilli
                    ? `Máximo ${formatQty(l.remainingMilli)}`
                    : `Quedan ${formatQty(l.remainingMilli)}`}
                </span>
              </li>
            ))}
          </ul>
        )}

        {ticket.totalMinor > 0 ? (
          <>
            <div className="grid grid-cols-1 gap-1 rounded-lg bg-muted/60 p-3 text-sm">
              <div className="flex items-baseline justify-between">
                <span className="font-medium">Se devuelve</span>
                <span className="tabular font-bold text-xl">
                  {formatMoney(ticket.totalMinor, doc)}
                </span>
              </div>
              {credit ? (
                <div className="flex justify-between text-muted-foreground">
                  <span>Se descuenta de lo que debe</span>
                  <span className="tabular">
                    {formatMoney(credit.amountMinor, credit.currency)}
                  </span>
                </div>
              ) : null}
            </div>
            {debt && debtUsable ? (
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-[var(--primary)]"
                  checked={useDebt}
                  onChange={(e) => {
                    setUseDebt(e.target.checked)
                    setPayments([])
                  }}
                />
                <span>
                  El cliente todavía debe {formatMoney(debt.outstandingMinor, debt.currency)} de
                  esta venta: descontar la devolución de esa deuda
                </span>
              </label>
            ) : null}
            {checkout.settled && credit && payments.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No hay que devolver dinero: todo se descuenta de la deuda.
              </p>
            ) : (
              <>
                <p className="font-medium text-sm">¿Cómo se le devuelve el dinero?</p>
                <PaymentPanel
                  ctx={ctx}
                  ticket={ticket}
                  payments={payments}
                  setPayments={setPayments}
                  checkout={checkout}
                  change={change}
                  credit={credit}
                  quickBills={false}
                />
              </>
            )}
          </>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="success" size="lg" onClick={confirm} disabled={busy || !ready}>
            {busy ? "Registrando…" : "Registrar devolución"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
