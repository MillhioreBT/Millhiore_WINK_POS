import { Button } from "@millhiore/ui"
import { FileSpreadsheetIcon, PrinterIcon } from "lucide-react"
import { type ReactNode, useState } from "react"
import { toast } from "sonner"
import { errorMessage } from "../../lib/api"
import { formatPercent } from "../../lib/format"
import { changeBp } from "./compare"

/**
 * Imprime el informe en una hoja normal y en claro (uno oscuro gasta tinta y se lee peor). La hoja
 * de estilos de los recibos esconde todo menos el ticket y lo ajusta a 80 mm: aquí se anula solo
 * mientras dura la impresión del informe.
 */
function printLight() {
  const root = document.documentElement
  const dark = root.classList.contains("dark")
  const style = document.createElement("style")
  style.textContent =
    "@media print { @page { size: auto; margin: 12mm } body * { visibility: visible !important } }"
  document.head.append(style)
  if (dark) root.classList.remove("dark")
  window.addEventListener(
    "afterprint",
    () => {
      style.remove()
      if (dark) root.classList.add("dark")
    },
    { once: true },
  )
  window.print()
}

/** Excel e imprimir/PDF: el navegador convierte la impresión en PDF con «Guardar como PDF». */
export function ExportButtons({
  onExcel,
  disabled,
}: {
  onExcel: () => Promise<void>
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex gap-2 print:hidden">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true)
          try {
            await onExcel()
          } catch (e) {
            toast.error(errorMessage(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        <FileSpreadsheetIcon /> {busy ? "Preparando…" : "Excel"}
      </Button>
      <Button variant="outline" size="sm" disabled={disabled} onClick={printLight}>
        <PrinterIcon /> Imprimir / PDF
      </Button>
    </div>
  )
}

/** Encabezado que solo se ve al imprimir: negocio, informe y período. */
export function PrintHeader({
  business,
  title,
  period,
}: {
  business: string
  title: string
  period: string
}) {
  return (
    <div className="mb-3 hidden print:block">
      <p className="font-semibold text-lg">{business}</p>
      <p className="text-sm">
        {title} · {period}
      </p>
    </div>
  )
}

/** Con qué período se compara y cómo se muestra lo de entonces. */
export interface Comparison {
  bounds: { from: number; to: number }
  /** «el mes anterior», «los 7 días anteriores»… */
  label: string
  /** Las fechas del período anterior, para el Excel y la impresión. */
  period: string
}

/**
 * Cuánto cambió contra el período anterior: ▲ 12 % en verde si es bueno (más ventas, menos
 * gastos) y en rojo si no. Al pasar el puntero se ve lo de antes.
 */
export function Delta({
  current,
  previous,
  upIsGood = true,
  format,
}: {
  current: number | null
  previous: number | null | undefined
  upIsGood?: boolean
  format: (value: number) => string
}) {
  if (current === null || previous === null || previous === undefined) return null
  const title = `Antes: ${format(previous)}`
  const bp = changeBp(current, previous)
  // Antes no había nada con qué comparar: sin flecha.
  if (bp === null) return null
  if (bp === 0) {
    return (
      <span className="text-muted-foreground text-xs" title={title}>
        igual
      </span>
    )
  }
  // Sin decimales de más: «▲ 12 %», y uno solo por debajo de 10 % («▼ 3,5 %»).
  const shown = Math.abs(bp) >= 1000 ? Math.round(bp / 100) * 100 : Math.round(bp / 10) * 10
  const good = bp > 0 === upIsGood
  return (
    <span className={`tabular text-xs ${good ? "text-success" : "text-destructive"}`} title={title}>
      <span aria-hidden>{bp > 0 ? "▲" : "▼"}</span>
      <span className="sr-only">{bp > 0 ? "Subió" : "Bajó"}</span> {formatPercent(Math.abs(shown))}
    </span>
  )
}

/** Una línea de un estado: concepto a la izquierda y monto a la derecha. */
export function Line({
  label,
  value,
  hint,
  strong,
  muted,
  indent,
  negative,
  delta,
}: {
  label: string
  value: string
  hint?: string | undefined
  strong?: boolean
  muted?: boolean
  indent?: boolean
  negative?: boolean
  /** La variación contra el período anterior, debajo del monto. */
  delta?: ReactNode
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 py-1.5 text-sm ${strong ? "font-semibold" : ""} ${muted ? "text-muted-foreground" : ""} ${indent ? "pl-4" : ""}`}
    >
      <span className="min-w-0">
        {label}
        {hint ? (
          <span className="block font-normal text-muted-foreground text-xs">{hint}</span>
        ) : null}
      </span>
      <span className="grid shrink-0 justify-items-end">
        <span className={`tabular ${negative ? "text-destructive" : ""}`}>{value}</span>
        {delta}
      </span>
    </div>
  )
}
