import { create } from "zustand"

const KEY = "millhiore.locked"

function read(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function write(userId: string | null) {
  try {
    if (userId) localStorage.setItem(KEY, userId)
    else localStorage.removeItem(KEY)
  } catch {
    // sin almacenamiento: el bloqueo dura hasta recargar
  }
}

interface LockState {
  /** Usuario cuya pantalla está bloqueada en este navegador; null = nada bloqueado. */
  lockedFor: string | null
  lock: (userId: string) => void
  unlock: () => void
}

/**
 * Bloqueo de pantalla: oculta la caja hasta teclear el PIN. Se recuerda en este navegador para
 * que recargar la página no lo salte. No es una barrera de seguridad del servidor (la sesión
 * sigue abierta): evita que otra persona use la caja o vea las ventas mientras el cajero no está.
 */
export const useLock = create<LockState>((set) => ({
  lockedFor: read(),
  lock: (userId) => {
    write(userId)
    set({ lockedFor: userId })
  },
  unlock: () => {
    write(null)
    set({ lockedFor: null })
  },
}))
