import { useQuery } from "@tanstack/react-query"
import { CategoryListDialog } from "../../components/CategoryListDialog"
import { categoriesQuery, queryClient } from "../../lib/queries"

const refresh = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ["categories"] }),
    queryClient.invalidateQueries({ queryKey: ["products"] }),
  ])

/** Crea, renombra, ordena y desactiva las categorías de productos. */
export function CategoriesDialog({
  onClose,
  canManage,
}: {
  onClose: () => void
  canManage: boolean
}) {
  const categories = useQuery(categoriesQuery({ all: true }))
  return (
    <CategoryListDialog
      title="Categorías"
      description="Agrupan los productos para encontrarlos rápido en la caja. Desactivar una no borra sus productos."
      placeholder="Nueva categoría (bebidas, víveres…)"
      basePath="/api/categories"
      items={categories.data ?? []}
      loading={categories.isLoading}
      countText={(c) => `${c.productCount} producto${c.productCount === 1 ? "" : "s"}`}
      refresh={refresh}
      onClose={onClose}
      canManage={canManage}
    />
  )
}
