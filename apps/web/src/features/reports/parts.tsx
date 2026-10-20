import { Button } from "@millhiore/ui"
import { FileSpreadsheetIcon, PrinterIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { errorMessage } from "../../lib/api"

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

/** Una línea de un estado: concepto a la izquierda y monto a la derecha. */
export function Line({
  label,
  value,
  hint,
  strong,
  muted,
  indent,
  negative,
}: {
  label: string
  value: string
  hint?: string | undefined
  strong?: boolean
  muted?: boolean
  indent?: boolean
  negative?: boolean
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
      <span className={`tabular shrink-0 ${negative ? "text-destructive" : ""}`}>{value}</span>
    </div>
  )
}
