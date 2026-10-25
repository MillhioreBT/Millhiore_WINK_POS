import type { KitchenStation, KitchenTicket, SaveKitchenStationBody } from "@millhiore/contracts"
import {
  auditLog,
  business,
  category,
  type Db,
  document,
  documentLine,
  kitchenStation,
  kitchenTicket,
  kitchenTicketLine,
  type PickedModifier,
  product,
  user,
  variant,
} from "@millhiore/db"
import { dayRange, localDate, uuidv7 } from "@millhiore/domain"
import { COLUMNS, kitchenLines, toEscPos } from "@millhiore/printing"
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { features } from "../features/routes"
import { sendToPrinter } from "../printing/service"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Pick<Db, "select">

export function listStations(db: Reader, opts: { all?: boolean } = {}): KitchenStation[] {
  return db
    .select({
      id: kitchenStation.id,
      name: kitchenStation.name,
      categoryIds: kitchenStation.categoryIds,
      printer: kitchenStation.printer,
      counterSales: kitchenStation.counterSales,
      targetMinutes: kitchenStation.targetMinutes,
      active: kitchenStation.active,
    })
    .from(kitchenStation)
    .where(opts.all ? undefined : eq(kitchenStation.active, true))
    .orderBy(asc(kitchenStation.position), asc(kitchenStation.createdAt))
    .all()
}

/** Crea una estación (sin `id`) o la deja como viene. */
export function saveStation(
  db: Db,
  id: string | null,
  body: SaveKitchenStationBody,
  actorId: string,
  now: number,
): KitchenStation {
  return db.transaction(
    (tx) => {
      const before = id ? listStations(tx, { all: true }).find((s) => s.id === id) : undefined
      if (id && !before) throw new HttpError(404, "NOT_FOUND", `No existe la estación ${id}`)
      const ids = body.categoryIds ?? []
      if (ids.length) {
        const known = tx
          .select({ id: category.id })
          .from(category)
          .where(inArray(category.id, ids))
          .all()
        if (known.length !== new Set(ids).size) {
          throw new HttpError(422, "UNKNOWN_CATEGORY", "Alguna categoría no existe")
        }
      }
      const p = body.printer
      if (
        p &&
        ((p.mode === "network" && !p.host) ||
          (p.mode === "windows" && !p.share) ||
          (p.mode === "device" && !p.device))
      ) {
        throw new HttpError(
          422,
          "PRINTER_TARGET",
          "Falta la IP, el recurso compartido o el dispositivo",
        )
      }
      const values = {
        name: body.name.trim(),
        // Sin categorías elegidas, prepara todo lo que no va a otra estación.
        categoryIds: body.categoryIds?.length ? [...new Set(body.categoryIds)] : null,
        printer: body.printer,
        counterSales: body.counterSales,
        targetMinutes: body.targetMinutes,
        active: body.active,
      }
      const stationId = id ?? uuidv7(now)
      if (id) {
        tx.update(kitchenStation).set(values).where(eq(kitchenStation.id, id)).run()
      } else {
        const count = tx.select({ n: sql<number>`count(*)` }).from(kitchenStation).get()?.n ?? 0
        tx.insert(kitchenStation)
          .values({ id: stationId, ...values, position: count, createdAt: now })
          .run()
      }
      const after = listStations(tx, { all: true }).find((s) => s.id === stationId)
      if (!after) throw new HttpError(500, "INTERNAL", "No se guardó la estación")
      tx.insert(auditLog)
        .values({
          id: uuidv7(now),
          at: now,
          actorId,
          action: id ? "settings.kitchen.updated" : "settings.kitchen.created",
          entityType: "kitchen_station",
          entityId: stationId,
          data: id ? { before, after } : after,
        })
        .run()
      return after
    },
    { behavior: "immediate" },
  )
}

/**
 * A qué estación va cada categoría: la que la nombra o, si ninguna, la que prepara «todo lo
 * demás» (la primera). null = a ninguna (se sirve sin pasar por la cocina).
 */
export function stationResolver(
  db: Reader,
  opts: { counterSale?: boolean } = {},
): (categoryId: string | null) => string | null {
  const stations = listStations(db).filter((s) => !opts.counterSale || s.counterSales)
  const catchAll = stations.find((s) => s.categoryIds === null)?.id ?? null
  return (categoryId) =>
    (categoryId ? stations.find((s) => s.categoryIds?.includes(categoryId))?.id : undefined) ??
    catchAll
}

export interface TicketLineDraft {
  tabLineId?: string | null
  variantId: string
  name: string
  qtyMilli: number
  modifiers: PickedModifier[] | null
  note: string | null
}

/**
 * Las comandas de un pedido, una por estación con lo que le toca. No imprime: eso pasa después
 * de guardar (`printPending`). Devuelve cuántas se crearon.
 */
export function createTickets(
  tx: Tx,
  input: {
    kind: "order" | "void"
    source: string
    tabId?: string | null
    documentId?: string | null
    actorId: string | null
    lines: readonly TicketLineDraft[]
    counterSale?: boolean
  },
  now: number,
): number {
  // Sin la función encendida no hay comandas (aunque haya estaciones de antes).
  if (input.lines.length === 0 || !features(tx).kitchen) return 0
  const resolve = stationResolver(tx, { counterSale: input.counterSale ?? false })
  const categories = new Map(
    tx
      .select({ id: variant.id, categoryId: product.categoryId })
      .from(variant)
      .innerJoin(product, eq(product.id, variant.productId))
      .where(inArray(variant.id, [...new Set(input.lines.map((l) => l.variantId))]))
      .all()
      .map((r) => [r.id, r.categoryId]),
  )
  const byStation = new Map<string, TicketLineDraft[]>()
  for (const l of input.lines) {
    const station = resolve(categories.get(l.variantId) ?? null)
    if (!station) continue
    const list = byStation.get(station)
    if (list) list.push(l)
    else byStation.set(station, [l])
  }
  if (byStation.size === 0) return 0
  const tz = tx.select({ tz: business.timezone }).from(business).get()?.tz ?? "America/Caracas"
  const dayStart = dayRange(localDate(now, tz), tz).from
  let next =
    (tx
      .select({ n: sql<number>`count(*)` })
      .from(kitchenTicket)
      .where(gte(kitchenTicket.createdAt, dayStart))
      .get()?.n ?? 0) + 1
  for (const [stationId, lines] of byStation) {
    const ticketId = uuidv7(now)
    tx.insert(kitchenTicket)
      .values({
        id: ticketId,
        number: next++,
        stationId,
        kind: input.kind,
        source: input.source,
        tabId: input.tabId ?? null,
        documentId: input.documentId ?? null,
        createdBy: input.actorId,
        createdAt: now,
      })
      .run()
    for (const l of lines) {
      tx.insert(kitchenTicketLine)
        .values({
          id: uuidv7(now),
          ticketId,
          tabLineId: l.tabLineId ?? null,
          name: l.name,
          qtyMilli: l.qtyMilli,
          modifiers: l.modifiers?.length ? l.modifiers : null,
          note: l.note,
        })
        .run()
    }
  }
  return byStation.size
}

/** Las comandas de lo vendido directo en la caja (las de una mesa ya se mandaron al pedirlas). */
export function ticketsForSale(db: Db, documentId: string, actorId: string, now: number): number {
  return db.transaction(
    (tx) => {
      const doc = tx.select().from(document).where(eq(document.id, documentId)).get()
      if (doc?.type !== "SALE") return 0
      const lines = tx
        .select({
          variantId: documentLine.variantId,
          name: variant.name,
          qtyMilli: documentLine.qtyMilli,
          modifiers: documentLine.modifiers,
          note: documentLine.note,
        })
        .from(documentLine)
        .innerJoin(variant, eq(variant.id, documentLine.variantId))
        .where(eq(documentLine.documentId, documentId))
        .orderBy(asc(documentLine.lineNo))
        .all()
      return createTickets(
        tx,
        {
          kind: "order",
          source: `Venta ${doc.number}`,
          documentId,
          actorId,
          lines,
          counterSale: true,
        },
        now,
      )
    },
    { behavior: "immediate" },
  )
}

const author = sql<
  string | null
>`(select ${user.name} from ${user} where ${user.id} = ${kitchenTicket.createdBy})`

/** Comandas de una estación (o de todas): las pendientes, o las listas más recientes. */
export function listTickets(
  db: Reader,
  opts: { stationId?: string | undefined; status: "pending" | "ready"; limit?: number },
): KitchenTicket[] {
  const rows = db
    .select({
      id: kitchenTicket.id,
      number: kitchenTicket.number,
      stationId: kitchenTicket.stationId,
      stationName: kitchenStation.name,
      kind: kitchenTicket.kind,
      source: kitchenTicket.source,
      tabId: kitchenTicket.tabId,
      documentId: kitchenTicket.documentId,
      status: kitchenTicket.status,
      createdAt: kitchenTicket.createdAt,
      createdBy: author,
      readyAt: kitchenTicket.readyAt,
      printedAt: kitchenTicket.printedAt,
      printError: kitchenTicket.printError,
    })
    .from(kitchenTicket)
    .innerJoin(kitchenStation, eq(kitchenStation.id, kitchenTicket.stationId))
    .where(
      and(
        eq(kitchenTicket.status, opts.status),
        opts.stationId ? eq(kitchenTicket.stationId, opts.stationId) : undefined,
      ),
    )
    // Pendientes: la más vieja primero (es la que espera más). Listas: la última primero.
    .orderBy(
      opts.status === "pending" ? asc(kitchenTicket.createdAt) : desc(kitchenTicket.readyAt),
      asc(sql`${kitchenTicket}.rowid`),
    )
    .limit(opts.limit ?? 200)
    .all()
  return withLines(db, rows)
}

function withLines<T extends { id: string }>(
  db: Reader,
  rows: T[],
): (T & Pick<KitchenTicket, "lines">)[] {
  if (rows.length === 0) return []
  const lines = db
    .select()
    .from(kitchenTicketLine)
    .where(
      inArray(
        kitchenTicketLine.ticketId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(sql`${kitchenTicketLine}.rowid`))
    .all()
  return rows.map((r) => ({
    ...r,
    lines: lines
      .filter((l) => l.ticketId === r.id)
      .map((l) => ({
        id: l.id,
        name: l.name,
        qtyMilli: l.qtyMilli,
        modifiers: l.modifiers ?? [],
        note: l.note,
      })),
  }))
}

export function ticketById(db: Reader, id: string): KitchenTicket {
  const row = db
    .select({
      id: kitchenTicket.id,
      number: kitchenTicket.number,
      stationId: kitchenTicket.stationId,
      stationName: kitchenStation.name,
      kind: kitchenTicket.kind,
      source: kitchenTicket.source,
      tabId: kitchenTicket.tabId,
      documentId: kitchenTicket.documentId,
      status: kitchenTicket.status,
      createdAt: kitchenTicket.createdAt,
      createdBy: author,
      readyAt: kitchenTicket.readyAt,
      printedAt: kitchenTicket.printedAt,
      printError: kitchenTicket.printError,
    })
    .from(kitchenTicket)
    .innerJoin(kitchenStation, eq(kitchenStation.id, kitchenTicket.stationId))
    .where(eq(kitchenTicket.id, id))
    .get()
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe la comanda ${id}`)
  const [ticket] = withLines(db, [row])
  if (!ticket) throw new HttpError(404, "NOT_FOUND", `No existe la comanda ${id}`)
  return ticket
}

/** Marca una comanda lista (o la devuelve a pendiente, si se marcó por error). */
export function setTicketStatus(
  db: Db,
  id: string,
  status: "pending" | "ready",
  actorId: string,
  now: number,
): KitchenTicket {
  const current = ticketById(db, id)
  if (current.status !== status) {
    db.update(kitchenTicket)
      .set(
        status === "ready"
          ? { status, readyAt: now, readyBy: actorId }
          : { status, readyAt: null, readyBy: null },
      )
      .where(eq(kitchenTicket.id, id))
      .run()
  }
  return ticketById(db, id)
}

/**
 * Manda a su impresora las comandas que aún no se imprimieron. Cada una se reclama antes de
 * imprimirla (dos peticiones a la vez no la imprimen dos veces); si falla, queda el motivo.
 */
export async function printPending(db: Db, now: number): Promise<void> {
  const stations = new Map(listStations(db, { all: true }).map((s) => [s.id, s]))
  const pending = db
    .select({ id: kitchenTicket.id, stationId: kitchenTicket.stationId })
    .from(kitchenTicket)
    .where(and(isNull(kitchenTicket.printedAt), isNull(kitchenTicket.printError)))
    .orderBy(asc(kitchenTicket.createdAt))
    .limit(50)
    .all()
  const tz = db.select({ tz: business.timezone }).from(business).get()?.tz ?? "America/Caracas"
  for (const p of pending) {
    const printer = stations.get(p.stationId)?.printer
    if (!printer) continue
    const claimed = db
      .update(kitchenTicket)
      .set({ printedAt: now })
      .where(and(eq(kitchenTicket.id, p.id), isNull(kitchenTicket.printedAt)))
      .returning({ id: kitchenTicket.id })
      .all()
    if (claimed.length === 0) continue
    try {
      const ticket = ticketById(db, p.id)
      const bytes = toEscPos(kitchenLines(ticket, COLUMNS[printer.paperWidth], tz))
      await sendToPrinter({ ...printer, autoPrint: false, openDrawer: false }, bytes)
    } catch (e) {
      db.update(kitchenTicket)
        .set({ printError: (e as Error).message.slice(0, 300) })
        .where(eq(kitchenTicket.id, p.id))
        .run()
    }
  }
}

/** Vuelve a mandar una comanda a su impresora (después de arreglar el papel o la conexión). */
export function queueReprint(db: Db, id: string): KitchenTicket {
  ticketById(db, id)
  db.update(kitchenTicket)
    .set({ printedAt: null, printError: null })
    .where(eq(kitchenTicket.id, id))
    .run()
  return ticketById(db, id)
}

/** Lo que pasa en la cocina con cada línea de una cuenta (la última comanda que la nombra). */
export function kitchenStatusByTabLine(
  db: Reader,
  tabLineIds: readonly string[],
): Map<string, "pending" | "ready"> {
  if (tabLineIds.length === 0) return new Map()
  const rows = db
    .select({ tabLineId: kitchenTicketLine.tabLineId, status: kitchenTicket.status })
    .from(kitchenTicketLine)
    .innerJoin(kitchenTicket, eq(kitchenTicket.id, kitchenTicketLine.ticketId))
    .where(
      and(inArray(kitchenTicketLine.tabLineId, [...tabLineIds]), eq(kitchenTicket.kind, "order")),
    )
    .all()
  return new Map(rows.flatMap((r) => (r.tabLineId ? [[r.tabLineId, r.status] as const] : [])))
}
