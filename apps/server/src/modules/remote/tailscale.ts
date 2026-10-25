import { existsSync } from "node:fs"
import type { RemoteStatus, ServeResult } from "@millhiore/contracts"

// Acceso remoto con Tailscale: la PC de la caja y los equipos del dueño en una misma red privada,
// sin abrir puertos en el router. Se habla con la herramienta de línea de comandos de Tailscale,
// siempre con argumentos fijos.

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}
/** Corre `tailscale <args>`; inyectable para las pruebas. */
export type Runner = (args: string[], timeoutMs: number) => Promise<RunResult>

/** El ejecutable de Tailscale en esta PC, o null si no está instalado. */
export function findTailscale(): string | null {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Tailscale\\tailscale.exe",
          "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
        ]
      : [
          "/usr/bin/tailscale",
          "/usr/local/bin/tailscale",
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ]
  return candidates.find((c) => existsSync(c)) ?? Bun.which("tailscale")
}

/** Corre el ejecutable de verdad, y lo corta si se pasa del tiempo. */
export function processRunner(bin: string): Runner {
  return async (args, timeoutMs) => {
    const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeoutMs)
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    clearTimeout(timer)
    return { code, stdout, stderr, timedOut }
  }
}

const empty = (state: RemoteStatus["tailscale"]["state"]): RemoteStatus["tailscale"] => ({
  state,
  name: null,
  tailnet: null,
  httpUrl: null,
  httpsUrl: null,
})

interface StatusJson {
  BackendState?: string
  Self?: { HostName?: string; DNSName?: string; TailscaleIPs?: string[] }
  CurrentTailnet?: { Name?: string } | null
  MagicDNSSuffix?: string
}

interface ServeJson {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
}

/** Cómo está Tailscale en esta PC y, si funciona, las direcciones para entrar desde fuera. */
export async function tailscaleStatus(
  run: Runner | null,
  port: number,
): Promise<RemoteStatus["tailscale"]> {
  if (!run) return empty("missing")
  const st = await run(["status", "--json"], 5000)
  let json: StatusJson
  try {
    json = JSON.parse(st.stdout) as StatusJson
  } catch {
    return empty("stopped")
  }
  if (json.BackendState === "NeedsLogin" || json.BackendState === "NeedsMachineAuth") {
    return empty("loggedOut")
  }
  if (json.BackendState !== "Running") return empty("stopped")
  const dnsName = json.Self?.DNSName?.replace(/\.$/, "") || null
  const ip = json.Self?.TailscaleIPs?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? null

  // ¿Ya se sirve la app por HTTPS de Tailscale («tailscale serve»)?
  let served = false
  const serve = await run(["serve", "status", "--json"], 5000)
  try {
    const web = (JSON.parse(serve.stdout || "{}") as ServeJson).Web ?? {}
    served = Object.values(web).some((site) =>
      Object.values(site.Handlers ?? {}).some((h) =>
        new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}/?$`).test(h.Proxy ?? ""),
      ),
    )
  } catch {
    served = false
  }
  return {
    state: "running",
    name: json.Self?.HostName ?? null,
    tailnet: json.CurrentTailnet?.Name ?? json.MagicDNSSuffix ?? null,
    httpUrl: ip ? `http://${ip}:${port}` : null,
    httpsUrl: served && dnsName ? `https://${dnsName}` : null,
  }
}

/**
 * Sirve la app por HTTPS de Tailscale (`tailscale serve --bg <puerto>`): un certificado válido en
 * `pc.red.ts.net`, solo para los equipos de la cuenta. Si la cuenta todavía no lo permite,
 * Tailscale da una dirección para habilitarlo.
 */
export async function enableServe(run: Runner | null, port: number): Promise<ServeResult> {
  if (!run)
    return { ok: false, approveUrl: null, message: "Tailscale no está instalado en esta PC" }
  const r = await run(["serve", "--bg", String(port)], 20_000)
  const output = `${r.stdout}\n${r.stderr}`.trim()
  const approveUrl = /https:\/\/login\.tailscale\.com\/\S+/.exec(output)?.[0] ?? null
  if (r.code === 0 && !r.timedOut) {
    return { ok: true, approveUrl: null, message: "La app ya se sirve con HTTPS de Tailscale" }
  }
  return {
    ok: false,
    approveUrl,
    message: approveUrl
      ? "Falta habilitar HTTPS en tu cuenta de Tailscale: abre la dirección, acéptalo y vuelve a intentar"
      : `Tailscale no pudo: ${output.slice(0, 300) || "sin respuesta"}`,
  }
}

/** El puerto público de Funnel para el catálogo (443 queda para la app con `tailscale serve`). */
export const FUNNEL_PORT = 8443

interface FunnelJson extends ServeJson {
  AllowFunnel?: Record<string, boolean>
}

/**
 * La dirección pública del catálogo si Tailscale Funnel ya lo publica (`https://pc.red.ts.net:8443`),
 * o null. Solo cuenta lo que lleva al puerto del catálogo, nunca al de la app.
 */
export async function funnelUrl(run: Runner | null, catalogPort: number): Promise<string | null> {
  if (!run) return null
  const r = await run(["serve", "status", "--json"], 5000)
  try {
    const json = JSON.parse(r.stdout || "{}") as FunnelJson
    const target = new RegExp(`^https?://(127.0.0.1|localhost):${catalogPort}/?$`)
    for (const [hostPort, site] of Object.entries(json.Web ?? {})) {
      if (!json.AllowFunnel?.[hostPort]) continue
      if (!Object.values(site.Handlers ?? {}).some((h) => target.test(h.Proxy ?? ""))) continue
      return `https://${hostPort.replace(/:443$/, "")}`
    }
  } catch {
    // sin Tailscale funcionando no hay nada publicado
  }
  return null
}

/**
 * Publica en internet solo el puerto del catálogo con Tailscale Funnel
 * (`tailscale funnel --bg --https=8443 <puerto>`). Si la cuenta todavía no lo permite, Tailscale
 * da la dirección para habilitarlo.
 */
export async function enableFunnel(run: Runner | null, catalogPort: number): Promise<ServeResult> {
  if (!run)
    return { ok: false, approveUrl: null, message: "Tailscale no está instalado en esta PC" }
  const r = await run(["funnel", "--bg", `--https=${FUNNEL_PORT}`, String(catalogPort)], 20_000)
  const output = `${r.stdout}\n${r.stderr}`.trim()
  const approveUrl = /https:\/\/login\.tailscale\.com\/\S+/.exec(output)?.[0] ?? null
  if (r.code === 0 && !r.timedOut) {
    return { ok: true, approveUrl: null, message: "El catálogo ya está publicado en internet" }
  }
  return {
    ok: false,
    approveUrl,
    message: approveUrl
      ? "Falta permitir Funnel en tu cuenta de Tailscale: abre la dirección, acéptalo y vuelve a intentar"
      : `Tailscale no pudo: ${output.slice(0, 300) || "sin respuesta"}`,
  }
}

/** Deja de publicar el catálogo (`tailscale funnel --https=8443 off`). */
export async function disableFunnel(run: Runner | null): Promise<ServeResult> {
  if (!run)
    return { ok: false, approveUrl: null, message: "Tailscale no está instalado en esta PC" }
  const r = await run(["funnel", `--https=${FUNNEL_PORT}`, "off"], 20_000)
  const output = `${r.stdout}\n${r.stderr}`.trim()
  return r.code === 0 && !r.timedOut
    ? { ok: true, approveUrl: null, message: "El catálogo ya no está publicado en internet" }
    : {
        ok: false,
        approveUrl: null,
        message: `Tailscale no pudo: ${output.slice(0, 300) || "sin respuesta"}`,
      }
}
