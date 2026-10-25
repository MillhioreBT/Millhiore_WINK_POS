import type { OpenAPIHono } from "@hono/zod-openapi"
import type { RateSource } from "@millhiore/bcv"
import type { Db } from "@millhiore/db"
import type { Auth } from "../infra/auth"
import type { PluginManager } from "../modules/plugins/manager"
import type { Runner } from "../modules/remote/tailscale"
import type { SyncClient } from "../modules/sync/client"
import type { AppEnv } from "./actor"

export interface AppDeps {
  db: Db
  auth: Auth
  /** Reloj inyectable para pruebas (milisegundos Unix). */
  now: () => number
  /** Fuentes de tasas y `fetch` inyectables para pruebas. */
  rates?: { sources?: RateSource[]; fetcher?: typeof fetch }
  /** Se ejecuta tras completar el asistente inicial (p. ej. para traer la primera tasa de inmediato). */
  afterSetup?: () => void
  /** Detrás de un proxy de confianza (Tailscale, Cloudflare Tunnel): usar su `x-forwarded-for`. */
  trustProxy?: boolean
  /** Carpeta con la aplicación web compilada; si falta, el servidor solo expone la API. */
  webRoot?: string
  /** Tras cerrar un turno (p. ej. para respaldar la base: PLAN §10). */
  onShiftClosed?: (shiftId: string) => void
  /** Carpeta de datos (los respaldos van en `backups/`) y cuántos conservar de cada tipo. */
  backups?: { dataDir: string; keep: number }
  /** `fetch` inyectable para hablar con Telegram en las pruebas. */
  telegram?: { fetcher?: typeof fetch }
  /**
   * Cómo lo alcanzan los otros equipos de la red local: puertos, nombres y direcciones, y la
   * autoridad de HTTPS (null si está apagado o no pudo arrancar).
   */
  network?: {
    httpPort: number
    httpsPort: number | null
    /** El puerto que solo sirve el catálogo en línea; null si está apagado. */
    catalogPort?: number | null
    hosts: string[]
    caCert: string | null
    caFingerprint: string | null
  }
  /**
   * Acceso remoto: cómo correr la herramienta de Tailscale (null si no está instalada) y los
   * orígenes que se van sumando a los de confianza (la dirección https://…ts.net).
   */
  remote?: { run: Runner | null; origins: Set<string> }
  /** Los plugins cargados (cada uno aislado); sin él, no corre ninguno. */
  plugins?: PluginManager
  /** En una sucursal: la sincronización con el central (con su `fetch`, inyectable en las pruebas). */
  sync?: SyncClient
}

export type App = OpenAPIHono<AppEnv>
