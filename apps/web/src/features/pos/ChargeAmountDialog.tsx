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
import { useState } from "react"
import { currencySymbol, formatMoney, parseAmount, toInputAmount } from "../../lib/format"
import type { PosContext } from "./compute"

/**
 * Monto de un recargo fijo para esta venta (el delivery cambia según la distancia), en bolívares o
 * en la moneda de referencia. «Usar el sugerido» vuelve al de la configuración.
 */
export function ChargeAmountDialog({
  ctx,
  chargeId,
  current,
  onApply,
  onClose,
}: {
  ctx: PosContext
  chargeId: string
  current: { amountMinor: number; currency: string } | undefined
  onApply: (amount: { amountMinor: number; currency: string } | undefined) => void
  onClose: () => void
}) {
  const info = ctx.charges.get(chargeId)
  const suggested = info
    ? { amountMinor: info.amountMinor, currency: info.currency ?? ctx.docCurrency }
    : undefined
  const start = current ?? suggested
  const [currency, setCurrency] = useState(start?.currency ?? ctx.docCurrency)
  const [text, setText] = useState(start ? toInputAmount(start.amountMinor) : "")
  const parsed = parseAmount(text)
  const currencies = [...new Set([ctx.docCurrency, ctx.refCurrency])].filter(
    (c) => c === ctx.docCurrency || ctx.rate !== null,
  )
  if (!info) return null

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{info.name}</DialogTitle>
          <DialogDescription>
            Cuánto se cobra en esta venta.
            {suggested
              ? ` El sugerido es ${formatMoney(suggested.amountMinor, suggested.currency)}.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <form
          id="charge-amount"
          className="grid grid-cols-[1fr_auto] gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (parsed !== null) onApply({ amountMinor: parsed, currency })
          }}
        >
          <Field
            label="Monto"
            htmlFor="charge-amount-value"
            error={text && parsed === null ? "Escribe un monto válido" : undefined}
          >
            <Input
              id="charge-amount-value"
              autoFocus
              inputMode="decimal"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="tabular"
            />
          </Field>
          <Field label="Moneda" htmlFor="charge-amount-currency">
            <NativeSelect
              id="charge-amount-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {currencySymbol(c)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onApply(undefined)}>
            Usar el sugerido
          </Button>
          <Button type="submit" form="charge-amount" disabled={parsed === null}>
            Aplicar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
