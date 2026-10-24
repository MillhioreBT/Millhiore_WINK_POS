import type { Bootstrap } from "@millhiore/contracts"
import { useQuery } from "@tanstack/react-query"
import { useSyncExternalStore } from "react"
import { bootstrapQuery } from "./queries"

type Terminal = Bootstrap["terminals"][number]

// La caja de cada equipo se recuerda en el navegador: el celular del mostrador 2 sigue siendo la
// caja 2 al volver a abrir la app. Si el navegador no guarda nada, se usa la primera.
const KEY = "millhiore.terminalId"
const listeners = new Set<() => void>()
/** Lo elegido, por si el navegador no deja guardar. */
let memory: string | null = null

function read(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

/** Elige en qué caja trabaja este equipo. */
export function chooseTerminal(id: string): void {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    // Sin almacenamiento (ventana privada): vale mientras la página siga abierta.
  }
  memory = id
  for (const l of listeners) l()
}

/** La caja de este equipo: la elegida si sigue activa; si no, la primera. */
export function deviceTerminal(boot: Pick<Bootstrap, "terminals">): Terminal | undefined {
  const id = read() ?? memory
  return boot.terminals.find((t) => t.id === id) ?? boot.terminals[0]
}

/** La caja de este equipo, y se actualiza al elegir otra. */
export function useTerminal(): Terminal | undefined {
  const boot = useQuery(bootstrapQuery)
  useSyncExternalStore(subscribe, () => read() ?? memory)
  return boot.data ? deviceTerminal(boot.data) : undefined
}
