import { createPrivateKey, X509Certificate } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { createLocalCa, issueServerCert } from "./x509"

/** HTTPS en la red local: el certificado del servidor y la autoridad que lo firma. */
export interface LocalTls {
  /** El certificado del servidor seguido del de la autoridad (la cadena completa). */
  cert: string
  key: string
  /** El de la autoridad, que cada celular o tablet instala una vez. */
  caCert: string
  /** Huella SHA-256 de la autoridad («AB:CD:…»), para comprobar en el equipo que es la nuestra. */
  caFingerprint: string
  /** Los nombres y direcciones que cubre el certificado del servidor. */
  hosts: string[]
}

/** Los nombres y direcciones del servidor: localhost, «pc.local» y sus IP de la red local. */
export function localHosts(lan: readonly string[], pcName: string = hostname()): string[] {
  const mdns = /^[a-z0-9-]+$/i.test(pcName) ? [`${pcName.toLowerCase()}.local`] : []
  return [...new Set(["localhost", ...mdns, "127.0.0.1", ...lan])]
}

/** Un mes antes de vencer, el certificado del servidor se renueva solo. */
const RENEW_BEFORE_MS = 30 * 86_400_000

/** El certificado sirve si lo firmó esta autoridad, no está por vencer y cubre los mismos hosts. */
function fits(certPem: string, ca: X509Certificate, hosts: readonly string[], now: number) {
  try {
    const c = new X509Certificate(certPem)
    if (!c.verify(ca.publicKey)) return false
    if (Date.parse(c.validTo) - now < RENEW_BEFORE_MS) return false
    const sans = new Set(
      (c.subjectAltName ?? "").split(", ").map((s) => s.replace(/^(DNS|IP Address):/, "")),
    )
    return sans.size === hosts.length && hosts.every((h) => sans.has(h))
  } catch {
    return false
  }
}

/**
 * La autoridad local (se crea la primera vez y se conserva: los equipos ya la instalaron) y el
 * certificado del servidor, que se vuelve a emitir si cambió la IP de la PC o está por vencer.
 * Todo vive en `dir` (dentro de la carpeta de datos); la clave de la autoridad, solo para el dueño
 * del proceso.
 */
export function ensureLocalTls(dir: string, hosts: readonly string[], now: number): LocalTls {
  mkdirSync(dir, { recursive: true })
  const path = (name: string) => join(dir, name)
  if (!existsSync(path("ca.crt")) || !existsSync(path("ca.key"))) {
    const ca = createLocalCa({ commonName: `Millhiore WINK POS · ${hostname()}`, now })
    writeFileSync(path("ca.key"), ca.key, { mode: 0o600 })
    writeFileSync(path("ca.crt"), ca.cert)
  }
  const caCert = readFileSync(path("ca.crt"), "utf8")
  const caKey = createPrivateKey(readFileSync(path("ca.key"), "utf8"))
  const ca = new X509Certificate(caCert)

  let server =
    existsSync(path("server.crt")) && existsSync(path("server.key"))
      ? {
          cert: readFileSync(path("server.crt"), "utf8"),
          key: readFileSync(path("server.key"), "utf8"),
        }
      : null
  if (!server || !fits(server.cert, ca, hosts, now)) {
    server = issueServerCert({
      ca: { cert: caCert, key: caKey, publicKey: ca.publicKey },
      hosts,
      now,
    })
    writeFileSync(path("server.key"), server.key, { mode: 0o600 })
    writeFileSync(path("server.crt"), server.cert)
  }
  return {
    cert: server.cert + caCert,
    key: server.key,
    caCert,
    caFingerprint: ca.fingerprint256,
    hosts: [...hosts],
  }
}
