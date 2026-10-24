import type { Bootstrap, CatalogItem, LocationKind } from "@millhiore/contracts"
import { useQuery } from "@tanstack/react-query"
import { bootstrapQuery } from "./queries"

export const LOCATION_KIND_LABEL: Record<LocationKind, string> = {
  store: "Tienda",
  warehouse: "Depósito",
  kitchen: "Cocina",
}

/**
 * Las ubicaciones activas, solo si el comercio usa varias (la función encendida y más de una):
 * con una sola no hace falta preguntar dónde.
 */
export function useLocations(): Bootstrap["locations"] | null {
  const { data } = useQuery(bootstrapQuery)
  if (!data?.features.locations || data.locations.length < 2) return null
  return data.locations
}

/** Lo que hay de un producto en una ubicación. */
export function stockAt(item: Pick<CatalogItem, "stockByLocation">, locationId: string): number {
  return item.stockByLocation[locationId] ?? 0
}
