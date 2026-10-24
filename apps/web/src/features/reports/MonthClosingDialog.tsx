import { useQuery } from "@tanstack/react-query"
import { ShareTextDialog } from "../../components/ShareTextDialog"
import {
  bootstrapQuery,
  payablesQuery,
  receivablesQuery,
  resultsReportQuery,
  salesReportQuery,
} from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { monthClosingText } from "./monthClosingText"

/** El cierre del mes como texto: se copia o se manda directo por WhatsApp. */
export function MonthClosingDialog({
  bounds,
  previous,
  label,
  onClose,
}: {
  bounds: { from: number; to: number }
  previous: { from: number; to: number }
  label: string
  onClose: () => void
}) {
  const me = useMe()
  const boot = useQuery(bootstrapQuery)
  const results = useQuery(resultsReportQuery(bounds))
  const before = useQuery(resultsReportQuery(previous))
  const sales = useQuery(salesReportQuery(bounds))
  const sees = can(me, "payment.receive", "finance.view")
  const owed = useQuery({ ...receivablesQuery, enabled: sees })
  const seesPayables = can(me, "payable.manage", "finance.view")
  const owing = useQuery({ ...payablesQuery, enabled: seesPayables })
  const text =
    results.data && sales.data
      ? monthClosingText({
          business: boot.data?.business.name ?? "Mi negocio",
          label,
          results: results.data,
          previous: before.data ?? null,
          sales: sales.data,
          owed: sees ? (owed.data ?? null) : null,
          owing: seesPayables ? (owing.data ?? null) : null,
        })
      : "Cargando…"

  return (
    <ShareTextDialog
      title="Cierre del mes"
      description="Ventas y resultados del mes comparados con el anterior, para mandarlos por WhatsApp o guardarlos. Lo puedes editar antes de enviarlo."
      text={text}
      copied="Cierre copiado"
      onClose={onClose}
    />
  )
}
