import type { DaySummary } from "@millhiore/contracts"
import { useQuery } from "@tanstack/react-query"
import { ShareTextDialog } from "../../components/ShareTextDialog"
import { bootstrapQuery, payablesQuery, receivablesQuery } from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { closingText } from "./closingText"

/**
 * El cierre del día como texto: se copia o se manda directo por WhatsApp. El de una sucursal no
 * lleva lo que deben los clientes ni lo que se debe (es de todo el negocio).
 */
export function ClosingDialog({
  summary,
  branchName,
  onClose,
}: {
  summary: DaySummary
  branchName?: string | undefined
  onClose: () => void
}) {
  const me = useMe()
  const boot = useQuery(bootstrapQuery)
  const sees = !branchName && can(me, "payment.receive", "finance.view")
  const owed = useQuery({ ...receivablesQuery, enabled: sees })
  const seesPayables = !branchName && can(me, "payable.manage", "finance.view")
  const owing = useQuery({ ...payablesQuery, enabled: seesPayables })
  const name = boot.data?.business.name ?? "Mi negocio"
  const text = closingText(
    summary,
    { name: branchName ? `${name} · ${branchName}` : name },
    sees ? (owed.data ?? null) : null,
    seesPayables ? (owing.data ?? null) : null,
  )

  return (
    <ShareTextDialog
      title="Cierre del día"
      description="Un resumen en texto para mandarlo por WhatsApp o guardarlo. Lo puedes editar antes de enviarlo."
      text={text}
      copied="Cierre copiado"
      onClose={onClose}
    />
  )
}
