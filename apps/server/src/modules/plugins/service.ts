import type { PluginInfo } from "@millhiore/contracts"
import { auditLog, type Db, type outbox, plugin, pluginEvent, pluginKv, user } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, asc, eq, sql } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { eventPayload, eventsOf } from "../webhooks/service"
import { readArchive } from "./archive"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Row = typeof plugin.$inferSelect

/** Lo que un plugin puede guardar: claves y tamaño de cada valor. */
export const MAX_KV_KEYS = 1_000

function audit(
  db: Pick<Db, "insert">,
  actorId: string,
  now: number,
  action: string,
  id: string,
  data: unknown,
) {
  db.insert(auditLog)
    .values({ id: uuidv7(now), at: now, actorId, action, entityType: "plugin", entityId: id, data })
    .run()
}

export function pluginRow(db: Pick<Db, "select">, id: string): Row {
  const row = db.select().from(plugin).where(eq(plugin.id, id)).get()
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe el plugin ${id}`)
  return row
}

/**
 * Instala un plugin (o lo actualiza si ya hay uno con ese id). Queda a nombre de quien lo
 * instala: corre con los permisos que esa persona tenga, nunca más que los que pide.
 */
export function installPlugin(
  db: Db,
  bytes: Uint8Array,
  actorId: string,
  now: number,
): { row: Row; updated: boolean } {
  const { manifest } = readArchive(bytes)
  return db.transaction(
    (tx) => {
      const old = tx.select().from(plugin).where(eq(plugin.id, manifest.id)).get()
      const data = {
        name: manifest.name,
        version: manifest.version,
        manifest,
        archive: Buffer.from(bytes),
        installedBy: actorId,
        updatedAt: now,
        lastError: null,
        lastErrorAt: null,
      }
      if (old) {
        tx.update(plugin).set(data).where(eq(plugin.id, manifest.id)).run()
      } else {
        tx.insert(plugin)
          .values({ id: manifest.id, ...data, enabled: true, installedAt: now })
          .run()
      }
      audit(tx, actorId, now, old ? "plugin.updated" : "plugin.installed", manifest.id, {
        name: manifest.name,
        version: manifest.version,
        ...(old ? { from: old.version } : {}),
        permissions: manifest.permissions,
        events: manifest.events,
        network: manifest.network,
      })
      return { row: pluginRow(tx, manifest.id), updated: !!old }
    },
    { behavior: "immediate" },
  )
}

export function setPluginEnabled(
  db: Db,
  id: string,
  enabled: boolean,
  actorId: string,
  now: number,
): Row {
  return db.transaction(
    (tx) => {
      pluginRow(tx, id)
      tx.update(plugin).set({ enabled, updatedAt: now }).where(eq(plugin.id, id)).run()
      audit(tx, actorId, now, enabled ? "plugin.enabled" : "plugin.disabled", id, null)
      return pluginRow(tx, id)
    },
    { behavior: "immediate" },
  )
}

/** Lo quita con lo que guardó y lo que esperaba recibir. */
export function uninstallPlugin(db: Db, id: string, actorId: string, now: number): void {
  db.transaction(
    (tx) => {
      const row = pluginRow(tx, id)
      tx.delete(pluginEvent).where(eq(pluginEvent.pluginId, id)).run()
      tx.delete(pluginKv).where(eq(pluginKv.pluginId, id)).run()
      tx.delete(plugin).where(eq(plugin.id, id)).run()
      audit(tx, actorId, now, "plugin.removed", id, { name: row.name, version: row.version })
    },
    { behavior: "immediate" },
  )
}

export function recordPluginError(db: Db, id: string, message: string, now: number): void {
  db.update(plugin)
    .set({ lastError: message.slice(0, 500), lastErrorAt: now })
    .where(eq(plugin.id, id))
    .run()
}

export function listPlugins(
  db: Pick<Db, "select">,
  running: (id: string) => boolean,
): PluginInfo[] {
  const pending = new Map(
    db
      .select({ id: pluginEvent.pluginId, n: sql<number>`count(*)` })
      .from(pluginEvent)
      .where(eq(pluginEvent.status, "pending"))
      .groupBy(pluginEvent.pluginId)
      .all()
      .map((r) => [r.id, r.n]),
  )
  return db
    .select({
      id: plugin.id,
      manifest: plugin.manifest,
      enabled: plugin.enabled,
      installedAt: plugin.installedAt,
      updatedAt: plugin.updatedAt,
      lastError: plugin.lastError,
      lastErrorAt: plugin.lastErrorAt,
      installedByName: user.name,
    })
    .from(plugin)
    .leftJoin(user, eq(user.id, plugin.installedBy))
    .orderBy(asc(plugin.name))
    .all()
    .map((r) => ({
      id: r.id,
      name: r.manifest.name,
      version: r.manifest.version,
      description: r.manifest.description ?? null,
      author: r.manifest.author ?? null,
      permissions: r.manifest.permissions,
      events: r.manifest.events,
      network: r.manifest.network,
      page: r.manifest.page
        ? { title: r.manifest.page.title, url: `/plugins/${r.id}/${r.manifest.page.entry}` }
        : null,
      hasServer: !!r.manifest.server,
      enabled: r.enabled,
      running: running(r.id),
      installedAt: r.installedAt,
      installedByName: r.installedByName,
      updatedAt: r.updatedAt,
      lastError: r.lastError,
      lastErrorAt: r.lastErrorAt,
      pendingEvents: pending.get(r.id) ?? 0,
    }))
}

/** Pone en la cola de cada plugin encendido los eventos que espera (de después de instalarlo). */
export function enqueuePluginEvents(
  tx: Tx,
  events: (typeof outbox.$inferSelect)[],
  now: number,
): number {
  const plugins = tx
    .select({ id: plugin.id, manifest: plugin.manifest, installedAt: plugin.installedAt })
    .from(plugin)
    .where(eq(plugin.enabled, true))
    .all()
    .filter((p) => p.manifest.server && p.manifest.events.length)
  if (plugins.length === 0) return 0
  let created = 0
  for (const e of events) {
    const names = eventsOf(e.type, e.payload)
    const targets = plugins.filter(
      (p) => p.installedAt <= e.createdAt && names.some((n) => p.manifest.events.includes(n)),
    )
    if (targets.length === 0) continue
    const data = eventPayload(tx, e)
    for (const p of targets) {
      // Una venta llega como «sale.posted» si la pidió; si no, como «document.posted».
      const name =
        names.find((n) => n === "sale.posted" && p.manifest.events.includes(n)) ??
        names.find((n) => p.manifest.events.includes(n)) ??
        e.type
      tx.insert(pluginEvent)
        .values({
          id: uuidv7(now),
          pluginId: p.id,
          eventId: e.id,
          event: name,
          payload: data,
          status: "pending",
          nextAttemptAt: now,
          createdAt: now,
        })
        .run()
      created++
    }
  }
  return created
}

/** Lo que el plugin guardó, por clave. */
export function kvGet(db: Pick<Db, "select">, pluginId: string, key: string): unknown {
  return db
    .select({ value: pluginKv.value })
    .from(pluginKv)
    .where(and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, key)))
    .get()?.value
}

export function kvSet(db: Db, pluginId: string, key: string, value: unknown, now: number): void {
  if (!key || key.length > 200) throw new Error("La clave va de 1 a 200 caracteres")
  const exists = kvGet(db, pluginId, key) !== undefined
  if (!exists) {
    const n =
      db
        .select({ n: sql<number>`count(*)` })
        .from(pluginKv)
        .where(eq(pluginKv.pluginId, pluginId))
        .get()?.n ?? 0
    if (n >= MAX_KV_KEYS) throw new Error(`Un plugin guarda hasta ${MAX_KV_KEYS} claves`)
  }
  db.insert(pluginKv)
    .values({ pluginId, key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: [pluginKv.pluginId, pluginKv.key],
      set: { value, updatedAt: now },
    })
    .run()
}

export function kvDelete(db: Db, pluginId: string, key: string): void {
  db.delete(pluginKv)
    .where(and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, key)))
    .run()
}

export function kvKeys(db: Pick<Db, "select">, pluginId: string): string[] {
  return db
    .select({ key: pluginKv.key })
    .from(pluginKv)
    .where(eq(pluginKv.pluginId, pluginId))
    .orderBy(asc(pluginKv.key))
    .all()
    .map((r) => r.key)
}
