import { Input } from "@millhiore/ui"
import { formatMoney, parseAmount, toInputAmount } from "../../lib/format"

/** Billetes y monedas en circulación, en unidades menores, de mayor a menor. */
export const DENOMINATIONS: Record<string, number[]> = {
  USD: [10000, 5000, 2000, 1000, 500, 200, 100],
  VES: [50000, 20000, 10000, 5000, 2000, 1000, 500, 100, 50],
  EUR: [50000, 20000, 10000, 5000, 2000, 1000, 500],
}

export interface CashCount {
  /** Cantidad por denominación (clave = valor en unidades menores). */
  pieces: Record<string, number>
  /** Lo que no entra por denominación: monedas sueltas, billetes rotos… */
  other: string
}

export const emptyCount = (): CashCount => ({ pieces: {}, other: "" })

export function countTotal(count: CashCount): number | null {
  const other = count.other.trim() ? parseAmount(count.other) : 0
  if (other === null) return null
  return (
    Object.entries(count.pieces).reduce((acc, [value, qty]) => acc + Number(value) * qty, 0) + other
  )
}

/** Solo las denominaciones contadas (para guardar el detalle del arqueo). */
export function countedPieces(count: CashCount): Record<string, number> {
  return Object.fromEntries(Object.entries(count.pieces).filter(([, qty]) => qty > 0))
}

/** Conteo de una cuenta de efectivo por billete, con un campo libre para lo demás. */
export function CashCounter({
  currency,
  label,
  value,
  onChange,
}: {
  currency: string
  label: string
  value: CashCount
  onChange: (next: CashCount) => void
}) {
  const denominations = DENOMINATIONS[currency] ?? []
  const total = countTotal(value)
  const id = `count-${currency}-${label.replace(/\W+/g, "-")}`
  return (
    // min-w-0: un fieldset no se encoge por debajo de su contenido salvo que se lo pidan.
    <fieldset className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border p-3">
      <legend className="flex w-full items-baseline justify-between gap-4 px-1">
        <span className="font-medium">{label}</span>
      </legend>
      {denominations.length ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {denominations.map((d) => (
            <div key={d} className="flex min-w-0 items-center gap-1.5 text-sm sm:gap-2">
              <span className="tabular w-16 shrink-0 text-right text-muted-foreground sm:w-20">
                {formatMoney(d, currency).replace(/,00$/, "")} ×
              </span>
              <Input
                inputMode="numeric"
                className="tabular h-9"
                value={value.pieces[d] ? String(value.pieces[d]) : ""}
                placeholder="0"
                onChange={(e) => {
                  const qty = Number.parseInt(e.target.value.replace(/\D/g, "") || "0", 10)
                  onChange({ ...value, pieces: { ...value.pieces, [d]: qty } })
                }}
                aria-label={`Cantidad de ${formatMoney(d, currency)}`}
              />
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label htmlFor={id} className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {denominations.length ? "Otros / monedas" : "Monto"}
          </span>
          <Input
            id={id}
            inputMode="decimal"
            className="tabular h-9 w-28 sm:w-32"
            value={value.other}
            placeholder={toInputAmount(0)}
            onChange={(e) => onChange({ ...value, other: e.target.value })}
            aria-invalid={total === null ? true : undefined}
          />
        </label>
        <span className="tabular font-semibold text-lg">
          {total === null ? "Monto inválido" : formatMoney(total, currency)}
        </span>
      </div>
    </fieldset>
  )
}
