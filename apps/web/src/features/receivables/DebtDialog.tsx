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
import { formatMoney, formatRate, parseAmount } from "../../lib/format"
import { bootstrapQuery, currentShiftQuery, queryClient, rateStatusQuery } from "../../lib/queries"
import { useTerminal } from "../../lib/terminal"
import { ContactPicker } from "../contacts/ContactPicker"

const REFRESH = ["receivables", "payables", "documents", "reports", "shifts"]

const TEXT = {
  DEBT_IN: {
    title: "Anotar lo que te deben",
    description:
      "Lo que un cliente ya te debía antes de usar el sistema, o dinero que le prestaste. Se cobra con abonos como cualquier fiado.",
    who: "Cliente que debe",
    pick: "Buscar cliente por nombre o cédula",
    owed: "Ya me debía",
    loan: "Le presté dinero",
    method: "Salió de",
    due: "Si lo dejas vacío se usan los días de crédito del cliente.",
    done: (n: string) => `Deuda ${n} anotada: ya está en Fiado`,
  },
  DEBT_OUT: {
    title: "Anotar lo que debes",
    description:
      "Lo que ya le debías a un proveedor antes de usar el sistema, o dinero que te prestó. Se paga desde aquí como cualquier factura.",
    who: "Proveedor al que le debes",
    pick: "Buscar proveedor por nombre o RIF",
    owed: "Ya le debía",
    loan: "Me prestó dinero",
    method: "Entró a",
    due: "Si lo dejas vacío se usan los días de crédito del proveedor.",
    done: (n: string) => `Deuda ${n} anotada: ya está en Por pagar`,
  },
} as const

/**
 * Anota una deuda sin venta, compra o gasto detrás: un saldo de antes de usar el sistema o un
 * préstamo. Si fue un préstamo, el dinero sale (a un cliente) o entra (de un proveedor) de una cuenta.
 */
export function DebtDialog({
  type,
  onClose,
  onPosted,
}: {
  type: "DEBT_IN" | "DEBT_OUT"
  onClose: () => void
  onPosted: (documentId: string) => void
}) {
  const t = TEXT[type]
  const boot = useQuery(bootstrapQuery)
  const rate = useQuery(rateStatusQuery)
  const methods = boot.data?.paymentMethods ?? []
  const terminalId = useTerminal()?.id ?? ""
  const shift = useQuery({ ...currentShiftQuery(terminalId), enabled: terminalId !== "" })
  const legal = boot.data?.business.legalCurrency
  const referenceCurrency = boot.data?.business.referenceCurrency

  const [who, setWho] = useState<Contact | null>(null)
  const [note, setNote] = useState("")
  const [chosenCurrency, setCurrency] = useState("")
  const [amount, setAmount] = useState("")
  const [isLoan, setIsLoan] = useState(false)
  const [methodId, setMethodId] = useState("")
  const [reference, setReference] = useState("")
  const [externalRef, setExternalRef] = useState("")
  const [dueDay, setDueDay] = useState("")
  const [busy, setBusy] = useState(false)
  // El id se fija al abrir: reenviar tras un corte de red no anota la deuda dos veces.
  const [documentId] = useState(() => uuidv7())
  const [paymentId] = useState(() => uuidv7())

  const currencies = [referenceCurrency, legal].filter(
    (c, i, all): c is string => !!c && all.indexOf(c) === i,
  )
  const currency = chosenCurrency || currencies[0] || ""
  // Un préstamo se hace en la moneda de la deuda: solo sirven los métodos de esa moneda.
  const usable = methods.filter((m) => m.currency === currency)
  const method = usable.find((m) => m.id === methodId) ?? usable[0]
  const minor = parseAmount(amount)
  const current = rate.data?.current
  const needsRate = currency !== "" && currency !== legal
  const toLegal =
    minor !== null && needsRate && current && current.quote === legal
      ? Math.round(minor * Number(current.value))
      : null
  const cashWithoutShift =
    isLoan && method?.kind === "cash" && shift.isSuccess && shift.data === null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!who) {
      toast.error(type === "DEBT_IN" ? "Elige el cliente que debe" : "Elige el proveedor")
      return
    }
    if (minor === null || minor <= 0) {
      toast.error("Escribe un monto válido")
      return
    }
    if (isLoan && !method) {
      toast.error(`No hay un método de pago en ${currency}`)
      return
    }
    if (isLoan && method?.requiresReference && !reference.trim()) {
      toast.error("Escribe la referencia")
      return
    }
    if (needsRate && !current) {
      toast.error("Hace falta la tasa del día para anotar una deuda en divisas")
      return
    }
    setBusy(true)
    try {
      const posted = await api<PostedDocumentBody>("/api/debts", {
        body: {
          id: documentId,
          type,
          terminalId,
          contactId: who.id,
          currency,
          rate:
            needsRate && current
              ? { base: current.base, quote: current.quote, value: current.value }
              : null,
          amountMinor: minor,
          note: note.trim() || (isLoan ? "Préstamo" : "Saldo anterior"),
          externalRef: externalRef.trim() || null,
          dueAt: dueDay ? endOfDay(dueDay) : null,
          payments:
            isLoan && method
              ? [
                  {
                    id: paymentId,
                    paymentMethodId: method.id,
                    currency: method.currency,
                    amountMinor: minor,
                    rate: null,
                    reference: reference.trim() || null,
                  },
                ]
              : [],
        },
      })
      await Promise.all(REFRESH.map((k) => queryClient.invalidateQueries({ queryKey: [k] })))
      toast.success(t.done(posted.number))
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
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.description}</DialogDescription>
        </DialogHeader>
        <form id="debt-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <Field label={t.who} htmlFor="debt-who">
            <ContactPicker
              kind={type === "DEBT_IN" ? "customer" : "supplier"}
              value={who}
              onChange={setWho}
              placeholder={t.pick}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={isLoan ? "outline" : "default"}
              onClick={() => setIsLoan(false)}
            >
              {t.owed}
            </Button>
            <Button
              type="button"
              variant={isLoan ? "default" : "outline"}
              onClick={() => setIsLoan(true)}
            >
              {t.loan}
            </Button>
          </div>
          <Field label="¿Qué es? (opcional)" htmlFor="debt-note">
            <Input
              id="debt-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={isLoan ? "Préstamo" : "Saldo anterior"}
              maxLength={500}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr]">
            <Field label="Moneda en que se debe" htmlFor="debt-currency">
              <NativeSelect
                id="debt-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={`Monto${currency ? ` en ${currency}` : ""}`} htmlFor="debt-amount">
              <Input
                id="debt-amount"
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
          {isLoan ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr]">
              <Field label={t.method} htmlFor="debt-method">
                <NativeSelect
                  id="debt-method"
                  value={method?.id ?? ""}
                  onChange={(e) => setMethodId(e.target.value)}
                >
                  {usable.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {method?.requiresReference ? (
                <Field label="Referencia" htmlFor="debt-ref">
                  <Input
                    id="debt-ref"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    maxLength={100}
                  />
                </Field>
              ) : null}
            </div>
          ) : null}
          {cashWithoutShift ? (
            <p className="rounded-md bg-warning/15 px-3 py-2 text-sm">
              Para mover efectivo hay que abrir el turno de la caja primero. Si fue por banco o
              Zelle, elige ese método.
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr]">
            <Field label="Pagar antes del (opcional)" htmlFor="debt-due" hint={t.due}>
              <Input
                id="debt-due"
                type="date"
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value)}
              />
            </Field>
            <Field label="N.º de factura o pagaré" htmlFor="debt-ext">
              <Input
                id="debt-ext"
                value={externalRef}
                onChange={(e) => setExternalRef(e.target.value)}
                maxLength={60}
              />
            </Field>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form="debt-form" variant="success" disabled={busy || !who}>
            {busy ? "Anotando…" : "Anotar deuda"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
