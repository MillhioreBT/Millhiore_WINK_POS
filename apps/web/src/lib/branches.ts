import type { Bootstrap } from "@millhiore/contracts"
import { useQuery } from "@tanstack/react-query"
import { bootstrapQuery, meQuery } from "./queries"

/**
 * Las sucursales donde trabaja quien entró; null, en todas (o el negocio no usa sucursales).
 */
export function useMyBranchIds(): ReadonlySet<string> | null {
  const { data: me } = useQuery(meQuery)
  return me?.branchIds ? new Set(me.branchIds) : null
}

/**
 * Las sucursales entre las que se puede elegir (para un informe o el historial): las activas
 * donde trabaja quien entró, si son más de una. Null si el negocio no usa sucursales.
 */
export function useBranchChoices(): Bootstrap["branches"] | null {
  const { data } = useQuery(bootstrapQuery)
  const mine = useMyBranchIds()
  if (!data?.features.branches) return null
  const list = mine ? data.branches.filter((b) => mine.has(b.id)) : data.branches
  return list.length < 2 ? null : list
}

/** El nombre de cada sucursal, con las sucursales encendidas y más de una (si no, vacío). */
export function useBranchNames(): Map<string, string> {
  const { data } = useQuery(bootstrapQuery)
  if (!data?.features.branches || data.branches.length < 2) return new Map()
  return new Map(data.branches.map((b) => [b.id, b.name]))
}
