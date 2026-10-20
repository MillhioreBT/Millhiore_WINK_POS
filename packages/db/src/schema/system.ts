import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/** Auditoría de toda acción sensible. Inmutable. */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    data: text("data", { mode: "json" }).$type<unknown>(),
  },
  (t) => [index("audit_log_entity").on(t.entityType, t.entityId)],
)

/** Eventos de dominio pendientes de entregar (webhooks, WebSocket, sincronización). */
export const outbox = sqliteTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull().$type<unknown>(),
    createdAt: integer("created_at").notNull(),
    deliveredAt: integer("delivered_at"),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [index("outbox_pending").on(t.deliveredAt, t.createdAt)],
)
