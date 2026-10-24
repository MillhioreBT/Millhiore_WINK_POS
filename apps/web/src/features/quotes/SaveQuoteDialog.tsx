import type { Contact, CreateQuoteBody, QuoteDetail } from "@millhiore/contracts"
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
  Textarea,
} from "@millhiore/ui"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatMoney } from "../../lib/format"
import { queryClient } from "../../lib/queries"
import { ContactPicker } from "../contacts/ContactPicker"
import {
  convertMinor,
  type DiscountSpec,
  type PosContext,
  priceWithList,
  type Ticket,
  type TicketCharge,
} from "../pos/compute"
import type { TicketLine } from "../pos/store"

/**
 * Guarda el ticket de la caja como cotización: cada producto con el precio con que se ofrece (ya
 * con la lista de precios), los descuentos y los recargos. No mueve inventario ni dinero.
 */
export function SaveQuoteDialog({
  ctx,
  lines,
  ticket,
  priceListId,
  saleDiscount,
  charges,
  initialContact,
  onClose,
  onSaved,
}: {
  ctx: PosContext
  lines: TicketLine[]
  ticket: Ticket
  priceListId: string | null
  saleDiscount: DiscountSpec | null
  charges: TicketCharge[]
  initialContact: Contact | null
  onClose: () => void
  onSaved: (quote: QuoteDetail) => void
}) {
  const [id] = useState(() => uuidv7())
  const [customer, setCustomer] = useState<Contact | null>(initialContact)
  const [days, setDays] = useState("7")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const validDays = Number(days)
  const daysOk = Number.isInteger(validDays) && validDays >= 0 && validDays <= 365
  const totalRef = convertMinor(ctx, ticket.totalMinor, ctx.docCurrency, ctx.refCurrency)

  const save = async () => {
    if (!daysOk) return
    setBusy(true)
    const body: CreateQuoteBody = {
      id,
      contactId: customer?.id ?? null,
      validDays,
      note: note.trim() || null,
      lines: lines.map((l) => {
        const price = l.fixedPrice ? l : priceWithList(ctx, priceListId, l.variantId, l)
        return {
          variantId: l.variantId,
          qtyMilli: l.qtyMilli,
          priceMinor: price.priceMinor,
          priceCurrency: price.priceCurrency,
          discount: l.discount ?? null,
        }
      }),
      saleDiscount,
      charges,
      totalLegalMinor: ticket.totalMinor,
      totalRefMinor: totalRef,
      rateValue: ctx.rate?.value ?? null,
    }
    try {
      const saved = await api<QuoteDetail>("/api/quotes", { body })
      await queryClient.invalidateQueries({ queryKey: ["quotes"] })
      toast.success(`Cotización ${saved.number} guardada`)
      onSaved(saved)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Guardar como cotización</DialogTitle>
          <DialogDescription>
            {formatMoney(ticket.totalMinor, ctx.docCurrency)}
            {totalRef !== null ? ` (${formatMoney(totalRef, ctx.refCurrency)})` : ""}. Los precios
            quedan congelados mientras valga; no se descuenta inventario.
          </DialogDescription>
        </DialogHeader>
        <ContactPicker
          kind="customer"
          value={customer}
          onChange={setCustomer}
          placeholder="Cliente (opcional): nombre, cédula o teléfono"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr]">
          <Field label="Vale por (días)" htmlFor="q-days" error={daysOk ? undefined : "De 0 a 365"}>
            <Input
              id="q-days"
              inputMode="numeric"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="tabular"
            />
          </Field>
          <Field label="Nota" htmlFor="q-note" hint="Sale en la cotización">
            <Textarea
              id="q-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              className="min-h-10"
              placeholder="Opcional: condiciones, forma de entrega…"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={busy || !daysOk}>
            {busy ? "Guardando…" : "Guardar cotización"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
