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

/**
 * Webhook: avisa a otro sistema (por HTTP) cada vez que pasa algo de lo que eligió (una venta, un
 * cierre de turno, la tasa nueva). Cada aviso va firmado con su secreto (HMAC-SHA256).
 */
export const webhook = sqliteTable("webhook", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  /** Los eventos que recibe («sale.posted», «shift.closed»…). */
  events: text("events", { mode: "json" }).notNull().$type<string[]>(),
  /** Con él firma cada aviso; quien lo recibe lo usa para comprobar que viene de aquí. */
  secret: text("secret").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
})

/**
 * Cada aviso de un evento a un webhook, con sus intentos: si el otro sistema no responde, se
 * reintenta cada vez más espaciado hasta darse por fallido. El cuerpo se arma una vez y se manda
 * igual en cada intento.
 */
export const webhookDelivery = sqliteTable(
  "webhook_delivery",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhook.id),
    /** El evento del `outbox` (o el id de una prueba): quien recibe lo usa para no repetir. */
    eventId: text("event_id").notNull(),
    event: text("event").notNull(),
    body: text("body").notNull(),
    status: text("status", { enum: ["pending", "delivered", "failed"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    /** Lo último que respondió: el código HTTP o el error de red. */
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    deliveredAt: integer("delivered_at"),
  },
  (t) => [
    index("webhook_delivery_pending").on(t.status, t.nextAttemptAt),
    index("webhook_delivery_webhook").on(t.webhookId, t.createdAt),
  ],
)

/**
 * Alerta por Telegram en camino a un chat: si no hay internet se reintenta unas veces; una alerta
 * vieja ya no sirve, así que pronto se da por fallida.
 */
export const telegramMessage = sqliteTable(
  "telegram_message",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull(),
    /** Qué alerta es («daily», «low_stock», «void», «shift», «rate», «test»). */
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    sentAt: integer("sent_at"),
  },
  (t) => [index("telegram_message_pending").on(t.status, t.nextAttemptAt)],
)
