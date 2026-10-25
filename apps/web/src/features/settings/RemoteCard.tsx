import type { ServeResult } from "@millhiore/contracts"
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
import { ExternalLinkIcon, RefreshCwIcon, ShieldAlertIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { QrCode } from "../../components/QrCode"
import { api, errorMessage } from "../../lib/api"
import { remoteQuery } from "../../lib/queries"

/**
 * Entrar a la caja desde fuera del local con Tailscale: una red privada entre la PC y los equipos
 * del dueño, sin abrir puertos en el router. Guía según lo que haya en la PC.
 */
export function RemoteCard() {
  const remote = useQuery(remoteQuery)
  const [busy, setBusy] = useState(false)
  const [approve, setApprove] = useState<string | null>(null)
  const ts = remote.data?.tailscale

  const serve = async () => {
    setBusy(true)
    try {
      const r = await api<ServeResult>("/api/remote/tailscale/serve", { method: "POST" })
      setApprove(r.approveUrl)
      if (r.ok) {
        toast.success(r.message)
        await remote.refetch()
      } else toast.error(r.message)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-56 flex-1 gap-1.5">
          <CardTitle className="flex flex-wrap items-center gap-2">
            Acceso remoto
            {ts?.state === "running" ? (
              <Badge variant="secondary">Tailscale conectado</Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            Para ver la caja desde la casa o el celular, fuera del local, con Tailscale: una red
            privada entre esta PC y tus equipos. Nunca abras puertos en el router.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={remote.isFetching}
          onClick={() => void remote.refetch()}
        >
          <RefreshCwIcon /> Revisar de nuevo
        </Button>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4 text-sm">
        {!ts ? (
          <p className="text-muted-foreground">Revisando…</p>
        ) : ts.state === "missing" ? (
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>
              Descarga Tailscale para esta PC desde{" "}
              <a
                className="underline"
                href="https://tailscale.com/download"
                target="_blank"
                rel="noreferrer"
              >
                tailscale.com/download
              </a>{" "}
              e instálalo.
            </li>
            <li>Entra con tu cuenta (Google, Microsoft o Apple).</li>
            <li>Instala Tailscale en tu celular y entra con la misma cuenta.</li>
            <li>Vuelve aquí y toca «Revisar de nuevo».</li>
          </ol>
        ) : ts.state === "loggedOut" ? (
          <p>Tailscale está instalado: ábrelo en esta PC y entra con tu cuenta.</p>
        ) : ts.state === "stopped" ? (
          <p>Tailscale está apagado en esta PC: ábrelo y conéctalo.</p>
        ) : (
          <>
            <p>
              Esta PC está en la red de Tailscale de{" "}
              <span className="font-medium">{ts.tailnet ?? "tu cuenta"}</span> como{" "}
              <span className="font-medium">{ts.name}</span>. Desde cualquier equipo tuyo con
              Tailscale encendido:
            </p>
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              {ts.httpUrl ? (
                <section className="flex flex-wrap items-start gap-4">
                  <QrCode value={ts.httpUrl} label={`Código QR de ${ts.httpUrl}`} size={140} />
                  <div className="grid min-w-48 flex-1 gap-1">
                    <p className="font-medium">Abrir la app</p>
                    <code className="break-all font-mono">{ts.httpUrl}</code>
                  </div>
                </section>
              ) : null}
              <section className="flex flex-wrap items-start gap-4">
                {ts.httpsUrl ? (
                  <>
                    <QrCode value={ts.httpsUrl} label={`Código QR de ${ts.httpsUrl}`} size={140} />
                    <div className="grid min-w-48 flex-1 gap-1">
                      <p className="font-medium">Con HTTPS de Tailscale</p>
                      <code className="break-all font-mono">{ts.httpsUrl}</code>
                      <p className="text-muted-foreground text-xs">
                        Certificado válido, sin instalar nada: la cámara en vivo y la app instalable
                        funcionan.
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="grid min-w-48 flex-1 gap-2">
                    <p className="font-medium">Con HTTPS de Tailscale</p>
                    <p className="text-muted-foreground">
                      Un certificado válido en una dirección .ts.net, solo para tus equipos.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" disabled={busy} onClick={() => void serve()}>
                        Activar HTTPS de Tailscale
                      </Button>
                      {approve ? (
                        <Button asChild size="sm" variant="outline">
                          <a href={approve} target="_blank" rel="noreferrer">
                            <ExternalLinkIcon /> Habilitarlo en la cuenta
                          </a>
                        </Button>
                      ) : null}
                    </div>
                    <p className="text-muted-foreground text-xs">
                      O en esta PC: <code>tailscale serve --bg {remote.data?.port}</code>
                    </p>
                  </div>
                )}
              </section>
            </div>
          </>
        )}
        <details className="rounded-lg border px-3 py-2">
          <summary className="cursor-pointer font-medium">
            Otra opción: Cloudflare Tunnel (para quien no usa Tailscale)
          </summary>
          <div className="mt-2 grid gap-2 text-muted-foreground">
            <p className="flex items-start gap-2 text-warning-foreground dark:text-warning">
              <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
              Pone la app en internet: protégela con Cloudflare Access (que pida tu correo antes de
              llegar a la app).
            </p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Crea un túnel en el panel de Cloudflare (Zero Trust → Redes → Túneles).</li>
              <li>
                Apúntalo a <code>http://localhost:{remote.data?.port ?? 3000}</code> e instala{" "}
                <code>cloudflared</code> en esta PC con el comando que te da.
              </li>
              <li>
                Agrega tu dirección a <code>TRUSTED_ORIGINS</code> y arranca el servidor con{" "}
                <code>TRUST_PROXY=true</code>.
              </li>
            </ol>
          </div>
        </details>
      </CardContent>
    </Card>
  )
}
