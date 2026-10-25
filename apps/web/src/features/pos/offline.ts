import { useEffect } from "react"
import { toast } from "sonner"
import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import { ApiError, api, errorMessage } from "../../lib/api"
import { queryClient } from "../../lib/queries"

/**
 * Una venta cobrada cuando este equipo no alcanzaba al servidor (se cayó el wifi): queda guardada
 * aquí, con su id, y se envía sola al volver la conexión. El servidor reconoce el id, así que
 * reintentar nunca la registra dos veces. Se envía con la sesión de quien la cobró (el servidor
 * anota a esa persona): si entra otra en el equipo, espera a que vuelva.
 */
export interface QueuedSale {
  id: string
  /** Lo que se manda a `POST /api/documents`, tal cual. */
  body: Record<string, unknown>
  queuedAt: number
  userId: string
  userName: string
  totalMinor: number
  currency: string
  /** Cuántos productos lleva, para reconocerla en la lista. */
  items: number
  /** «failed»: el servidor la rechazó (turno cerrado, sin existencia…); hay que revisarla. */
  status: "pending" | "failed"
  error: string | null
}

interface OfflineState {
  sales: QueuedSale[]
  enqueue: (sale: Omit<QueuedSale, "status" | "error">) => void
  settle: (id: string) => void
  fail: (id: string, error: string) => void
  retry: (id: string) => void
  discard: (id: string) => void
}

export const useOfflineSales = create<OfflineState>()(
  persist(
    (set) => ({
      sales: [],
      enqueue: (sale) =>
        set((s) => ({
          sales: s.sales.some((x) => x.id === sale.id)
            ? s.sales
            : [...s.sales, { ...sale, status: "pending", error: null }],
        })),
      settle: (id) => set((s) => ({ sales: s.sales.filter((x) => x.id !== id) })),
      fail: (id, error) =>
        set((s) => ({
          sales: s.sales.map((x) => (x.id === id ? { ...x, status: "failed", error } : x)),
        })),
      retry: (id) =>
        set((s) => ({
          sales: s.sales.map((x) => (x.id === id ? { ...x, status: "pending", error: null } : x)),
        })),
      discard: (id) => set((s) => ({ sales: s.sales.filter((x) => x.id !== id) })),
    }),
    { name: "millhiore.offline-sales", storage: createJSONStorage(() => localStorage) },
  ),
)

/**
 * Qué hacer con un error al enviar: sin conexión, con el servidor caído, sin sesión (o con una
 * contraseña por cambiar) o con demasiadas peticiones, se reintenta más tarde; cualquier otro
 * rechazo es de la venta en sí.
 */
export function onSendError(e: unknown): "retry" | "fail" {
  if (!(e instanceof ApiError)) return "retry"
  return e.status === 0 ||
    e.status >= 500 ||
    e.status === 401 ||
    e.status === 429 ||
    e.code === "PASSWORD_CHANGE_REQUIRED"
    ? "retry"
    : "fail"
}

let sending: Promise<{ sent: number; waiting: boolean }> | null = null

/**
 * Envía en orden las ventas pendientes de esta persona; se detiene si falla la conexión
 * (`waiting`: quedan para más tarde).
 */
export function sendQueued(userId: string): Promise<{ sent: number; waiting: boolean }> {
  sending ??= (async () => {
    try {
      let sent = 0
      let waiting = false
      const mine = useOfflineSales
        .getState()
        .sales.filter((s) => s.status === "pending" && s.userId === userId)
      for (const sale of mine) {
        try {
          const posted = await api<{ number: string }>("/api/documents", { body: sale.body })
          useOfflineSales.getState().settle(sale.id)
          toast.success(`Venta ${posted.number} registrada (se cobró sin conexión)`)
          sent++
        } catch (e) {
          if (onSendError(e) === "retry") {
            waiting = true
            break
          }
          useOfflineSales.getState().fail(sale.id, errorMessage(e))
          toast.error(`Una venta cobrada sin conexión no se pudo registrar: ${errorMessage(e)}`)
        }
      }
      if (sent) {
        await Promise.all(
          ["products", "documents", "receivables"].map((k) =>
            queryClient.invalidateQueries({ queryKey: [k] }),
          ),
        )
      }
      return { sent, waiting }
    } finally {
      sending = null
    }
  })()
  return sending
}

/** Mientras esta persona tenga ventas pendientes, las intenta cada 10 s y al volver la red. */
export function useOfflineSync(userId: string): void {
  const pending = useOfflineSales((s) =>
    s.sales.some((x) => x.status === "pending" && x.userId === userId),
  )
  useEffect(() => {
    if (!pending) return
    const send = () => void sendQueued(userId)
    send()
    const timer = window.setInterval(send, 10_000)
    window.addEventListener("online", send)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("online", send)
    }
  }, [pending, userId])
}
