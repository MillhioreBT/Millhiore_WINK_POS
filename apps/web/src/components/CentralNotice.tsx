import { Building2Icon } from "lucide-react"
import { useCentral } from "../lib/session"

/**
 * En el servidor de una sucursal: lo que se ve aquí se cambia en el central y llega solo (aquí
 * no se puede editar).
 */
export function CentralNotice({ what }: { what: string }) {
  const central = useCentral()
  if (!central) return null
  return (
    <p className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
      <Building2Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        Esta PC es la sucursal <span className="font-medium">{central.branchName}</span>: {what} se
        cambia en el central (<span className="break-all font-mono text-xs">{central.url}</span>) y
        llega aquí solo.
      </span>
    </p>
  )
}
