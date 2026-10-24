import type { PostedDocumentBody, Statement } from "@millhiore/contracts"
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
import { formatMoney, parseAmount, toInputAmount } from "../../lib/format"
import { bootstrapQuery, queryClient, rateStatusQuery, statementQuery } from "../../lib/queries"
import { deviceTerminal } from "../../lib/terminal"
import {
  computeCheckout,
  makeContext,
  type PaymentEntry,
  paymentRate,
  type Ticket,
} from "../pos/compute"
import { PaymentPanel, useChange } from "../pos/PaymentPanel"

/** Reparte un abono entre las ventas pendientes, las más antiguas primero. */
export function allocate(open: Statement["open"], amountMinor: number) {
  const out: { sale: Statement["open"][number]; amountMinor: number }[] = []
  let left = amountMinor
  for (const sale of open) {
    if (left <= 0) break
    const part = Math.min(left, sale.outstandingMinor)
    out.push({ sale, amountMinor: part })
    left -= part
  }
  return out
}

/** Cobra un abono a un cliente que debe: se aplica a sus ventas más antiguas. */
export function CollectDialog({
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
  const statement = useQuery(statementQuery(contactId))
  const data = statement.data
  const [currencyChoice, setCurrencyChoice] = useState<string | null>(null)
  const [amountText, setAmountText] = useState("")
  const [payments, setPayments] = useState<PaymentEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [documentId] = useState(() => uuidv7())

  const currency = currencyChoice ?? data?.balances[0]?.currency ?? ""
  const balance = data?.balances.find((b) => b.currency === currency)
  const open = useMemo(
    () => (data?.open ?? []).filter((s) => s.currency === currency),
    [data, currency],
  )

  // El abono es un documento en la moneda de la deuda; se paga con cualquier método y se convierte.
  const ctx = useMemo(() => {
    if (!boot.data || !currency) return null
    return { ...makeContext(boot.data, rate.data?.current?.value ?? null), docCurrency: currency }
  }, [boot.data, rate.data, currency])
  const amount = parseAmount(amountText)
  const amountMinor = amount !== null && balance ? Math.min(amount, balance.outstandingMinor) : 0
  const ticket = useMemo<Ticket>(
    () => ({
      lineTotals: [],
      charges: [],
      discountMinor: 0,
      taxes: [],
      totalMinor: amountMinor,
      taxMinor: 0,
    }),
    [amountMinor],
  )
  const checkout = useMemo(
    () => (ctx ? computeCheckout(ctx, ticket, payments) : null),
    [ctx, ticket, payments],
  )

  if (!ctx || !checkout || !data) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <DialogTitle>Cobrar abono</DialogTitle>
          <DialogDescription>
            {statement.isError ? "No se pudo cargar la cuenta." : "Cargando…"}
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
    <CollectBody
      ctx={ctx}
      data={data}
      open={open}
      currency={currency}
      balanceMinor={balance?.outstandingMinor ?? 0}
      amountText={amountText}
      setAmountText={setAmountText}
      amountMinor={amountMinor}
      ticket={ticket}
      payments={payments}
      setPayments={setPayments}
      checkout={checkout}
      setCurrencyChoice={(c) => {
        setCurrencyChoice(c)
        setAmountText("")
        setPayments([])
      }}
      busy={busy}
      onClose={onClose}
      onConfirm={async (final) => {
        setBusy(true)
        try {
          const posted = await api<PostedDocumentBody>("/api/documents", {
            body: {
              id: documentId,
              type: "PAYMENT_IN",
              terminalId: boot.data ? deviceTerminal(boot.data)?.id : undefined,
              currency,
              rate: ctx.rate,
              contactId,
              allocations: allocate(open, amountMinor).map((a) => ({
                saleDocumentId: a.sale.id,
                amountMinor: a.amountMinor,
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
            queryClient.invalidateQueries({ queryKey: ["receivables"] }),
            queryClient.invalidateQueries({ queryKey: ["documents"] }),
            queryClient.invalidateQueries({ queryKey: ["reports"] }),
            queryClient.invalidateQueries({ queryKey: ["shifts"] }),
          ])
          toast.success(`Abono ${posted.number} registrado`)
          onPosted(posted.id)
        } catch (e) {
          toast.error(errorMessage(e))
        } finally {
          setBusy(false)
        }
      }}
    />
  )
}

function CollectBody({
  ctx,
  data,
  open,
  currency,
  balanceMinor,
  amountText,
  setAmountText,
  amountMinor,
  ticket,
  payments,
  setPayments,
  checkout,
  setCurrencyChoice,
  busy,
  onClose,
  onConfirm,
}: {
  ctx: NonNullable<ReturnType<typeof makeContext>>
  data: Statement
  open: Statement["open"]
  currency: string
  balanceMinor: number
  amountText: string
  setAmountText: (v: string) => void
  amountMinor: number
  ticket: Ticket
  payments: PaymentEntry[]
  setPayments: React.Dispatch<React.SetStateAction<PaymentEntry[]>>
  checkout: ReturnType<typeof computeCheckout>
  setCurrencyChoice: (c: string) => void
  busy: boolean
  onClose: () => void
  onConfirm: (final: PaymentEntry[]) => Promise<void>
}) {
  const change = useChange(ctx, checkout)
  const parts = allocate(open, amountMinor)
  const ready = amountMinor > 0 && (checkout.settled || change.overpaid)

  const confirm = () => {
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
    void onConfirm(final)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cobrar abono · {data.contact.name}</DialogTitle>
          <DialogDescription>
            Debe {formatMoney(balanceMinor, currency)}. El abono se aplica a lo más antiguo primero.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
          <Field
            label={`Monto a abonar en ${currency === "VES" ? "Bs" : currency}`}
            htmlFor="abono"
          >
            <Input
              id="abono"
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
            {data.balances.length > 1 ? (
              <NativeSelect
                value={currency}
                onChange={(e) => setCurrencyChoice(e.target.value)}
                aria-label="Moneda de la deuda"
                className="h-12 w-auto"
              >
                {data.balances.map((b) => (
                  <option key={b.currency} value={b.currency}>
                    {b.currency}
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

        {parts.length ? (
          <ul className="divide-y rounded-lg border text-sm">
            {parts.map((p) => (
              <li key={p.sale.id} className="flex justify-between gap-3 px-3 py-2">
                <span>
                  {p.sale.kind === "DEBT_IN" ? `${p.sale.label} · ` : ""}
                  {p.sale.number}
                  <span className="text-muted-foreground">
                    {" "}
                    · debe {formatMoney(p.sale.outstandingMinor, currency)}
                  </span>
                </span>
                <span className="tabular font-medium">{formatMoney(p.amountMinor, currency)}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {amountMinor > 0 ? (
          <>
            <div className="flex items-baseline justify-between rounded-lg bg-muted/60 p-3 text-sm">
              <span className="font-medium">A cobrar</span>
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
            />
          </>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Volver
          </Button>
          <Button variant="success" size="lg" onClick={confirm} disabled={busy || !ready}>
            {busy ? "Registrando…" : "Registrar abono"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
