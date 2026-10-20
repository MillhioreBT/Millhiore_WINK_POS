import { useQuery } from "@tanstack/react-query"
import { CategoryListDialog } from "../../components/CategoryListDialog"
import { expenseCategoriesQuery, queryClient } from "../../lib/queries"

const refresh = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ["expense-categories"] }),
    queryClient.invalidateQueries({ queryKey: ["expenses"] }),
  ])

/** Crea, renombra, ordena y desactiva las categorías de gasto (alquiler, servicios, sueldos…). */
export function ExpenseCategoriesDialog({
  onClose,
  canManage,
}: {
  onClose: () => void
  canManage: boolean
}) {
  const categories = useQuery(expenseCategoriesQuery({ all: true }))
  return (
    <CategoryListDialog
      title="Categorías de gasto"
      description="Agrupan los gastos para saber en qué se va el dinero. Desactivar una no borra los gastos que ya tiene."
      placeholder="Nueva categoría (comisiones, seguridad…)"
      basePath="/api/expense-categories"
      items={categories.data ?? []}
      loading={categories.isLoading}
      countText={(c) => `${c.expenseCount} gasto${c.expenseCount === 1 ? "" : "s"}`}
      refresh={refresh}
      onClose={onClose}
      canManage={canManage}
    />
  )
}
