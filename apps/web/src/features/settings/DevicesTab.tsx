import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { LockIcon } from "lucide-react"
import { QrCode } from "../../components/QrCode"
import { networkQuery } from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { RemoteCard } from "./RemoteCard"
import { SyncCard } from "./SyncCard"

/** Primero las direcciones IP: «caja.local» no lo resuelven todos los celulares. */
const byIpFirst = (urls: readonly string[]) =>
  [...urls].sort((a, b) => Number(/\.local[:/]/.test(a)) - Number(/\.local[:/]/.test(b)))

/** Pasos para instalar la autoridad local en cada sistema. */
const INSTALL: { os: string; steps: string[] }[] = [
  {
    os: "Android",
    steps: [
      "Abre el archivo descargado (millhiore-ca.crt). Si no se instala solo:",
      "Ajustes → Seguridad (o Seguridad y privacidad) → Más ajustes → Cifrado y credenciales → Instalar un certificado → Certificado de CA.",
      "Elige millhiore-ca.crt y confirma.",
    ],
  },
  {
    os: "iPhone o iPad",
    steps: [
      "Ábrelo en Safari: aparece «Perfil descargado».",
      "Ajustes → General → VPN y gestión de dispositivos → el perfil de Millhiore → Instalar.",
      "Ajustes → General → Información → Ajustes de confianza de certificados → activa Millhiore WINK POS.",
    ],
  },
  {
    os: "Otra PC con Windows",
    steps: [
      "Abre el archivo descargado → Instalar certificado → Equipo local.",
      "Elige «Colocar todos los certificados en el siguiente almacén» → Entidades de certificación raíz de confianza → Aceptar.",
    ],
  },
]

/**
 * Conectar celulares y tablets a la caja por la red local: un QR para abrir la app y, para la
 * cámara en vivo y la app instalable, cómo pasar a HTTPS con la autoridad propia del negocio.
 */
export function DevicesTab() {
  const me = useMe()
  const { data: info } = useQuery(networkQuery)
  const secureNow = typeof window !== "undefined" && window.location.protocol === "https:"
  const http = byIpFirst(info?.httpUrls ?? [])
  const https = byIpFirst(info?.httpsUrls ?? [])
  const ca = byIpFirst(info?.caUrls ?? [])

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {can(me, "settings.manage") ? <SyncCard /> : null}
      <Card>
        <CardHeader>
          <CardTitle>Abrir la app en otro equipo</CardTitle>
          <CardDescription>
            Con el celular o la tablet en el mismo wifi que esta PC, escanea el código con la
            cámara.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-start gap-4">
          {http[0] ? (
            <>
              <QrCode value={http[0]} label={`Código QR de ${http[0]}`} />
              <div className="grid min-w-48 flex-1 gap-1 text-sm">
                <span className="text-muted-foreground">O escribe en el navegador:</span>
                {http.map((u) => (
                  <code key={u} className="break-all font-mono">
                    {u}
                  </code>
                ))}
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              Esta PC no está conectada a una red local (wifi o cable).
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Con HTTPS
            {secureNow ? (
              <Badge variant="secondary">
                <LockIcon /> Este equipo ya entra con HTTPS
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            Hace falta para escanear con la cámara en vivo e instalar la app en el celular. Se
            instala una sola vez, en cada equipo, la autoridad certificadora propia de este negocio
            (solo vale para la red local).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-4 text-sm">
          {https[0] && ca[0] ? (
            <>
              <section className="flex flex-wrap items-start gap-4">
                <QrCode value={ca[0]} label="Código QR para descargar el certificado" size={140} />
                <div className="grid min-w-48 flex-1 gap-1">
                  <p className="font-medium">1. Descarga el certificado</p>
                  <p className="text-muted-foreground">
                    Escanéalo desde el equipo, o{" "}
                    <a className="underline" href="/api/network/ca.crt">
                      descárgalo aquí
                    </a>
                    .
                  </p>
                  <p className="text-muted-foreground text-xs">Huella SHA-256 para comprobarlo:</p>
                  <code className="break-all font-mono text-[11px] leading-snug">
                    {info?.caFingerprint}
                  </code>
                </div>
              </section>
              <section className="grid gap-1.5">
                <p className="font-medium">2. Instálalo</p>
                {INSTALL.map((s) => (
                  <details key={s.os} className="rounded-lg border px-3 py-2">
                    <summary className="cursor-pointer font-medium">{s.os}</summary>
                    <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-muted-foreground">
                      {s.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                  </details>
                ))}
              </section>
              <section className="flex flex-wrap items-start gap-4">
                <QrCode value={https[0]} label={`Código QR de ${https[0]}`} size={140} />
                <div className="grid min-w-48 flex-1 gap-1">
                  <p className="font-medium">3. Entra con HTTPS</p>
                  {https.map((u) => (
                    <code key={u} className="break-all font-mono">
                      {u}
                    </code>
                  ))}
                  <p className="text-muted-foreground text-xs">
                    Si cambia la IP de esta PC, el certificado se renueva solo al reiniciar el
                    servidor; no hace falta instalar nada de nuevo.
                  </p>
                </div>
              </section>
            </>
          ) : (
            <p className="text-muted-foreground">
              HTTPS está apagado en este servidor (HTTPS=off) o no pudo arrancar: revisa el registro
              del servidor.
            </p>
          )}
        </CardContent>
      </Card>
      {can(me, "settings.manage") ? <RemoteCard /> : null}
    </div>
  )
}
