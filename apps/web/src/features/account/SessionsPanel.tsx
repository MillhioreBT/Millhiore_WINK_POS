import type { SessionRow } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { LaptopIcon, SmartphoneIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatDateTime } from "../../lib/format"
import { queryClient, sessionsQuery } from "../../lib/queries"
import { describeAgent, isPhone } from "../../lib/userAgent"

async function refresh() {
  await queryClient.invalidateQueries({ queryKey: ["sessions"] })
  await queryClient.invalidateQueries({ queryKey: ["audit"] })
}

/** Lista de sesiones abiertas con la opción de cerrarlas. `all` trae las de todo el negocio. */
export function SessionsPanel({ all = false }: { all?: boolean }) {
  const sessions = useQuery(sessionsQuery(all))
  const [busy, setBusy] = useState<string | null>(null)
  const rows = sessions.data ?? []
  const others = rows.filter((s) => !s.current && !all).length

  const close = async (row: SessionRow) => {
    setBusy(row.id)
    try {
      await api(`/api/sessions/${row.id}`, { method: "DELETE" })
      await refresh()
      toast.success("Sesión cerrada")
    } catch (e) {
      toast.error(errorMessage(e))
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const closeOthers = async () => {
    setBusy("others")
    try {
      const done = await api<{ closed: number }>("/api/sessions/close-others", { body: {} })
      await refresh()
      toast.success(done.closed === 1 ? "Se cerró 1 sesión" : `Se cerraron ${done.closed} sesiones`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  if (sessions.isError) {
    return <p className="text-destructive text-sm">{errorMessage(sessions.error)}</p>
  }
  return (
    <div className="grid grid-cols-1 gap-3">
      <ul className="divide-y rounded-lg border">
        {rows.length === 0 ? (
          <li className="p-4 text-center text-muted-foreground text-sm">
            {sessions.isLoading ? "Cargando…" : "No hay sesiones abiertas."}
          </li>
        ) : null}
        {rows.map((s) => {
          const Icon = isPhone(s.userAgent) ? SmartphoneIcon : LaptopIcon
          return (
            <li key={s.id} className="flex items-start gap-3 p-3">
              <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {describeAgent(s.userAgent)}
                  {s.current ? <Badge variant="success">Esta sesión</Badge> : null}
                </p>
                <p className="text-muted-foreground text-xs">
                  {all ? `${s.userName} · ` : ""}
                  {s.ipAddress ? `${s.ipAddress} · ` : ""}
                  Última actividad {formatDateTime(s.lastSeenAt)}
                </p>
                <p className="text-muted-foreground text-xs">Entró {formatDateTime(s.createdAt)}</p>
              </div>
              {s.current ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => close(s)}
                >
                  {busy === s.id ? "Cerrando…" : "Cerrar"}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {!all && others > 0 ? (
        <Button variant="outline" disabled={busy !== null} onClick={closeOthers}>
          {busy === "others"
            ? "Cerrando…"
            : `Cerrar las otras ${others === 1 ? "sesión" : `${others} sesiones`}`}
        </Button>
      ) : null}
    </div>
  )
}

/** «Mis sesiones»: dónde está abierta mi cuenta, para cerrar la que dejé en otro equipo. */
export function SessionsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Mis sesiones</DialogTitle>
          <DialogDescription>
            Los equipos donde tu cuenta está abierta. Si dejaste una sesión en un equipo que no es
            tuyo, ciérrala desde aquí.
          </DialogDescription>
        </DialogHeader>
        <SessionsPanel />
        <DialogFooter>
          <Button onClick={onClose}>Cerrar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
