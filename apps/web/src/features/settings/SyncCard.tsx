import type { SyncStatus } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { timeAgo } from "../../lib/format"
import { queryClient, syncStatusQuery } from "../../lib/queries"
import { useCentral } from "../../lib/session"

/**
 * En una sucursal con servidor propio: con qué central se sincroniza, cuándo fue la última vez y
 * qué falta subir. Se sincroniza sola cada 30 segundos.
 */
export function SyncCard() {
  const isSatellite = useCentral() !== null
  const status = useQuery({ ...syncStatusQuery, refetchInterval: 15_000, enabled: isSatellite })
  const [busy, setBusy] = useState<"run" | "resend" | null>(null)
  const central = status.data?.central

  const run = async (resend: boolean) => {
    setBusy(resend ? "resend" : "run")
    try {
      const s = await api<SyncStatus>(`/api/sync/run${resend ? "?resend=1" : ""}`, {
        method: "POST",
      })
      queryClient.setQueryData(syncStatusQuery.queryKey, s)
      // Lo que bajó (catálogo, clientes, ajustes) se ve enseguida.
      await queryClient.invalidateQueries()
      if (s.central?.lastError) toast.error(s.central.lastError)
      else
        toast.success(resend ? "Se volvió a enviar todo al central" : "Sincronizada con el central")
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  if (!central) return null
  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-56 flex-1 gap-1.5">
          <CardTitle className="flex flex-wrap items-center gap-2">
            Sucursal {central.branchName}
            {central.lastError ? (
              <Badge variant="destructive">Sin conexión con el central</Badge>
            ) : (
              <Badge variant="secondary">Sincronizada</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Esta PC es el servidor de la sucursal: lo que se vende, compra y ajusta aquí sube solo
            al central, y del central bajan el catálogo, los clientes, los usuarios y los ajustes
            (allá se cambian). Si se corta la conexión, aquí se sigue vendiendo.
          </CardDescription>
        </div>
        <Button size="sm" disabled={busy !== null} onClick={() => void run(false)}>
          <RefreshCwIcon className={busy === "run" ? "animate-spin" : ""} /> Sincronizar ahora
        </Button>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-3 text-sm">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Central</dt>
          <dd className="break-all font-mono">{central.url}</dd>
          <dt className="text-muted-foreground">Última vez</dt>
          <dd>{central.lastSyncAt ? timeAgo(central.lastSyncAt) : "todavía no"}</dd>
          <dt className="text-muted-foreground">Por subir</dt>
          <dd data-testid="sync-pending">
            {central.pendingDocuments === 0
              ? "nada"
              : `${central.pendingDocuments} ${central.pendingDocuments === 1 ? "documento" : "documentos"}`}
          </dd>
        </dl>
        {central.lastError ? (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span className="min-w-0">
              {central.lastError}
              {central.lastErrorAt ? (
                <span className="block text-muted-foreground text-xs">
                  {timeAgo(central.lastErrorAt)} · se reintenta solo
                </span>
              ) : null}
            </span>
          </p>
        ) : null}
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void run(true)}
          >
            Volver a enviar todo
          </Button>
          <p className="mt-1 text-muted-foreground text-xs">
            Solo si el central restauró un respaldo anterior: sube de nuevo todo lo de esta sucursal
            (lo que ya tiene no se repite).
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
