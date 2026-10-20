import type { Bootstrap, OpenPayable, Payables, PostedDocumentBody } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatDateTime, formatMoney, parseAmount, toInputAmount } from "../../lib/format"
import { bootstrapQuery, payablesQuery, queryClient, rateStatusQuery } from "../../lib/queries"
import {
  computeCheckout,
  makeContext,
  type PaymentEntry,
  paymentRate,
  type Ticket,
} from "../pos/compute"
import { PaymentPanel, useChange } from "../pos/PaymentPanel"

const day = (ms: number) => formatDateTime(ms).split(",")[0]

/** Reparte un pago entre las facturas pendientes, las más antiguas primero. */
export function allocateDebt(open: readonly OpenPayable[], amountMinor: number) {
  const out: { debt: OpenPayable; amountMinor: number }[] = []
  let left = amountMinor
  for (const debt of open) {
    if (left <= 0) break
    const part = Math.min(left, debt.outstandingMinor)
    out.push({ debt, amountMinor: part })
    left -= part
  }
  return out
}

/** Paga a un proveedor: se aplica a las facturas que se marquen, o a las más antiguas primero. */
export function PayDialog({
  contactId,
  onClose,
  onPosted,
}: {
  contactId: string
  onClose: () => void
  onPosted: (documentId: string) => void
}) {
  const boot = useQuery(bootstrapQuery)
  const rate = useQuery(rateStatusQuery)
  const payables = useQuery(payablesQuery)
  const rows = (payables.data?.suppliers ?? []).filter((s) => s.contactId === contactId)

  if (!boot.data || rows.length === 0) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogTitle>Pagar a proveedor</DialogTitle>
          <DialogDescription>
            {payables.isError
              ? "No se pudo cargar la cuenta."
              : payables.isLoading || boot.isLoading
                ? "Cargando…"
                : "Este proveedor ya no tiene nada pendiente."}
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
    <PayBody
      boot={boot.data}
      rateValue={rate.data?.current?.value ?? null}
      contactId={contactId}
      rows={rows}
      onClose={onClose}
      onPosted={onPosted}
    />
  )
}

function PayBody({
  boot,
  rateValue,
  contactId,
  rows,
  onClose,
  onPosted,
}: {
  boot: Bootstrap
  rateValue: string | null
  contactId: string
  rows: Payables["suppliers"]
  onClose: () => void
  onPosted: (documentId: string) => void
}) {
  const [currencyChoice, setCurrencyChoice] = useState<string | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [amountText, setAmountText] = useState("")
  const [payments, setPayments] = useState<PaymentEntry[]>([])
  const [busy, setBusy] = useState(false)
  // El id se fija al abrir: reenviar tras un corte de red no paga dos veces.
  const [documentId] = useState(() => uuidv7())

  const currency = currencyChoice ?? rows[0]?.currency ?? ""
  const row = rows.find((r) => r.currency === currency) ?? rows[0]
  // Con facturas marcadas se paga solo de esas; sin marcar, de todas.
  const open = useMemo(
    () => (row?.open ?? []).filter((o) => picked.size === 0 || picked.has(o.id)),
    [row, picked],
  )
  const balanceMinor = open.reduce((acc, o) => acc + o.outstandingMinor, 0)

  // El pago es un documento en la moneda de la deuda; se paga con cualquier método y se convierte.
  // Un pago a proveedor no lleva IGTF.
  const ctx = useMemo(() => {
    const base = makeContext(boot, rateValue)
    return {
      ...base,
      docCurrency: currency,
      methods: base.methods.map((m) => ({ ...m, surcharge: null })),
    }
  }, [boot, rateValue, currency])
  const amount = parseAmount(amountText)
  const amountMinor = amount !== null ? Math.min(amount, balanceMinor) : 0
  const ticket = useMemo<Ticket>(
    () => ({ lineTotals: [], discountMinor: 0, taxes: [], totalMinor: amountMinor, taxMinor: 0 }),
    [amountMinor],
  )
  const checkout = useMemo(() => computeCheckout(ctx, ticket, payments), [ctx, ticket, payments])
  const change = useChange(ctx, checkout)

  if (!row) return null
  const parts = allocateDebt(open, amountMinor)
  const ready = amountMinor > 0 && checkout.settled

  const reset = () => {
    setAmountText("")
    setPayments([])
  }
  const toggle = (id: string) => {
    setPicked((s) => {
      const next = new Set(s)
      if (!next.delete(id)) next.add(id)
      return next
    })
    reset()
  }

  const confirm = async () => {
    setBusy(true)
    try {
      const posted = await api<PostedDocumentBody>("/api/documents", {
        body: {
          id: documentId,
          type: "PAYMENT_OUT",
          terminalId: boot.terminals[0]?.id,
          currency,
          rate: ctx.rate,
          contactId,
          allocations: parts.map((p) => ({
            saleDocumentId: p.debt.id,
            amountMinor: p.amountMinor,
          })),
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
        ["payables", "expenses", "documents", "reports", "shifts"].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      )
      toast.success(`Pago ${posted.number} registrado`)
      onPosted(posted.id)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pagar a {row.name}</DialogTitle>
          <DialogDescription>
            Se le debe {formatMoney(row.outstandingMinor, currency)}. Marca las facturas que vas a
            pagar; si no marcas ninguna, se paga de la más antigua a la más nueva.
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-48 divide-y overflow-y-auto rounded-lg border text-sm">
          {row.open.map((o) => (
            <li key={o.id}>
              <label className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-accent/40">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--primary)]"
                  checked={picked.has(o.id)}
                  onChange={() => toggle(o.id)}
                  aria-label={`Pagar ${o.number}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{o.label}</span>
                  <span className="block text-muted-foreground text-xs">
                    {o.number}
                    {o.externalRef ? ` · Fact. ${o.externalRef}` : ""} · {day(o.postedAt)}
                    {o.dueAt ? (
                      <span className={o.overdue ? "font-medium text-destructive" : ""}>
                        {" "}
                        · vence {day(o.dueAt)}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="tabular shrink-0 font-medium">
                  {formatMoney(o.outstandingMinor, currency)}
                </span>
              </label>
            </li>
          ))}
        </ul>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
          <Field
            label={`Monto a pagar en ${currency === "VES" ? "Bs" : currency}`}
            htmlFor="pay-amount"
          >
            <Input
              id="pay-amount"
              inputMode="decimal"
              autoFocus
              value={amountText}
              onChange={(e) => {
                setAmountText(e.target.value)
                setPayments([])
              }}
              className="tabular h-12 text-lg"
            />
          </Field>
          <div className="flex items-end gap-2">
            {rows.length > 1 ? (
              <NativeSelect
                value={currency}
                onChange={(e) => {
                  setCurrencyChoice(e.target.value)
                  setPicked(new Set())
                  reset()
                }}
                aria-label="Moneda de la deuda"
                className="h-12 w-auto"
              >
                {rows.map((r) => (
                  <option key={r.currency} value={r.currency}>
                    {r.currency}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
            <Button
              variant="outline"
              className="h-12"
              onClick={() => {
                setAmountText(toInputAmount(balanceMinor))
                setPayments([])
              }}
            >
              Todo
            </Button>
          </div>
        </div>

        {amountMinor > 0 ? (
          <>
            <div className="flex items-baseline justify-between rounded-lg bg-muted/60 p-3 text-sm">
              <span className="font-medium">A pagar</span>
              <span className="tabular font-bold text-xl">
                {formatMoney(checkout.dueMinor, currency)}
              </span>
            </div>
            <PaymentPanel
              ctx={ctx}
              ticket={ticket}
              payments={payments}
              setPayments={setPayments}
              checkout={checkout}
              change={change}
              quickBills={false}
            />
          </>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Volver
          </Button>
          <Button variant="success" size="lg" onClick={confirm} disabled={busy || !ready}>
            {busy ? "Registrando…" : "Registrar pago"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
