import type { Bootstrap, CatalogItem, LocationKind } from "@millhiore/contracts"
import { useQuery } from "@tanstack/react-query"
import { useMyBranchIds } from "./branches"
import { bootstrapQuery } from "./queries"

export const LOCATION_KIND_LABEL: Record<LocationKind, string> = {
  store: "Tienda",
  warehouse: "Depósito",
  kitchen: "Cocina",
}

/**
 * Las ubicaciones activas, solo si el comercio usa varias (la función encendida y más de una):
 * con una sola no hace falta preguntar dónde. Las de las sucursales donde se trabaja, salvo con
 * `anyBranch` (adónde puede llegar un traslado).
 */
export function useLocations(opts: { anyBranch?: boolean } = {}): Bootstrap["locations"] | null {
  const { data } = useQuery(bootstrapQuery)
  const mine = useMyBranchIds()
  if (!data?.features.locations) return null
  const list =
    opts.anyBranch || !mine ? data.locations : data.locations.filter((l) => mine.has(l.branchId))
  return list.length < 2 ? null : list
}

/** Lo que hay de un producto en una ubicación. */
export function stockAt(item: Pick<CatalogItem, "stockByLocation">, locationId: string): number {
  return item.stockByLocation[locationId] ?? 0
}
