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
import { formatMoney, formatPercent, parseAmount, toInputAmount } from "../../lib/format"
import { type DiscountSpec, discountOf, type PosContext } from "./compute"

const QUICK = [500, 1000, 1500, 2000]

/**
 * Pide un descuento: un porcentaje o un monto (en Bs o en la moneda de referencia). Muestra al
 * momento cuánto descuenta y cuánto queda. `baseMinor` es el importe en la moneda del documento.
 */
export function DiscountDialog({
  ctx,
  title,
  description,
  baseMinor,
  initial,
  onApply,
  onClose,
}: {
  ctx: PosContext
  title: string
  description: string
  baseMinor: number
  initial: DiscountSpec | null
  onApply: (spec: DiscountSpec | null) => void
  onClose: () => void
}) {
  const [kind, setKind] = useState<DiscountSpec["kind"]>(initial?.kind ?? "percent")
  const [currency, setCurrency] = useState(
    initial?.kind === "amount" ? initial.currency : ctx.docCurrency,
  )
  const [text, setText] = useState(() =>
    initial
      ? initial.kind === "percent"
        ? toInputAmount(initial.bp)
        : toInputAmount(initial.amountMinor)
      : "",
  )

  const parsed = parseAmount(text)
  const spec: DiscountSpec | null =
    parsed === null || parsed <= 0
      ? null
      : kind === "percent"
        ? parsed <= 10_000
          ? { kind, bp: parsed }
          : null
        : { kind, amountMinor: parsed, currency }
  const off = spec ? discountOf(ctx, spec, baseMinor) : 0
  const doc = ctx.docCurrency
  const currencies = [...new Set([doc, ctx.refCurrency])].filter(
    (c) => c === doc || ctx.rate !== null,
  )
  const tooMuch =
    spec?.kind === "amount" &&
    (discountOf(ctx, { ...spec, amountMinor: spec.amountMinor }, Number.MAX_SAFE_INTEGER) ?? 0) >
      baseMinor

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          id="discount-form"
          className="grid grid-cols-1 gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (spec && off > 0) onApply(spec)
          }}
        >
          <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Tipo de descuento">
            {(
              [
                ["percent", "Porcentaje"],
                ["amount", "Monto"],
              ] as const
            ).map(([k, label]) => (
              <Button
                key={k}
                type="button"
                role="tab"
                aria-selected={kind === k}
                variant={kind === k ? "default" : "outline"}
                onClick={() => {
                  setKind(k)
                  setText("")
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Field
              label={kind === "percent" ? "Porcentaje (%)" : "Monto a descontar"}
              htmlFor="disc"
            >
              <Input
                id="disc"
                inputMode="decimal"
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="tabular h-12 text-lg"
                placeholder={kind === "percent" ? "10" : "0,00"}
              />
            </Field>
            {kind === "amount" ? (
              <Field label="En" htmlFor="disc-cur">
                <NativeSelect
                  id="disc-cur"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="h-12"
                >
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {c === "VES" ? "Bs" : c}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
          </div>
          {kind === "percent" ? (
            <div className="flex flex-wrap gap-2">
              {QUICK.map((bp) => (
                <Button
                  key={bp}
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setText(toInputAmount(bp))}
                >
                  {formatPercent(bp)}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="rounded-lg bg-muted/60 p-3 text-sm">
            <div className="flex justify-between">
              <span>Importe</span>
              <span className="tabular">{formatMoney(baseMinor, doc)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Descuento</span>
              <span className="tabular">-{formatMoney(off, doc)}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>Queda</span>
              <span className="tabular">{formatMoney(baseMinor - off, doc)}</span>
            </div>
            {tooMuch ? (
              <p className="mt-1 text-muted-foreground text-xs">
                El monto supera el importe: solo se descuenta hasta el total.
              </p>
            ) : null}
          </div>
        </form>
        <DialogFooter>
          {initial ? (
            <Button variant="outline" className="mr-auto" onClick={() => onApply(null)}>
              Quitar descuento
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="discount-form" disabled={!spec || off <= 0}>
            Aplicar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
