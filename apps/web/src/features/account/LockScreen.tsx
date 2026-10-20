import { Button, cn } from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { DeleteIcon, LockIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { ApiError, api } from "../../lib/api"
import { useLock } from "../../lib/lock"
import { bootstrapQuery } from "../../lib/queries"
import { signOut, useMe } from "../../lib/session"

const MAX = 6
const MIN = 4

/** Pantalla bloqueada: pide el PIN del cajero para volver a la caja. */
export function LockScreen() {
  const me = useMe()
  const navigate = useNavigate()
  const { data: boot } = useQuery(bootstrapQuery)
  const unlock = useLock((s) => s.unlock)
  const [pin, setPin] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = useCallback(
    async (value: string) => {
      if (value.length < MIN || busy) return
      setBusy(true)
      setError(null)
      try {
        await api("/api/me/pin/verify", { body: { pin: value } })
        unlock()
      } catch (e) {
        setPin("")
        // Sin PIN (se quitó desde otro equipo) no hay nada que pedir.
        if (e instanceof ApiError && e.code === "NO_PIN") unlock()
        else setError(e instanceof ApiError ? e.message : "No se pudo comprobar el PIN")
      } finally {
        setBusy(false)
      }
    },
    [busy, unlock],
  )

  // Funciona con el teclado (PC) y con el teclado de pantalla de abajo (táctil).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) {
        e.preventDefault()
        setError(null)
        setPin((p) => (p.length < MAX ? p + e.key : p))
      } else if (e.key === "Backspace") {
        setPin((p) => p.slice(0, -1))
      } else if (e.key === "Enter") {
        e.preventDefault()
        void submit(pin)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [pin, submit])

  const press = (digit: string) => {
    setError(null)
    setPin((p) => (p.length < MAX ? p + digit : p))
  }

  const out = async () => {
    useLock.getState().unlock()
    await signOut()
    await navigate({ to: "/entrar" })
  }

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center overflow-y-auto bg-background p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Pantalla bloqueada"
    >
      <div className="grid w-full max-w-xs justify-items-center gap-5 py-6">
        <img src="/favicon.svg" alt="" className="size-12" />
        <div className="grid justify-items-center gap-1 text-center">
          <p className="font-semibold text-lg">{boot?.business.name ?? "Caja"}</p>
          <p className="flex items-center gap-1.5 text-muted-foreground text-sm">
            <LockIcon className="size-4" /> Pantalla bloqueada · {me.name}
          </p>
        </div>

        <div className="flex h-6 items-center gap-3" aria-live="polite">
          {Array.from({ length: MAX }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: posiciones fijas
              key={i}
              className={cn(
                "size-3.5 rounded-full border-2 border-primary transition-colors",
                i < pin.length ? "bg-primary" : "bg-transparent",
                i >= MIN && i >= pin.length && "opacity-30",
              )}
            />
          ))}
          <span className="sr-only">{pin.length} dígitos escritos</span>
        </div>
        <p className="h-5 text-center text-destructive text-sm" role="alert">
          {error}
        </p>

        <div className="grid w-full grid-cols-3 gap-3">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
            <Button
              key={d}
              variant="outline"
              className="h-16 text-2xl"
              disabled={busy}
              onClick={() => press(d)}
              aria-label={d}
            >
              {d}
            </Button>
          ))}
          <Button
            variant="ghost"
            className="h-16"
            disabled={busy || pin.length === 0}
            onClick={() => setPin((p) => p.slice(0, -1))}
            aria-label="Borrar"
          >
            <DeleteIcon className="size-6" />
          </Button>
          <Button
            variant="outline"
            className="h-16 text-2xl"
            disabled={busy}
            onClick={() => press("0")}
            aria-label="0"
          >
            0
          </Button>
          <Button
            variant="success"
            className="h-16 text-lg"
            disabled={busy || pin.length < MIN}
            onClick={() => void submit(pin)}
            aria-label="Desbloquear"
          >
            OK
          </Button>
        </div>

        <Button variant="link" className="text-muted-foreground" onClick={out}>
          ¿Olvidaste el PIN? Salir e ingresar con tu contraseña
        </Button>
      </div>
    </div>
  )
}
