import { NativeSelect } from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { CategoryListDialog } from "../../components/CategoryListDialog"
import { queryClient, stockReasonsQuery } from "../../lib/queries"

const refresh = () =>
  Promise.all(
    ["stock-reasons", "stock-adjustments"].map((k) =>
      queryClient.invalidateQueries({ queryKey: [k] }),
    ),
  )

/** Crea, renombra, ordena y desactiva los motivos de ajuste (merma, vencido, uso interno…). */
export function StockReasonsDialog({
  onClose,
  canManage,
}: {
  onClose: () => void
  canManage: boolean
}) {
  const reasons = useQuery(stockReasonsQuery({ all: true }))
  const [direction, setDirection] = useState<"in" | "out">("out")
  return (
    <CategoryListDialog
      title="Motivos de ajuste"
      description="Por qué cambia la existencia sin una compra ni una venta. Una salida resta mercancía y una entrada la suma. Desactivar uno no borra los ajustes que ya tiene."
      placeholder="Nuevo motivo (regalo, muestra…)"
      basePath="/api/stock-reasons"
      items={reasons.data ?? []}
      loading={reasons.isLoading}
      countText={(r) => `${r.adjustmentCount} ajuste${r.adjustmentCount === 1 ? "" : "s"}`}
      itemTag={(r) => (r.direction === "in" ? "Entrada" : "Salida")}
      createBody={(name) => ({ name, direction })}
      addControl={
        <NativeSelect
          aria-label="Sentido del motivo"
          value={direction}
          onChange={(e) => setDirection(e.target.value as "in" | "out")}
          className="w-28 shrink-0"
        >
          <option value="out">Salida</option>
          <option value="in">Entrada</option>
        </NativeSelect>
      }
      refresh={refresh}
      onClose={onClose}
      canManage={canManage}
    />
  )
}
