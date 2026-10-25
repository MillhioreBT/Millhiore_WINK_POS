import type { ProductUnit } from "@millhiore/contracts"
import { lineTotal } from "@millhiore/domain"
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
import { WeightIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import {
  currencySymbol,
  formatMoney,
  formatQtyUnit,
  parseAmount,
  perUnit,
  toInputAmount,
} from "../../lib/format"
import { loadScaleDevice, readScale, scaleSupported } from "../../lib/scale"
import { useFeatures } from "../../lib/session"
import { type PosContext, qtyForMoney } from "./compute"

/**
 * Cuánto se vende de un producto: el peso (leído de la balanza o escrito), la cantidad, o lo que
 * pide el cliente en dinero («dame 5 $ de queso»). También cambia la cantidad de una línea.
 */
export function QuantityDialog({
  item,
  ctx,
  unitPriceMinor: unitPrice,
  initialQtyMilli,
  onConfirm,
  onClose,
}: {
  item: { name: string; unit: ProductUnit }
  ctx: PosContext
  /** Precio por unidad (o por kilo…) en la moneda del ticket; null si no se puede convertir. */
  unitPriceMinor: number | null
  /** Para cambiar la de una línea que ya está en el ticket. */
  initialQtyMilli?: number | undefined
  onConfirm: (qtyMilli: number) => void
  onClose: () => void
}) {
  const features = useFeatures()
  const byUnit = item.unit === "unit"
  const doc = ctx.docCurrency
  const [mode, setMode] = useState<"qty" | "money">("qty")
  const [qtyText, setQtyText] = useState(
    initialQtyMilli === undefined
      ? byUnit
        ? "1"
        : ""
      : initialQtyMilli % 1000 === 0
        ? String(initialQtyMilli / 1000)
        : toInputAmount(initialQtyMilli, 3).replace(/0+$/, ""),
  )
  const [moneyText, setMoneyText] = useState("")
  const [moneyCurrency, setMoneyCurrency] = useState(ctx.refCurrency)
  const currencies = [...new Set([doc, ctx.refCurrency])].filter(
    (c) => c === doc || ctx.rate !== null,
  )

  // La balanza solo pesa kilos, y solo si este equipo tiene una conectada.
  const device = item.unit === "kg" && features.scale && scaleSupported() ? loadScaleDevice() : null
  const [reading, setReading] = useState<"idle" | "busy" | "unstable" | "error">("idle")
  const [scaleError, setScaleError] = useState<string | null>(null)
  const weigh = useCallback(async () => {
    if (!device) return
    setReading("busy")
    setScaleError(null)
    try {
      const { reading: r } = await readScale(device)
      if (!r) throw new Error("La balanza no mandó un peso: revisa el cable y la configuración")
      if (r.weightMilli <= 0) throw new Error("Pon el producto en la balanza")
      setMode("qty")
      setQtyText(toInputAmount(r.weightMilli, 3))
      setReading(r.stable ? "idle" : "unstable")
    } catch (e) {
      setScaleError((e as Error).message)
      setReading("error")
    }
  }, [device])
  // Con la balanza conectada, se pesa apenas se abre (si no se está cambiando una línea).
  const [autoWeighed, setAutoWeighed] = useState(false)
  useEffect(() => {
    if (!device || autoWeighed || initialQtyMilli !== undefined) return
    setAutoWeighed(true)
    void weigh()
  }, [device, autoWeighed, initialQtyMilli, weigh])

  const money = parseAmount(moneyText)
  const qtyMilli =
    mode === "qty"
      ? parseAmount(qtyText, 3)
      : money === null
        ? null
        : qtyForMoney(ctx, { minor: money, currency: moneyCurrency }, unitPrice)
  const valid = qtyMilli !== null && qtyMilli > 0
  const total = valid && unitPrice !== null ? lineTotal(qtyMilli, unitPrice) : null
  const qtyLabel =
    item.unit === "kg" ? "Peso (kg)" : item.unit === "unit" ? "Cantidad" : `Cantidad (${item.unit})`

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{item.name}</DialogTitle>
          <DialogDescription>
            {unitPrice === null
              ? "Sin tasa no se puede calcular el precio."
              : `${formatMoney(unitPrice, doc)}${perUnit(item.unit)}`}
          </DialogDescription>
        </DialogHeader>
        {byUnit ? null : (
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist">
            {(
              [
                ["qty", item.unit === "kg" ? "Por peso" : "Por cantidad"],
                ["money", "Por monto"],
              ] as const
            ).map(([id, label]) => (
              <Button
                key={id}
                role="tab"
                aria-selected={mode === id}
                variant={mode === id ? "secondary" : "ghost"}
                size="sm"
                className={mode === id ? "bg-background shadow-xs" : ""}
                onClick={() => setMode(id)}
              >
                {label}
              </Button>
            ))}
          </div>
        )}
        <form
          id="qty-form"
          className="grid grid-cols-1 gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (valid) onConfirm(qtyMilli)
          }}
        >
          {mode === "qty" ? (
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              <Field
                label={qtyLabel}
                htmlFor="qty-value"
                error={qtyText && !valid ? "Escribe una cantidad válida" : undefined}
              >
                <Input
                  id="qty-value"
                  autoFocus={!device}
                  inputMode="decimal"
                  value={qtyText}
                  onChange={(e) => {
                    setQtyText(e.target.value)
                    setReading("idle")
                  }}
                  onFocus={(e) => e.target.select()}
                  className="tabular h-11 text-lg"
                />
              </Field>
              {device ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  disabled={reading === "busy"}
                  onClick={() => void weigh()}
                >
                  <WeightIcon /> {reading === "busy" ? "Pesando…" : "Pesar"}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Field label="Monto" htmlFor="qty-money">
                <Input
                  id="qty-money"
                  autoFocus
                  inputMode="decimal"
                  value={moneyText}
                  onChange={(e) => setMoneyText(e.target.value)}
                  className="tabular h-11 text-lg"
                />
              </Field>
              <Field label="Moneda" htmlFor="qty-money-currency">
                <NativeSelect
                  id="qty-money-currency"
                  value={moneyCurrency}
                  onChange={(e) => setMoneyCurrency(e.target.value)}
                  className="h-11"
                >
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {currencySymbol(c)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
          )}
          {reading === "unstable" ? (
            <p className="text-warning-foreground text-sm dark:text-warning">
              El peso todavía se movía: revisa que esté bien antes de agregarlo.
            </p>
          ) : null}
          {scaleError ? <p className="text-destructive text-sm">{scaleError}</p> : null}
          <p className="flex items-baseline justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2 text-sm">
            <span className="tabular text-muted-foreground">
              {valid ? formatQtyUnit(qtyMilli, item.unit) : "—"}
            </span>
            <span className="tabular font-semibold text-base">
              {total === null ? "—" : formatMoney(total, doc)}
            </span>
          </p>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="qty-form" disabled={!valid}>
            {initialQtyMilli !== undefined ? "Cambiar" : "Agregar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
