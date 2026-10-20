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
  Field,
  Input,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { endOfDay } from "../../lib/days"
import { formatMoney, formatRate, parseAmount, toInputAmount } from "../../lib/format"
import {
  bootstrapQuery,
  currentShiftQuery,
  expenseCategoriesQuery,
  queryClient,
  rateStatusQuery,
} from "../../lib/queries"
import { ContactPicker } from "../contacts/ContactPicker"

const REFRESH = [
  "expenses",
  "expense-categories",
  "documents",
  "reports",
  "shifts",
  "payables",
  "recurring",
]

/** Los datos de un gasto recurrente que vence: se registra con ellos ya escritos. */
export interface ExpensePrefill {
  recurringId: string
  note: string
  categoryId: string
  contact: Contact | null
  currency: string
  amountMinor: number
}

/** Registra un gasto pagado al momento: en qué se gastó, cuánto y con qué se pagó. */
export function ExpenseDialog({
  prefill,
  onClose,
  onPosted,
}: {
  prefill?: ExpensePrefill
  onClose: () => void
  onPosted: (documentId: string) => void
}) {
  const boot = useQuery(bootstrapQuery)
  const categories = useQuery(expenseCategoriesQuery())
  const rate = useQuery(rateStatusQuery)
  const methods = boot.data?.paymentMethods ?? []
  const terminalId = boot.data?.terminals[0]?.id ?? ""
  const shift = useQuery({ ...currentShiftQuery(terminalId), enabled: terminalId !== "" })

  const [categoryId, setCategoryId] = useState(prefill?.categoryId ?? "")
  const [note, setNote] = useState(prefill?.note ?? "")
  // Con un recurrente en esa moneda se ofrece primero el método que la cobra.
  const [methodId, setMethodId] = useState(
    () => methods.find((m) => m.currency === prefill?.currency)?.id ?? "",
  )
  const [amount, setAmount] = useState(prefill ? toInputAmount(prefill.amountMinor) : "")
  const [reference, setReference] = useState("")
  const [invoice, setInvoice] = useState("")
  const [supplier, setSupplier] = useState<Contact | null>(prefill?.contact ?? null)
  // A deber: todavía no se pagó; queda en «Por pagar» hasta que se le pague al proveedor.
  const [onCredit, setOnCredit] = useState(false)
  const [debtCurrency, setDebtCurrency] = useState(prefill?.currency ?? "")
  const [dueDay, setDueDay] = useState("")
  const [busy, setBusy] = useState(false)
  // El id se fija al abrir: reenviar tras un corte de red no registra el gasto dos veces.
  const [documentId] = useState(() => uuidv7())
  const [paymentId] = useState(() => uuidv7())

  const list = categories.data ?? []
  const method = methods.find((m) => m.id === (methodId || methods[0]?.id))
  const legal = boot.data?.business.legalCurrency
  const reference_ = boot.data?.business.referenceCurrency
  // Moneda del gasto: la del método con que se paga, o la que se elija si queda a deber.
  const currency = onCredit ? debtCurrency || reference_ || legal || "" : (method?.currency ?? "")
  const current = rate.data?.current
  const minor = parseAmount(amount)
  const needsRate = currency !== "" && currency !== legal
  const toLegal =
    minor !== null && needsRate && current && current.quote === legal
      ? Math.round(minor * Number(current.value))
      : null
  const cashWithoutShift =
    !onCredit && method?.kind === "cash" && shift.isSuccess && shift.data === null
  const category = categoryId || list[0]?.id || ""

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!category || (!onCredit && !method)) return
    if (onCredit && !supplier) {
      toast.error("Elige el proveedor al que le debes")
      return
    }
    if (minor === null || minor <= 0) {
      toast.error("Escribe un monto válido")
      return
    }
    if (!note.trim()) {
      toast.error("Cuéntanos en qué se gastó")
      return
    }
    if (!onCredit && method?.requiresReference && !reference.trim()) {
      toast.error("Escribe la referencia del pago")
      return
    }
    if (needsRate && !current) {
      toast.error("Hace falta la tasa del día para registrar un gasto en divisas")
      return
    }
    setBusy(true)
    try {
      const posted = await api<PostedDocumentBody>("/api/expenses", {
        body: {
          id: documentId,
          terminalId,
          currency,
          rate:
            needsRate && current
              ? { base: current.base, quote: current.quote, value: current.value }
              : null,
          amountMinor: minor,
          categoryId: category,
          contactId: supplier?.id ?? null,
          externalRef: invoice.trim() || null,
          note: note.trim(),
          payments:
            onCredit || !method
              ? []
              : [
                  {
                    id: paymentId,
                    paymentMethodId: method.id,
                    currency: method.currency,
                    amountMinor: minor,
                    rate: null,
                    reference: reference.trim() || null,
                  },
                ],
          creditMinor: onCredit ? minor : 0,
          dueAt: onCredit && dueDay ? endOfDay(dueDay) : null,
          recurringId: prefill?.recurringId ?? null,
        },
      })
      await Promise.all(REFRESH.map((k) => queryClient.invalidateQueries({ queryKey: [k] })))
      toast.success(
        onCredit
          ? `Gasto ${posted.number} registrado a deber: ya está en Por pagar`
          : `Gasto ${posted.number} registrado`,
      )
      onPosted(posted.id)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nuevo gasto</DialogTitle>
          <DialogDescription>
            {prefill
              ? "Gasto recurrente: ya está escrito, solo falta decir cómo se paga."
              : "Lo que el negocio paga y no es mercancía: alquiler, luz, sueldos, fletes… El dinero sale de la cuenta con la que pagaste."}
          </DialogDescription>
        </DialogHeader>
        <form id="expense-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <Field label="¿En qué se gastó?" htmlFor="exp-note">
            <Input
              id="exp-note"
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Recibo de la luz de octubre"
              maxLength={500}
            />
          </Field>
          <Field label="Categoría" htmlFor="exp-category">
            <NativeSelect
              id="exp-category"
              value={category}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={onCredit ? "outline" : "default"}
              onClick={() => setOnCredit(false)}
            >
              Pagado ahora
            </Button>
            <Button
              type="button"
              variant={onCredit ? "default" : "outline"}
              onClick={() => setOnCredit(true)}
            >
              Dejar a deber
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr]">
            {onCredit ? (
              <Field label="Moneda en que se debe" htmlFor="exp-currency">
                <NativeSelect
                  id="exp-currency"
                  value={currency}
                  onChange={(e) => setDebtCurrency(e.target.value)}
                >
                  {[reference_, legal]
                    .filter((c, i, all): c is string => !!c && all.indexOf(c) === i)
                    .map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                </NativeSelect>
              </Field>
            ) : (
              <Field label="Pagado con" htmlFor="exp-method">
                <NativeSelect
                  id="exp-method"
                  value={method?.id ?? ""}
                  onChange={(e) => setMethodId(e.target.value)}
                >
                  {methods.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.currency})
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
            <Field label={`Monto${currency ? ` en ${currency}` : ""}`} htmlFor="exp-amount">
              <Input
                id="exp-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="tabular"
                placeholder="0,00"
              />
            </Field>
          </div>
          {toLegal !== null && legal && current ? (
            <p className="-mt-2 text-muted-foreground text-sm">
              ≈ {formatMoney(toLegal, legal)} a la tasa {formatRate(current.value)}
            </p>
          ) : null}
          {onCredit ? (
            <Field
              label="Pagar antes del (opcional)"
              htmlFor="exp-due"
              hint={
                supplier
                  ? "Si lo dejas vacío se usan los días de crédito del proveedor."
                  : "Elige abajo el proveedor al que le debes."
              }
            >
              <Input
                id="exp-due"
                type="date"
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value)}
              />
            </Field>
          ) : null}
          {!onCredit && method?.requiresReference ? (
            <Field label="Referencia del pago" htmlFor="exp-ref">
              <Input
                id="exp-ref"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                maxLength={100}
              />
            </Field>
          ) : null}
          {cashWithoutShift ? (
            <p className="rounded-md bg-warning/15 px-3 py-2 text-sm">
              Para pagar en efectivo hay que abrir el turno de la caja primero. Si pagaste por banco
              o Zelle, elige ese método.
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_160px]">
            <Field
              label={onCredit ? "A quién se le debe" : "A quién se le pagó (opcional)"}
              htmlFor="exp-supplier"
            >
              <ContactPicker
                kind="supplier"
                value={supplier}
                onChange={setSupplier}
                placeholder="Buscar proveedor por nombre o RIF"
              />
            </Field>
            <Field label="N.º de factura" htmlFor="exp-invoice">
              <Input
                id="exp-invoice"
                value={invoice}
                onChange={(e) => setInvoice(e.target.value)}
                maxLength={60}
              />
            </Field>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="expense-form"
            variant="success"
            disabled={busy || !category || (onCredit && !supplier)}
          >
            {busy ? "Registrando…" : onCredit ? "Registrar a deber" : "Registrar gasto"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
