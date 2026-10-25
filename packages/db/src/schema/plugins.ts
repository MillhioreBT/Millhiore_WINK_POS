import { blob, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { user } from "./access"

/** Lo que dice el `manifest.json` de un plugin (validado al instalarlo). */
export interface PluginManifestData {
  id: string
  name: string
  version: string
  description?: string | undefined
  author?: string | undefined
  permissions: string[]
  events: string[]
  network: string[]
  server?: string | undefined
  page?: { title: string; entry: string } | undefined
}

/**
 * Un plugin instalado: su paquete (.zip) va en la base, para que los respaldos lo lleven. Corre
 * aislado, con los permisos que se le dieron al instalarlo, a nombre de quien lo instaló.
 */
export const plugin = sqliteTable("plugin", {
  /** El id del manifiesto («ventas-del-dia»). */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  manifest: text("manifest", { mode: "json" }).notNull().$type<PluginManifestData>(),
  archive: blob("archive", { mode: "buffer" }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  installedBy: text("installed_by")
    .notNull()
    .references(() => user.id),
  installedAt: integer("installed_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  lastError: text("last_error"),
  lastErrorAt: integer("last_error_at"),
})

/** Lo que cada plugin guarda (clave → valor JSON), con un tope de claves y de tamaño. */
export const pluginKv = sqliteTable(
  "plugin_kv",
  {
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugin.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value", { mode: "json" }).notNull().$type<unknown>(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.pluginId, t.key] })],
)

/** Eventos (ventas, anulaciones…) que esperan llegar a un plugin, con sus reintentos. */
export const pluginEvent = sqliteTable(
  "plugin_event",
  {
    id: text("id").primaryKey(),
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugin.id, { onDelete: "cascade" }),
    /** El evento del `outbox`: el plugin lo usa para no procesarlo dos veces. */
    eventId: text("event_id").notNull(),
    event: text("event").notNull(),
    payload: text("payload", { mode: "json" }).notNull().$type<unknown>(),
    status: text("status", { enum: ["pending", "done", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    deliveredAt: integer("delivered_at"),
  },
  (t) => [index("plugin_event_due").on(t.status, t.nextAttemptAt)],
)
