import type { Account, PostedDocumentBody } from "@millhiore/contracts"
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
import { formatMoney, formatRate, parseAmount, toInputAmount } from "../../lib/format"
import {
  accountsQuery,
  bootstrapQuery,
  currentShiftQuery,
  queryClient,
  rateStatusQuery,
} from "../../lib/queries"

const REFRESH = ["accounts", "transfers", "documents", "reports", "shifts", "bootstrap"]

/** Lo que equivale `minor` de una moneda en otra con la tasa vigente (base→quote), o null. */
function convert(
  minor: number,
  from: string,
  to: string,
  rate: { base: string; quote: string; value: string } | null | undefined,
): number | null {
  if (from === to) return minor
  if (!rate) return null
  const value = Number(rate.value)
  if (from === rate.base && to === rate.quote) return Math.round(minor * value)
  if (from === rate.quote && to === rate.base) return Math.round(minor / value)
  return null
}

/** Mueve dinero de una cuenta a otra: del efectivo al banco, de Zelle a pago móvil, un cambio de divisas… */
export function TransferDialog({
  initialFrom,
  onClose,
  onPosted,
}: {
  initialFrom?: string
  onClose: () => void
  onPosted: (documentId: string) => void
}) {
  const boot = useQuery(bootstrapQuery)
  const accounts = useQuery(accountsQuery())
  const rate = useQuery(rateStatusQuery)
  const list = accounts.data ?? []
  const terminalId = boot.data?.terminals[0]?.id ?? ""
  const shift = useQuery({ ...currentShiftQuery(terminalId), enabled: terminalId !== "" })

  const [fromId, setFromId] = useState(initialFrom ?? "")
  const [toId, setToId] = useState("")
  const [amount, setAmount] = useState("")
  // Lo que recibe solo se escribe a mano si el usuario lo cambia; si no, sale de la tasa.
  const [received, setReceived] = useState<string | null>(null)
  const [reference, setReference] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  // El id se fija al abrir: reenviar tras un corte de red no transfiere dos veces.
  const [documentId] = useState(() => uuidv7())

  const from = list.find((a) => a.id === (fromId || list[0]?.id))
  const to =
    list.find((a) => a.id === toId && a.id !== from?.id) ?? list.find((a) => a.id !== from?.id)
  const current = rate.data?.current ?? null
  const minor = parseAmount(amount)
  const sameCurrency = !!from && !!to && from.currency === to.currency
  const suggested =
    minor !== null && from && to ? convert(minor, from.currency, to.currency, current) : null
  const receivedText = sameCurrency
    ? amount
    : (received ?? (suggested !== null ? toInputAmount(suggested) : ""))
  const receivedMinor = parseAmount(receivedText)
  const touchesCash = from?.kind === "cash" || to?.kind === "cash"
  const needsShift = touchesCash && shift.isSuccess && shift.data === null
  const noRate = !!from && !!to && !sameCurrency && suggested === null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!from || !to) return
    if (from.id === to.id) {
      toast.error("Elige dos cuentas distintas")
      return
    }
    if (minor === null || minor <= 0) {
      toast.error("Escribe el monto que sale")
      return
    }
    if (receivedMinor === null || receivedMinor <= 0) {
      toast.error("Escribe cuánto recibe la cuenta de destino")
      return
    }
    setBusy(true)
    try {
      const posted = await api<PostedDocumentBody>("/api/transfers", {
        body: {
          id: documentId,
          terminalId,
          fromAccountId: from.id,
          toAccountId: to.id,
          fromAmountMinor: minor,
          toAmountMinor: sameCurrency ? minor : receivedMinor,
          rate: current ? { base: current.base, quote: current.quote, value: current.value } : null,
          reference: reference.trim() || null,
          note: note.trim() || null,
        },
      })
      await Promise.all(REFRESH.map((k) => queryClient.invalidateQueries({ queryKey: [k] })))
      toast.success(`Transferencia ${posted.number} registrada`)
      onPosted(posted.id)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const option = (a: Account) => (
    <option key={a.id} value={a.id}>
      {a.name} ({a.currency}) · {formatMoney(a.balanceMinor, a.currency)}
    </option>
  )

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Transferir entre cuentas</DialogTitle>
          <DialogDescription>
            Mueve dinero de una cuenta a otra sin que sea una venta ni un gasto: del efectivo al
            banco, de Zelle a pago móvil, un cambio de divisas…
          </DialogDescription>
        </DialogHeader>
        <form id="transfer-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Sale de" htmlFor="tr-from">
              <NativeSelect
                id="tr-from"
                value={from?.id ?? ""}
                onChange={(e) => {
                  setFromId(e.target.value)
                  setReceived(null)
                }}
              >
                {list.map(option)}
              </NativeSelect>
            </Field>
            <Field label="Entra en" htmlFor="tr-to">
              <NativeSelect
                id="tr-to"
                value={to?.id ?? ""}
                onChange={(e) => {
                  setToId(e.target.value)
                  setReceived(null)
                }}
              >
                {list.filter((a) => a.id !== from?.id).map(option)}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={`Monto que sale${from ? ` (${from.currency})` : ""}`} htmlFor="tr-amount">
              <Input
                id="tr-amount"
                inputMode="decimal"
                autoFocus
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value)
                  setReceived(null)
                }}
                className="tabular"
                placeholder="0,00"
              />
            </Field>
            {sameCurrency ? null : (
              <Field label={`Recibe${to ? ` (${to.currency})` : ""}`} htmlFor="tr-received">
                <Input
                  id="tr-received"
                  inputMode="decimal"
                  value={receivedText}
                  onChange={(e) => setReceived(e.target.value)}
                  className="tabular"
                  placeholder="0,00"
                />
              </Field>
            )}
          </div>
          {!sameCurrency && current && suggested !== null ? (
            <p className="-mt-2 text-muted-foreground text-sm">
              Sugerido a la tasa {formatRate(current.value)}. Cámbialo si el banco aplicó otra.
            </p>
          ) : null}
          {noRate ? (
            <p className="rounded-md bg-warning/15 px-3 py-2 text-sm">
              Hace falta la tasa del día para sugerir cuánto recibe; escríbelo a mano.
            </p>
          ) : null}
          {needsShift ? (
            <p className="rounded-md bg-warning/15 px-3 py-2 text-sm">
              Para mover efectivo hay que abrir el turno de la caja primero.
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr]">
            <Field label="Referencia (opcional)" htmlFor="tr-ref">
              <Input
                id="tr-ref"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                maxLength={100}
              />
            </Field>
            <Field label="Nota (opcional)" htmlFor="tr-note">
              <Input
                id="tr-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Depósito del cierre"
                maxLength={500}
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
            form="transfer-form"
            variant="success"
            disabled={busy || !from || !to || list.length < 2}
          >
            {busy ? "Transfiriendo…" : "Transferir"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
