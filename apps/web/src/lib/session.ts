import type { Bootstrap, Features, Me } from "@millhiore/contracts"
import { useQuery } from "@tanstack/react-query"
import { api } from "./api"
import { bootstrapQuery, meQuery, queryClient } from "./queries"

/** Usuario de la sesión. Dentro de las rutas protegidas siempre existe. */
export function useMe(): Me {
  const { data } = useQuery(meQuery)
  if (!data) throw new Error("Sin sesión")
  return data
}

const ALL_FEATURES: Features = {
  quotes: true,
  priceLists: true,
  charges: true,
  recurring: true,
  payables: true,
  locations: false,
  lots: false,
  variants: false,
  tables: false,
  modifiers: false,
  kitchen: false,
  recipes: false,
  tips: false,
  scale: false,
  branches: false,
  catalog: false,
}

/** Las funciones que usa el comercio; mientras carga, las de siempre (como antes de poder apagarlas). */
export function useFeatures(): Features {
  const { data } = useQuery(bootstrapQuery)
  return data?.features ?? ALL_FEATURES
}

/** Si esta PC es una sucursal con servidor propio: su central (null si no). */
export function useCentral(): Bootstrap["central"] {
  const { data } = useQuery(bootstrapQuery)
  return data?.central ?? null
}

export function can(me: Me, ...permissions: string[]): boolean {
  return permissions.some((p) => me.permissions.includes(p))
}

export async function signOut(): Promise<void> {
  await api("/api/auth/sign-out", { body: {} }).catch(() => undefined)
  queryClient.clear()
  queryClient.setQueryData(meQuery.queryKey, null)
}

export async function signIn(username: string, password: string): Promise<void> {
  await api("/api/auth/sign-in/username", { body: { username, password } })
  await queryClient.invalidateQueries({ queryKey: meQuery.queryKey })
}
