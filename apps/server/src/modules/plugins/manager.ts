import { randomBytes } from "node:crypto"
import type { PluginLog } from "@millhiore/contracts"
import { type Db, plugin, pluginEvent } from "@millhiore/db"
import { and, asc, eq, lte } from "drizzle-orm"
import { type PluginArchive, readArchive } from "./archive"
import { DEFAULT_LIMITS, MAX_FETCH_TEXT, PluginSandbox, type SandboxLimits } from "./sandbox"
import { kvDelete, kvGet, kvKeys, kvSet, pluginRow, recordPluginError } from "./service"

/** Reintentos de un evento que el plugin no pudo procesar: al minuto, a los 5, 30 y 120. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000]
const MAX_LOGS = 200
/** La clave con que el código de un plugin llama a la API (nunca sale del servidor). */
export const PLUGIN_TOKEN_PREFIX = "mwp_"

interface Loaded {
  archive: PluginArchive
  sandbox: PluginSandbox | null
  token: string
  /** Cuándo toca cada tarea. */
  nextRun: number[]
}

export interface PluginManagerOptions {
  now: () => number
  fetcher?: typeof fetch
  limits?: SandboxLimits
}

/**
 * Los plugins encendidos, cargados cada uno en su QuickJS. Les reparte los eventos (con
 * reintentos), corre sus tareas, atiende sus rutas y guarda su registro (los últimos 200
 * mensajes, en memoria).
 */
export class PluginManager {
  private readonly loaded = new Map<string, Loaded>()
  private readonly tokens = new Map<string, string>()
  private readonly logBook = new Map<string, PluginLog[]>()
  private app: ((req: Request) => Response | Promise<Response>) | null = null
  private timers: ReturnType<typeof setInterval>[] = []
  private delivering = false

  constructor(
    private readonly db: Db,
    private readonly opts: PluginManagerOptions,
  ) {}

  /** Cómo llamar a la API de la app (se conecta después de crearla). */
  setApp(app: (req: Request) => Response | Promise<Response>): void {
    this.app = app
  }

  /** Carga los encendidos. Uno que falla al cargar queda con su error y no afecta a los demás. */
  async start(): Promise<void> {
    const rows = this.db
      .select({ id: plugin.id })
      .from(plugin)
      .where(eq(plugin.enabled, true))
      .all()
    for (const r of rows) await this.reload(r.id)
  }

  /** Cada 5 s los eventos que tocan y cada 30 s las tareas. */
  startTimers(): void {
    this.timers.push(setInterval(() => void this.deliver(), 5_000))
    this.timers.push(setInterval(() => void this.runTasks(), 30_000))
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    for (const id of [...this.loaded.keys()]) this.unload(id)
  }

  isRunning(id: string): boolean {
    return this.loaded.has(id)
  }

  /** El plugin al que pertenece una clave interna; null si no es de ninguno cargado. */
  pluginForToken(token: string): string | null {
    return this.tokens.get(token) ?? null
  }

  /** Un archivo de la pantalla del plugin (solo si está encendido). */
  file(id: string, path: string): Uint8Array | null {
    return this.loaded.get(id)?.archive.files.get(path) ?? null
  }

  logs(id: string): PluginLog[] {
    return [...(this.logBook.get(id) ?? [])].reverse()
  }

  /** Vuelve a cargarlo (tras instalar, actualizar o encender); si está apagado, lo descarga. */
  async reload(id: string): Promise<void> {
    this.unload(id)
    const row = this.db.select().from(plugin).where(eq(plugin.id, id)).get()
    if (!row?.enabled) return
    let archive: PluginArchive
    try {
      archive = readArchive(new Uint8Array(row.archive))
    } catch (e) {
      this.fail(id, `No se pudo leer el paquete: ${(e as Error).message}`)
      return
    }
    const token = `${PLUGIN_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`
    let sandbox: PluginSandbox | null = null
    if (archive.manifest.server) {
      const code = new TextDecoder().decode(archive.files.get(archive.manifest.server))
      try {
        sandbox = await PluginSandbox.create(
          code,
          this.host(id, token, archive),
          this.opts.limits ?? DEFAULT_LIMITS,
        )
      } catch (e) {
        this.fail(id, `No arrancó: ${(e as Error).message}`)
        return
      }
    }
    const now = this.opts.now()
    this.loaded.set(id, {
      archive,
      sandbox,
      token,
      nextRun: (sandbox?.shape.tasks ?? []).map((minutes) => now + minutes * 60_000),
    })
    this.tokens.set(token, id)
    this.log(id, "info", `Cargado (versión ${archive.manifest.version})`)
  }

  unload(id: string): void {
    const l = this.loaded.get(id)
    if (!l) return
    l.sandbox?.dispose()
    this.tokens.delete(l.token)
    this.loaded.delete(id)
  }

  /** Lo que responde una ruta propia del plugin; null si no la tiene (o no está corriendo). */
  async route(
    id: string,
    method: string,
    path: string,
    request: unknown,
  ): Promise<{ status: number; body: unknown } | null> {
    const sandbox = this.loaded.get(id)?.sandbox
    if (!sandbox) return null
    try {
      return await sandbox.route(method, path, request)
    } catch (e) {
      this.fail(id, `Ruta ${method} ${path}: ${(e as Error).message}`)
      return { status: 500, body: { error: (e as Error).message } }
    }
  }

  /** Los eventos pendientes que ya tocan (hasta 50 por vuelta). Devuelve cuántos entregó. */
  async deliver(): Promise<number> {
    if (this.delivering) return 0
    this.delivering = true
    let delivered = 0
    try {
      const now = this.opts.now()
      const due = this.db
        .select()
        .from(pluginEvent)
        .where(and(eq(pluginEvent.status, "pending"), lte(pluginEvent.nextAttemptAt, now)))
        .orderBy(asc(pluginEvent.createdAt), asc(pluginEvent.id))
        .limit(50)
        .all()
      for (const ev of due) {
        const sandbox = this.loaded.get(ev.pluginId)?.sandbox
        // Apagado o sin arrancar: espera a que vuelva (sin gastar intentos).
        if (!sandbox) continue
        const attempts = ev.attempts + 1
        try {
          await sandbox.emit(ev.event, ev.payload)
          this.db
            .update(pluginEvent)
            .set({ status: "done", attempts, deliveredAt: this.opts.now(), lastError: null })
            .where(eq(pluginEvent.id, ev.id))
            .run()
          delivered++
        } catch (e) {
          const message = (e as Error).message
          const delay = RETRY_DELAYS_MS[attempts - 1]
          this.db
            .update(pluginEvent)
            .set({
              attempts,
              lastError: message.slice(0, 500),
              ...(delay === undefined
                ? { status: "failed" as const }
                : { nextAttemptAt: this.opts.now() + delay }),
            })
            .where(eq(pluginEvent.id, ev.id))
            .run()
          this.fail(ev.pluginId, `Evento ${ev.event}: ${message}`)
        }
      }
    } finally {
      this.delivering = false
    }
    return delivered
  }

  /** Las tareas que ya tocan. Devuelve cuántas corrió. */
  async runTasks(): Promise<number> {
    let ran = 0
    const now = this.opts.now()
    for (const [id, l] of this.loaded) {
      if (!l.sandbox) continue
      for (let i = 0; i < l.nextRun.length; i++) {
        if ((l.nextRun[i] ?? Infinity) > now) continue
        l.nextRun[i] = now + (l.sandbox.shape.tasks[i] ?? 60) * 60_000
        try {
          await l.sandbox.task(i)
          ran++
        } catch (e) {
          this.fail(id, `Tarea ${i + 1}: ${(e as Error).message}`)
        }
      }
    }
    return ran
  }

  private log(id: string, level: PluginLog["level"], message: string): void {
    const list = this.logBook.get(id) ?? []
    list.push({ at: this.opts.now(), level, message })
    if (list.length > MAX_LOGS) list.splice(0, list.length - MAX_LOGS)
    this.logBook.set(id, list)
  }

  private fail(id: string, message: string): void {
    this.log(id, "error", message)
    try {
      recordPluginError(this.db, id, message, this.opts.now())
    } catch {
      // ya no existe
    }
  }

  /** Lo que el código del plugin puede usar, atado a su id y a su clave interna. */
  private host(id: string, token: string, archive: PluginArchive) {
    const { manifest } = archive
    return {
      api: async (method: string, path: string, body: unknown) => {
        if (!this.app) throw new Error("La API todavía no está lista")
        if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method))
          throw new Error(`Método no permitido: ${method}`)
        if (!path.startsWith("/api/")) throw new Error("La ruta tiene que empezar con /api/")
        const res = await this.app(
          new Request(`http://plugin.local${path}`, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              ...(body !== null && method !== "GET" ? { "content-type": "application/json" } : {}),
            },
            ...(body !== null && method !== "GET" ? { body: JSON.stringify(body) } : {}),
          }),
        )
        const text = await res.text()
        let parsed: unknown = null
        try {
          parsed = text ? JSON.parse(text) : null
        } catch {
          parsed = text
        }
        return { status: res.status, body: parsed }
      },
      fetch: async (
        url: string,
        init: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        let target: URL
        try {
          target = new URL(url)
        } catch {
          throw new Error(`Dirección inválida: ${url}`)
        }
        if (target.protocol !== "https:") throw new Error("Solo se llama por HTTPS")
        if (!manifest.network.includes(target.hostname.toLowerCase())) {
          throw new Error(`${target.hostname} no está entre los equipos que el plugin declaró`)
        }
        const method = (init.method ?? "GET").toUpperCase()
        if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method))
          throw new Error(`Método no permitido: ${method}`)
        const res = await (this.opts.fetcher ?? fetch)(target, {
          method,
          headers: init.headers ?? {},
          ...(init.body !== undefined && method !== "GET" ? { body: init.body } : {}),
          // Una redirección podría llevarlo a otro equipo: se devuelve tal cual, sin seguirla.
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        })
        const text = await res.text()
        if (text.length > MAX_FETCH_TEXT) throw new Error("La respuesta pasa de 1 MB")
        return {
          status: res.status,
          headers: { "content-type": res.headers.get("content-type") ?? "" },
          body: text,
        }
      },
      storageGet: (key: string) => kvGet(this.db, id, key),
      storageSet: (key: string, value: unknown) => kvSet(this.db, id, key, value, this.opts.now()),
      storageDelete: (key: string) => kvDelete(this.db, id, key),
      storageKeys: () => kvKeys(this.db, id),
      log: (level: "info" | "error", message: string) => this.log(id, level, message),
    }
  }

  /** El plugin y su paquete, para comprobar que existe antes de usarlo. */
  row(id: string) {
    return pluginRow(this.db, id)
  }
}
