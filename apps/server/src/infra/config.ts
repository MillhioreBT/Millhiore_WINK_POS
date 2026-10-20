import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

export interface Config {
  port: number
  /** Carpeta de datos: base SQLite, respaldos y secreto de sesión. */
  dataDir: string
  baseURL: string
  trustedOrigins: string[]
  authSecret: string
  /** Cuántos respaldos conservar de cada tipo. */
  backupsKeep: number
  /** Hay un proxy de confianza delante; se usa su cabecera x-forwarded-for para identificar al cliente. */
  trustProxy: boolean
  /** Aplicación web compilada que sirve el servidor; null si no está compilada. */
  webRoot: string | null
}

/** WEB_DIR o, si falta, la compilación de `apps/web` dentro del repositorio (si existe). */
export function resolveWebRoot(env: Record<string, string | undefined>): string | null {
  const dir = env.WEB_DIR ?? resolve(import.meta.dir, "..", "..", "..", "web", "dist")
  return existsSync(join(dir, "index.html")) ? dir : null
}

/**
 * Orígenes desde los que se admiten sesiones: la propia máquina y las redes locales privadas,
 * para que tablets y celulares entren por la IP de la caja. Nunca internet abierta.
 */
export function defaultTrustedOrigins(port: number): string[] {
  return [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://192.168.*.*:${port}`,
    `http://10.*.*.*:${port}`,
    `http://172.*.*.*:${port}`,
  ]
}

/** AUTH_SECRET del entorno o, si falta, uno generado una vez y guardado junto a los datos. */
export function resolveAuthSecret(
  dataDir: string,
  env: Record<string, string | undefined>,
): string {
  if (env.AUTH_SECRET && env.AUTH_SECRET.length >= 32) return env.AUTH_SECRET
  const file = join(dataDir, "auth.secret")
  if (existsSync(file)) return readFileSync(file, "utf8").trim()
  mkdirSync(dataDir, { recursive: true })
  const secret = randomBytes(32).toString("base64url")
  writeFileSync(file, secret, { mode: 0o600 })
  return secret
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const port = Number(env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT inválido: ${env.PORT}`)
  }
  const dataDir = env.DATA_DIR ?? "./data"
  const extra = (env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
  return {
    port,
    dataDir,
    baseURL: env.BASE_URL ?? `http://localhost:${port}`,
    trustedOrigins: [...defaultTrustedOrigins(port), ...extra],
    authSecret: resolveAuthSecret(dataDir, env),
    backupsKeep: Number(env.BACKUPS_KEEP ?? 14),
    trustProxy: env.TRUST_PROXY === "true",
    webRoot: resolveWebRoot(env),
  }
}
