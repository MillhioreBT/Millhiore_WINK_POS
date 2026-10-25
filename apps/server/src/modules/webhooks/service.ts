import { createHmac, randomBytes } from "node:crypto"
import type {
  CreateWebhookBody,
  UpdateWebhookBody,
  Webhook,
  WebhookDelivery,
  WebhookEvent,
} from "@millhiore/contracts"
import { auditLog, type Db, type outbox, webhook, webhookDelivery } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, asc, desc, eq, lte } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { getDocument } from "../documents/service"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type OutboxEvent = typeof outbox.$inferSelect

/**
 * Espera antes de cada reintento: 1 min, 5 min, 30 min, 2 h, 6 h y 12 h. Si el último también
 * falla (casi un día sin responder), el aviso se da por fallido.
 */
export const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
]
const TIMEOUT_MS = 10_000
/** Cuántos avisos se mandan por vuelta (cada 5 s), para no saturar a nadie. */
const BATCH = 20

function audit(tx: Tx, actorId: string, now: number, action: string, id: string, data: unknown) {
  tx.insert(auditLog)
    .values({
      id: uuidv7(now),
      at: now,
      actorId,
      action,
      entityType: "webhook",
      entityId: id,
      data,
    })
    .run()
}

/** Los webhooks con su último aviso. */
export function listWebhooks(db: Db): Webhook[] {
  const rows = db.select().from(webhook).orderBy(asc(webhook.createdAt), asc(webhook.id)).all()
  return rows.map((w) => {
    const last = db
      .select({
        status: webhookDelivery.status,
        at: webhookDelivery.createdAt,
        lastStatus: webhookDelivery.lastStatus,
      })
      .from(webhookDelivery)
      .where(eq(webhookDelivery.webhookId, w.id))
      .orderBy(desc(webhookDelivery.createdAt), desc(webhookDelivery.id))
      .limit(1)
      .get()
    return { ...w, events: w.events as WebhookEvent[], last: last ?? null }
  })
}

function getWebhook(db: Db | Tx, id: string) {
  const w = db.select().from(webhook).where(eq(webhook.id, id)).get()
  if (!w) throw new HttpError(404, "NOT_FOUND", "No existe ese webhook")
  return w
}

export function createWebhook(
  db: Db,
  input: CreateWebhookBody,
  actorId: string,
  now: number,
): Webhook {
  const row = {
    id: uuidv7(now),
    name: input.name,
    url: input.url,
    events: [...new Set(input.events)],
    secret: `whsec_${randomBytes(24).toString("base64url")}`,
    active: true,
    createdAt: now,
  }
  db.transaction(
    (tx) => {
      tx.insert(webhook).values(row).run()
      const { secret: _, ...data } = row
      audit(tx, actorId, now, "webhook.created", row.id, data)
    },
    { behavior: "immediate" },
  )
  return { ...row, events: row.events as WebhookEvent[], last: null }
}

export function updateWebhook(
  db: Db,
  id: string,
  patch: UpdateWebhookBody,
  actorId: string,
  now: number,
): Webhook {
  db.transaction(
    (tx) => {
      const { secret: _, ...before } = getWebhook(tx, id)
      const set = {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...(patch.events !== undefined ? { events: [...new Set(patch.events)] } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
      }
      if (Object.keys(set).length) tx.update(webhook).set(set).where(eq(webhook.id, id)).run()
      const { secret: __, ...after } = getWebhook(tx, id)
      audit(tx, actorId, now, "webhook.updated", id, { before, after })
    },
    { behavior: "immediate" },
  )
  const found = listWebhooks(db).find((w) => w.id === id)
  if (!found) throw new HttpError(404, "NOT_FOUND", "No existe ese webhook")
  return found
}

/** Los últimos avisos de un webhook, el más nuevo primero. */
export function listDeliveries(db: Db, webhookId: string, limit = 30): WebhookDelivery[] {
  getWebhook(db, webhookId)
  return db
    .select({
      id: webhookDelivery.id,
      webhookId: webhookDelivery.webhookId,
      eventId: webhookDelivery.eventId,
      event: webhookDelivery.event,
      status: webhookDelivery.status,
      attempts: webhookDelivery.attempts,
      nextAttemptAt: webhookDelivery.nextAttemptAt,
      lastStatus: webhookDelivery.lastStatus,
      lastError: webhookDelivery.lastError,
      createdAt: webhookDelivery.createdAt,
      deliveredAt: webhookDelivery.deliveredAt,
    })
    .from(webhookDelivery)
    .where(eq(webhookDelivery.webhookId, webhookId))
    .orderBy(desc(webhookDelivery.createdAt), desc(webhookDelivery.id))
    .limit(limit)
    .all()
}

function body(eventId: string, event: string, createdAt: number, data: unknown): string {
  return JSON.stringify({ id: eventId, event, createdAt, data })
}

/** Manda un aviso de prueba («ping») en la próxima vuelta. */
export function pingWebhook(db: Db, id: string, now: number): WebhookDelivery {
  const w = getWebhook(db, id)
  const eventId = uuidv7(now)
  const deliveryId = uuidv7(now)
  db.insert(webhookDelivery)
    .values({
      id: deliveryId,
      webhookId: w.id,
      eventId,
      event: "ping",
      body: body(eventId, "ping", now, { message: "Prueba desde Millhiore WINK POS" }),
      status: "pending",
      nextAttemptAt: now,
      createdAt: now,
    })
    .run()
  const [d] = listDeliveries(db, id, 1)
  if (!d) throw new Error("no se guardó la prueba")
  return d
}

/** Vuelve a intentar ya un aviso fallido o pendiente. */
export function retryDelivery(db: Db, deliveryId: string, now: number): void {
  const d = db.select().from(webhookDelivery).where(eq(webhookDelivery.id, deliveryId)).get()
  if (!d) throw new HttpError(404, "NOT_FOUND", "No existe ese aviso")
  if (d.status === "delivered") return
  db.update(webhookDelivery)
    .set({ status: "pending", nextAttemptAt: now })
    .where(eq(webhookDelivery.id, deliveryId))
    .run()
}

/** Los eventos de webhook que salen de uno del `outbox` (una venta es también «sale.posted»). */
export function eventsOf(type: string, payload: unknown): WebhookEvent[] {
  const docType = (payload as { type?: string } | null)?.type
  switch (type) {
    case "document.posted":
      return docType === "SALE" ? ["document.posted", "sale.posted"] : ["document.posted"]
    case "document.voided":
    case "shift.opened":
    case "shift.closed":
    case "rate.updated":
    case "order.created":
      return [type]
    default:
      return []
  }
}

/**
 * Lo que se manda con un evento: en los documentos, el documento completo con sus líneas y pagos;
 * en lo demás, lo que se guardó al registrarlo.
 */
export function eventPayload(tx: Tx, e: OutboxEvent): unknown {
  if (!e.type.startsWith("document.")) return e.payload
  const id = (e.payload as { id?: string } | null)?.id
  try {
    if (id) return getDocument(tx as unknown as Db, id)
  } catch {
    // Si no se puede armar el detalle, va lo que se guardó al registrarlo.
  }
  return e.payload
}

/**
 * Reparte eventos del `outbox` entre los webhooks activos que los esperan (solo los que pasaron
 * después de crear cada webhook). El cuerpo se arma aquí, con el documento completo, para mandar
 * lo mismo en cada intento. Devuelve cuántos avisos quedaron en cola.
 */
export function enqueueWebhooks(tx: Tx, events: OutboxEvent[], now: number): number {
  const hooks = tx.select().from(webhook).where(eq(webhook.active, true)).all()
  if (hooks.length === 0) return 0
  let created = 0
  for (const e of events) {
    const names = eventsOf(e.type, e.payload)
    const targets = hooks.filter(
      (h) => h.createdAt <= e.createdAt && names.some((n) => h.events.includes(n)),
    )
    if (targets.length === 0) continue
    const data = eventPayload(tx, e)
    for (const h of targets) {
      // Una venta llega como «sale.posted» si lo pidió; si no, como «document.posted».
      const name =
        names.find((n) => n === "sale.posted" && h.events.includes(n)) ??
        names.find((n) => h.events.includes(n)) ??
        e.type
      tx.insert(webhookDelivery)
        .values({
          id: uuidv7(now),
          webhookId: h.id,
          eventId: e.id,
          event: name,
          body: body(e.id, name, e.createdAt, data),
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

/** `t=<segundos>,v1=<HMAC-SHA256 de "t.cuerpo" en hex>`, como lo hacen las pasarelas de pago. */
export function signature(secret: string, timestampSec: number, payload: string): string {
  const mac = createHmac("sha256", secret).update(`${timestampSec}.${payload}`).digest("hex")
  return `t=${timestampSec},v1=${mac}`
}

/**
 * Manda los avisos pendientes que ya tocan. Una respuesta 2xx lo da por entregado; cualquier otra
 * cosa (o no responder en 10 s) programa el siguiente intento o, tras el último, lo da por fallido.
 */
export async function deliverDue(
  db: Db,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<{ delivered: number; failed: number }> {
  const due = db
    .select({ d: webhookDelivery, url: webhook.url, secret: webhook.secret })
    .from(webhookDelivery)
    .innerJoin(webhook, eq(webhook.id, webhookDelivery.webhookId))
    // Uno apagado no recibe nada: lo que tenía pendiente espera a que se encienda.
    .where(
      and(
        eq(webhookDelivery.status, "pending"),
        lte(webhookDelivery.nextAttemptAt, now),
        eq(webhook.active, true),
      ),
    )
    .orderBy(asc(webhookDelivery.nextAttemptAt), asc(webhookDelivery.id))
    .limit(BATCH)
    .all()
  let delivered = 0
  let failed = 0
  for (const { d, url, secret } of due) {
    let status: number | null = null
    let error: string | null = null
    try {
      const res = await fetcher(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "MillhioreWINK-Webhooks/1",
          "x-millhiore-event": d.event,
          "x-millhiore-id": d.eventId,
          "x-millhiore-signature": signature(secret, Math.floor(now / 1000), d.body),
        },
        body: d.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      status = res.status
      if (!res.ok) error = `Respondió ${res.status}`
    } catch (e) {
      error =
        (e as Error).name === "TimeoutError" ? "No respondió en 10 s" : String((e as Error).message)
    }
    const attempts = d.attempts + 1
    if (error === null) {
      delivered++
      db.update(webhookDelivery)
        .set({
          status: "delivered",
          attempts,
          lastStatus: status,
          lastError: null,
          nextAttemptAt: null,
          deliveredAt: now,
        })
        .where(eq(webhookDelivery.id, d.id))
        .run()
      continue
    }
    const wait = RETRY_DELAYS_MS[attempts - 1]
    if (wait === undefined) failed++
    db.update(webhookDelivery)
      .set({
        status: wait === undefined ? "failed" : "pending",
        attempts,
        lastStatus: status,
        lastError: error.slice(0, 300),
        nextAttemptAt: wait === undefined ? null : now + wait,
      })
      .where(eq(webhookDelivery.id, d.id))
      .run()
  }
  return { delivered, failed }
}
