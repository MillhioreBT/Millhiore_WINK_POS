import type { CreateOrderBody, PlacedOrder, WebOrder } from "@millhiore/contracts"
import {
  auditLog,
  type Db,
  document,
  outbox,
  user,
  type WebOrderLine,
  webOrder,
} from "@millhiore/db"
import { uuidv7, whatsappNumber } from "@millhiore/domain"
import { and, desc, eq, sql } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { publicCatalog, storefrontSettings } from "../storefront/service"

type Row = typeof webOrder.$inferSelect

/** P-000012 */
export const orderNumber = (n: number) => `P-${String(n).padStart(6, "0")}`

/** Pedidos sin atender a partir de los cuales no se anotan más (que nadie llene la base). */
export const MAX_PENDING_ORDERS = 300

/** Precio × cantidad en milésimas, redondeado a la unidad menor (mitad hacia arriba). */
const lineTotal = (unitMinor: number, qtyMilli: number) =>
  Math.floor((unitMinor * qtyMilli + 500) / 1000)

const sumOf = (lines: WebOrderLine[], key: "referenceMinor" | "legalMinor"): number | null =>
  lines.some((l) => l[key] === null)
    ? null
    : lines.reduce((total, l) => total + lineTotal(l[key] ?? 0, l.qtyMilli), 0)

const placed = (row: Row): PlacedOrder => ({
  id: row.id,
  number: orderNumber(row.number),
  lines: row.lines,
  totalReferenceMinor: row.totalReferenceMinor,
  totalLegalMinor: row.totalLegalMinor,
  referenceCurrency: row.referenceCurrency,
  legalCurrency: row.legalCurrency,
})

/**
 * Anota un pedido del catálogo. Los productos y los precios salen del catálogo de ahora (nunca de
 * lo que manda la página); lo agotado no se pide. Si la página reintenta con el mismo id, devuelve
 * el que ya quedó.
 */
export function placeOrder(db: Db, body: CreateOrderBody, now: number): PlacedOrder {
  const existing = db.select().from(webOrder).where(eq(webOrder.id, body.id)).get()
  if (existing) return placed(existing)

  const settings = storefrontSettings(db)
  const catalog = publicCatalog(db, now)
  if (!settings.orders || !catalog.orders) {
    throw new HttpError(404, "ORDERS_OFF", "Esta tienda no recibe pedidos por el catálogo")
  }
  if (!whatsappNumber(body.phone)) {
    throw new HttpError(
      422,
      "INVALID_PHONE",
      "Escribe tu teléfono con su código, p. ej. 0414-1234567",
    )
  }
  const address = body.address?.trim() || null
  if (body.delivery === "delivery") {
    if (!settings.delivery) throw new HttpError(422, "NO_DELIVERY", "Esta tienda no hace delivery")
    if (!address) throw new HttpError(422, "ADDRESS_REQUIRED", "Escribe la dirección del delivery")
  }

  const variants = new Map(
    catalog.products.flatMap((p) => p.variants.map((v) => [v.id, { product: p, variant: v }])),
  )
  const soldOut: string[] = []
  const lines: WebOrderLine[] = body.lines.map((l) => {
    const found = variants.get(l.variantId)
    if (!found) {
      throw new HttpError(
        422,
        "UNKNOWN_PRODUCT",
        "Un producto del pedido ya no está en el catálogo: vuelve a abrir la página",
      )
    }
    const { product: p, variant: v } = found
    const name = v.optionValues ? `${p.name} (${v.optionValues.join(", ")})` : p.name
    if (p.unit === "unit" && l.qtyMilli % 1000 !== 0) {
      throw new HttpError(422, "INVALID_QUANTITY", `${name} se pide por unidades enteras`)
    }
    if (!v.available) soldOut.push(name)
    return {
      variantId: v.id,
      name,
      unit: p.unit,
      qtyMilli: l.qtyMilli,
      referenceMinor: v.referenceMinor,
      legalMinor: v.legalMinor,
      note: l.note?.trim() || null,
    }
  })
  if (soldOut.length) {
    throw new HttpError(409, "SOLD_OUT", `Se acabó: ${soldOut.join(", ")}. Quítalo del pedido.`)
  }

  return db.transaction(
    (tx) => {
      const pending =
        tx
          .select({ n: sql<number>`count(*)` })
          .from(webOrder)
          .where(eq(webOrder.status, "new"))
          .get()?.n ?? 0
      if (pending >= MAX_PENDING_ORDERS) {
        throw new HttpError(
          429,
          "TOO_MANY_ORDERS",
          "La tienda tiene muchos pedidos sin atender: escríbele por WhatsApp",
        )
      }
      const number =
        (tx
          .select({ n: sql<number | null>`max(${webOrder.number})` })
          .from(webOrder)
          .get()?.n ?? 0) + 1
      const row = {
        id: body.id,
        number,
        status: "new" as const,
        customerName: body.name.trim(),
        customerPhone: body.phone.trim(),
        delivery: body.delivery,
        address: body.delivery === "delivery" ? address : null,
        payment: body.payment?.trim() || null,
        note: body.note?.trim() || null,
        lines,
        totalReferenceMinor: sumOf(lines, "referenceMinor"),
        totalLegalMinor: sumOf(lines, "legalMinor"),
        referenceCurrency: catalog.referenceCurrency,
        legalCurrency: catalog.legalCurrency,
        priceListId: settings.priceListId,
        createdAt: now,
      }
      tx.insert(webOrder).values(row).run()
      const order = orderById(tx, body.id)
      // Para los webhooks y la alerta por Telegram.
      tx.insert(outbox)
        .values({ id: uuidv7(now), type: "order.created", payload: order, createdAt: now })
        .run()
      return placed({
        ...row,
        documentId: null,
        cancelReason: null,
        handledBy: null,
        handledAt: null,
      })
    },
    { behavior: "immediate" },
  )
}

function select(db: Pick<Db, "select">) {
  return db
    .select({ order: webOrder, handledByName: user.name, documentNumber: document.number })
    .from(webOrder)
    .leftJoin(user, eq(user.id, webOrder.handledBy))
    .leftJoin(document, eq(document.id, webOrder.documentId))
}

const toOrder = (r: {
  order: Row
  handledByName: string | null
  documentNumber: string | null
}): WebOrder => ({
  ...placed(r.order),
  status: r.order.status,
  customerName: r.order.customerName,
  customerPhone: r.order.customerPhone,
  delivery: r.order.delivery,
  address: r.order.address,
  payment: r.order.payment,
  note: r.order.note,
  priceListId: r.order.priceListId,
  documentId: r.order.documentId,
  documentNumber: r.documentNumber,
  cancelReason: r.order.cancelReason,
  handledByName: r.handledByName,
  handledAt: r.order.handledAt,
  createdAt: r.order.createdAt,
})

export function orderById(db: Pick<Db, "select">, id: string): WebOrder {
  const row = select(db).where(eq(webOrder.id, id)).get()
  if (!row) throw new HttpError(404, "NOT_FOUND", "No existe ese pedido")
  return toOrder(row)
}

/** Los pedidos de un estado (o todos), del más nuevo al más viejo. */
export function listOrders(
  db: Pick<Db, "select">,
  status: WebOrder["status"] | "all",
  limit = 100,
): WebOrder[] {
  return select(db)
    .where(status === "all" ? undefined : eq(webOrder.status, status))
    .orderBy(desc(webOrder.number))
    .limit(limit)
    .all()
    .map(toOrder)
}

export function countNewOrders(db: Pick<Db, "select">): number {
  return (
    db.select({ n: sql<number>`count(*)` }).from(webOrder).where(eq(webOrder.status, "new")).get()
      ?.n ?? 0
  )
}

/**
 * Cierra un pedido sin cobrarlo en la caja: atendido (se cobró de otra forma) o descartado (con
 * el motivo). Solo los que siguen nuevos.
 */
export function closeOrder(
  db: Db,
  id: string,
  outcome: { status: "done" } | { status: "cancelled"; reason: string | null },
  actorId: string,
  now: number,
): WebOrder {
  return db.transaction(
    (tx) => {
      const current = orderById(tx, id)
      if (current.status !== "new") {
        throw new HttpError(
          409,
          "ORDER_CLOSED",
          `El pedido ${current.number} ya fue atendido o descartado`,
        )
      }
      tx.update(webOrder)
        .set({
          status: outcome.status,
          cancelReason: outcome.status === "cancelled" ? outcome.reason?.trim() || null : null,
          handledBy: actorId,
          handledAt: now,
        })
        .where(and(eq(webOrder.id, id), eq(webOrder.status, "new")))
        .run()
      tx.insert(auditLog)
        .values({
          id: uuidv7(now),
          at: now,
          actorId,
          action: outcome.status === "done" ? "order.done" : "order.cancelled",
          entityType: "web_order",
          entityId: id,
          data: {
            number: current.number,
            ...("reason" in outcome ? { reason: outcome.reason } : {}),
          },
        })
        .run()
      return orderById(tx, id)
    },
    { behavior: "immediate" },
  )
}
