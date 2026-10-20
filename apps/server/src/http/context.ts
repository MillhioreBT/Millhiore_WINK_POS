import type { OpenAPIHono } from "@hono/zod-openapi"
import type { RateSource } from "@millhiore/bcv"
import type { Db } from "@millhiore/db"
import type { Auth } from "../infra/auth"
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
}

export type App = OpenAPIHono<AppEnv>
