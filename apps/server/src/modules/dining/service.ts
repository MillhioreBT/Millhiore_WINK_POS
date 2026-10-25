import type {
  AddTabLinesBody,
  DiningFloor,
  DiningLayoutBody,
  MoveTabBody,
  OpenTabBody,
  TabDetail,
  TabSummary,
  UpdateTabBody,
  VoidTabLineBody,
} from "@millhiore/contracts"
import {
  auditLog,
  type Db,
  diningArea,
  diningTable,
  document,
  product,
  tab,
  tabLine,
  user,
  variant,
} from "@millhiore/db"
import { lineTotal, PostingError, uuidv7 } from "@millhiore/domain"
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { HttpError } from "../../http/errors"
import { pickModifiers } from "../../posting/modifiers"
import { pendingLines, splitLine, type TabTake, takeLines } from "../../posting/tabs"
import { createTickets, kitchenStatusByTabLine } from "../kitchen/service"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Pick<Db, "select">

const waiter = alias(user, "waiter")

const summaryColumns = {
  id: tab.id,
  number: tab.number,
  tableId: tab.tableId,
  tableName: diningTable.name,
  areaName: diningArea.name,
  label: tab.label,
  guests: tab.guests,
  status: tab.status,
  waiterId: tab.waiterId,
  waiterName: waiter.name,
  note: tab.note,
  openedAt: tab.openedAt,
  closedAt: tab.closedAt,
  cancelReason: tab.cancelReason,
}

/** Cuentas con su mesa y quién las atiende, y lo que falta por cobrar de cada una. */
function summaries(
  db: Reader,
  where: SQL | undefined,
  limit = 500,
): (TabSummary & { cancelReason: string | null })[] {
  const rows = db
    .select(summaryColumns)
    .from(tab)
    .leftJoin(diningTable, eq(diningTable.id, tab.tableId))
    .leftJoin(diningArea, eq(diningArea.id, diningTable.areaId))
    .leftJoin(waiter, eq(waiter.id, tab.waiterId))
    .where(where)
    .orderBy(desc(tab.openedAt), desc(tab.id))
    .limit(limit)
    .all()
  if (rows.length === 0) return []
  const lines = db
    .select({
      tabId: tabLine.tabId,
      qtyMilli: tabLine.qtyMilli,
      priceMinor: tabLine.priceMinor,
      priceCurrency: tabLine.priceCurrency,
      modifiers: tabLine.modifiers,
    })
    .from(tabLine)
    .where(
      and(
        inArray(
          tabLine.tabId,
          rows.map((r) => r.id),
        ),
        sql`${tabLine.voidedAt} is null and ${tabLine.documentId} is null`,
      ),
    )
    .all()
  return rows.map((r) => {
    let qty = 0
    // Lo pendiente en cada moneda: el producto y sus extras, cantidad × precio, como en la venta.
    const byCurrency = new Map<string, number>()
    const add = (currency: string, minor: number, qtyMilli: number) =>
      byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + lineTotal(qtyMilli, minor))
    for (const l of lines) {
      if (l.tabId !== r.id) continue
      qty += l.qtyMilli
      add(l.priceCurrency, l.priceMinor, l.qtyMilli)
      for (const m of l.modifiers ?? []) {
        if (m.priceMinor && m.priceCurrency) add(m.priceCurrency, m.priceMinor, l.qtyMilli)
      }
    }
    return {
      ...r,
      pendingQtyMilli: qty,
      pending: [...byCurrency].map(([currency, amountMinor]) => ({ currency, amountMinor })),
    }
  })
}

const addedBy = alias(user, "added_by_user")
const voidedBy = alias(user, "voided_by_user")

export function tabDetail(db: Reader, id: string): TabDetail {
  const summary = summaries(db, eq(tab.id, id), 1)[0]
  if (!summary) throw new HttpError(404, "NOT_FOUND", `No existe la cuenta ${id}`)
  const lines = db
    .select({
      id: tabLine.id,
      variantId: tabLine.variantId,
      name: tabLine.name,
      qtyMilli: tabLine.qtyMilli,
      priceMinor: tabLine.priceMinor,
      priceCurrency: tabLine.priceCurrency,
      taxId: product.taxId,
      note: tabLine.note,
      modifiers: tabLine.modifiers,
      addedAt: tabLine.addedAt,
      addedBy: addedBy.name,
      voidedAt: tabLine.voidedAt,
      voidedBy: voidedBy.name,
      voidReason: tabLine.voidReason,
      documentId: tabLine.documentId,
      documentNumber: document.number,
    })
    .from(tabLine)
    .innerJoin(variant, eq(variant.id, tabLine.variantId))
    .innerJoin(product, eq(product.id, variant.productId))
    .leftJoin(addedBy, eq(addedBy.id, tabLine.addedBy))
    .leftJoin(voidedBy, eq(voidedBy.id, tabLine.voidedBy))
    .leftJoin(document, eq(document.id, tabLine.documentId))
    .where(eq(tabLine.tabId, id))
    // Por orden de pedido; dentro de un mismo pedido, como se escribió (los ids son UUIDv7).
    .orderBy(asc(tabLine.addedAt), sql`${tabLine}.rowid`)
    .all()
  const kitchen = kitchenStatusByTabLine(
    db,
    lines.map((l) => l.id),
  )
  return {
    ...summary,
    lines: lines.map((l) => ({
      ...l,
      modifiers: l.modifiers ?? [],
      kitchen: kitchen.get(l.id) ?? null,
    })),
  }
}

/** Las cuentas de un período (o las abiertas), las más recientes primero. */
export function listTabs(
  db: Reader,
  opts: {
    status?: TabSummary["status"] | undefined
    from?: number | undefined
    to?: number | undefined
  },
): TabSummary[] {
  const filters = [
    opts.status ? eq(tab.status, opts.status) : undefined,
    opts.from !== undefined ? sql`${tab.openedAt} >= ${opts.from}` : undefined,
    opts.to !== undefined ? sql`${tab.openedAt} < ${opts.to}` : undefined,
  ].filter((f) => f !== undefined)
  return summaries(db, filters.length ? and(...filters) : undefined).map(
    ({ cancelReason: _, ...s }) => s,
  )
}

/** El plano: cada sala con sus mesas (y la cuenta abierta de cada una) y las cuentas sin mesa. */
export function diningFloor(db: Reader): DiningFloor {
  const areas = db
    .select()
    .from(diningArea)
    .where(eq(diningArea.active, true))
    .orderBy(asc(diningArea.position), asc(diningArea.createdAt))
    .all()
  const tables = db
    .select()
    .from(diningTable)
    .where(eq(diningTable.active, true))
    .orderBy(asc(diningTable.position), asc(diningTable.createdAt))
    .all()
  const open = summaries(db, eq(tab.status, "open")).map(({ cancelReason: _, ...s }) => s)
  const byTable = new Map(open.flatMap((t) => (t.tableId ? [[t.tableId, t] as const] : [])))
  const activeTables = new Set(tables.map((t) => t.id))
  return {
    areas: areas.map((a) => ({
      id: a.id,
      name: a.name,
      tables: tables
        .filter((t) => t.areaId === a.id)
        .map((t) => ({
          id: t.id,
          areaId: t.areaId,
          name: t.name,
          seats: t.seats,
          tab: byTable.get(t.id) ?? null,
        })),
    })),
    // Las de la barra o para llevar, las más viejas primero (son las que esperan más).
    others: open
      .filter((t) => !t.tableId || !activeTables.has(t.tableId))
      .sort((a, b) => a.openedAt - b.openedAt),
  }
}

function audit(tx: Tx, actorId: string, now: number, action: string, id: string, data: unknown) {
  tx.insert(auditLog)
    .values({
      id: uuidv7(now),
      at: now,
      actorId,
      action,
      entityType: action.startsWith("settings.") ? "settings" : "tab",
      entityId: id,
      data,
    })
    .run()
}

const fold = (s: string) => s.trim().toLocaleLowerCase("es")

/**
 * Deja las salas y sus mesas como vienen: renombra y ordena las que existen, crea las nuevas y
 * desactiva las que faltan. Una mesa con la cuenta abierta no se puede quitar.
 */
export function saveLayout(
  db: Db,
  body: DiningLayoutBody,
  actorId: string,
  now: number,
): DiningFloor {
  return db.transaction(
    (tx) => {
      const areaNames = body.areas.map((a) => fold(a.name))
      if (new Set(areaNames).size !== areaNames.length) {
        throw new HttpError(422, "DUPLICATE_NAME", "Dos salas tienen el mismo nombre")
      }
      for (const a of body.areas) {
        const names = a.tables.map((t) => fold(t.name))
        const repeated = names.find((n, i) => names.indexOf(n) !== i)
        if (repeated !== undefined) {
          const shown = a.tables.find((t) => fold(t.name) === repeated)?.name
          throw new HttpError(
            422,
            "DUPLICATE_NAME",
            `En «${a.name}» hay dos mesas que se llaman «${shown}»`,
          )
        }
      }
      const areas = new Map(
        tx
          .select()
          .from(diningArea)
          .all()
          .map((a) => [a.id, a]),
      )
      const tables = new Map(
        tx
          .select()
          .from(diningTable)
          .all()
          .map((t) => [t.id, t]),
      )
      const keptTables = new Set(body.areas.flatMap((a) => a.tables.flatMap((t) => t.id ?? [])))
      const busy = new Set(
        tx
          .select({ tableId: tab.tableId })
          .from(tab)
          .where(eq(tab.status, "open"))
          .all()
          .flatMap((t) => t.tableId ?? []),
      )
      for (const t of tables.values()) {
        if (t.active && !keptTables.has(t.id) && busy.has(t.id)) {
          throw new HttpError(
            409,
            "TABLE_BUSY",
            `La mesa ${t.name} tiene una cuenta abierta: cóbrala o pásala a otra mesa antes de quitarla`,
          )
        }
      }
      const keptAreas = new Set<string>()
      body.areas.forEach((a, i) => {
        let areaId = a.id
        if (areaId && areas.has(areaId)) {
          tx.update(diningArea)
            .set({ name: a.name, position: i, active: true })
            .where(eq(diningArea.id, areaId))
            .run()
        } else {
          areaId = uuidv7(now)
          tx.insert(diningArea)
            .values({ id: areaId, name: a.name, position: i, createdAt: now })
            .run()
        }
        keptAreas.add(areaId)
        a.tables.forEach((t, j) => {
          const values = { areaId, name: t.name, seats: t.seats ?? null, position: j, active: true }
          if (t.id && tables.has(t.id)) {
            tx.update(diningTable).set(values).where(eq(diningTable.id, t.id)).run()
          } else {
            tx.insert(diningTable)
              .values({ id: uuidv7(now), ...values, createdAt: now })
              .run()
          }
        })
      })
      for (const t of tables.values()) {
        if (t.active && !keptTables.has(t.id)) {
          tx.update(diningTable).set({ active: false }).where(eq(diningTable.id, t.id)).run()
        }
      }
      for (const a of areas.values()) {
        if (a.active && !keptAreas.has(a.id)) {
          tx.update(diningArea).set({ active: false }).where(eq(diningArea.id, a.id)).run()
        }
      }
      audit(tx, actorId, now, "settings.dining.updated", "dining", {
        areas: body.areas.map((a) => ({ name: a.name, tables: a.tables.length })),
      })
      return diningFloor(tx)
    },
    { behavior: "immediate" },
  )
}

/** Como se nombra la cuenta en la cocina: «Mesa 4», «Terraza 2» o el nombre de una sin mesa. */
function spokenLabel(tx: Reader, row: typeof tab.$inferSelect): string {
  const table = row.tableId
    ? tx
        .select({ name: diningTable.name })
        .from(diningTable)
        .where(eq(diningTable.id, row.tableId))
        .get()
    : undefined
  if (table) return /^\d/.test(table.name) ? `Mesa ${table.name}` : table.name
  return row.label ?? row.number
}

function openTabRow(tx: Reader, id: string) {
  const row = tx.select().from(tab).where(eq(tab.id, id)).get()
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe la cuenta ${id}`)
  if (row.status !== "open") {
    throw new HttpError(409, "TAB_CLOSED", `La cuenta ${row.number} ya no está abierta`)
  }
  return row
}

function activeTable(tx: Reader, id: string) {
  const row = tx.select().from(diningTable).where(eq(diningTable.id, id)).get()
  if (!row?.active) throw new HttpError(422, "UNKNOWN_TABLE", "Esa mesa no existe")
  return row
}

/** La cuenta abierta de una mesa, si tiene. */
function tabAt(tx: Reader, tableId: string) {
  return tx
    .select()
    .from(tab)
    .where(and(eq(tab.tableId, tableId), eq(tab.status, "open")))
    .get()
}

function insertTab(
  tx: Tx,
  values: {
    id: string
    tableId: string | null
    label: string | null
    guests: number | null
    note: string | null
    waiterId: string | null
  },
  actorId: string,
  now: number,
): string {
  const count = tx.select({ n: sql<number>`count(*)` }).from(tab).get()?.n ?? 0
  const number = `CTA-${String(count + 1).padStart(6, "0")}`
  tx.insert(tab)
    .values({ ...values, number, openedBy: actorId, openedAt: now })
    .run()
  return number
}

/** Abre una cuenta en una mesa libre (o sin mesa, con un nombre). Reenviar el mismo id no abre otra. */
export function openTab(db: Db, body: OpenTabBody, actorId: string, now: number): TabDetail {
  return db.transaction(
    (tx) => {
      if (tx.select({ id: tab.id }).from(tab).where(eq(tab.id, body.id)).get()) {
        return tabDetail(tx, body.id)
      }
      const table = body.tableId ? activeTable(tx, body.tableId) : null
      if (table && tabAt(tx, table.id)) {
        throw new HttpError(409, "TABLE_BUSY", `La mesa ${table.name} ya tiene una cuenta abierta`)
      }
      const number = insertTab(
        tx,
        {
          id: body.id,
          tableId: table?.id ?? null,
          label: body.label?.trim() || null,
          guests: body.guests ?? null,
          note: body.note?.trim() || null,
          waiterId: actorId,
        },
        actorId,
        now,
      )
      audit(tx, actorId, now, "tab.opened", body.id, { number, table: table?.name ?? null })
      return tabDetail(tx, body.id)
    },
    { behavior: "immediate" },
  )
}

export function updateTab(
  db: Db,
  id: string,
  body: UpdateTabBody,
  actorId: string,
  now: number,
): TabDetail {
  return db.transaction(
    (tx) => {
      const row = openTabRow(tx, id)
      if (body.waiterId) {
        const u = tx.select().from(user).where(eq(user.id, body.waiterId)).get()
        if (!u?.active) throw new HttpError(422, "UNKNOWN_USER", "Elige a alguien del equipo")
      }
      const label = body.label === undefined ? row.label : body.label?.trim() || null
      if (!row.tableId && !label) {
        throw new HttpError(422, "LABEL_REQUIRED", "Una cuenta sin mesa necesita un nombre")
      }
      const changes = {
        label,
        guests: body.guests === undefined ? row.guests : body.guests,
        note: body.note === undefined ? row.note : body.note?.trim() || null,
        waiterId: body.waiterId === undefined ? row.waiterId : body.waiterId,
      }
      tx.update(tab).set(changes).where(eq(tab.id, id)).run()
      audit(tx, actorId, now, "tab.updated", id, { number: row.number, ...changes })
      return tabDetail(tx, id)
    },
    { behavior: "immediate" },
  )
}

/**
 * Agrega un pedido a la cuenta con el precio de hoy de cada producto. Las líneas que ya existen
 * (el mismo pedido reenviado) no se repiten.
 */
export function addTabLines(
  db: Db,
  id: string,
  body: AddTabLinesBody,
  actorId: string,
  now: number,
): TabDetail {
  return db.transaction(
    (tx) => {
      const row = openTabRow(tx, id)
      const ids = body.lines.map((l) => l.id)
      if (new Set(ids).size !== ids.length) {
        throw new HttpError(422, "DUPLICATE_LINE", "Un producto del pedido está repetido")
      }
      const existing = new Map(
        tx
          .select({ id: tabLine.id, tabId: tabLine.tabId })
          .from(tabLine)
          .where(inArray(tabLine.id, ids))
          .all()
          .map((l) => [l.id, l.tabId]),
      )
      if ([...existing.values()].some((tabId) => tabId !== id)) {
        throw new HttpError(409, "ID_CONFLICT", "Ese pedido es de otra cuenta")
      }
      const fresh = body.lines.filter((l) => !existing.has(l.id))
      if (fresh.length === 0) return tabDetail(tx, id)
      const variantIds = [...new Set(fresh.map((l) => l.variantId))]
      const items = new Map(
        tx
          .select({
            id: variant.id,
            name: variant.name,
            priceMinor: variant.priceMinor,
            priceCurrency: variant.priceCurrency,
            active: variant.active,
            productActive: product.active,
          })
          .from(variant)
          .innerJoin(product, eq(product.id, variant.productId))
          .where(inArray(variant.id, variantIds))
          .all()
          .map((v) => [v.id, v]),
      )
      for (const v of variantIds) {
        const item = items.get(v)
        if (!item?.active || !item.productActive) {
          throw new HttpError(422, "UNKNOWN_PRODUCT", `Producto desconocido o inactivo: ${v}`)
        }
      }
      // Las opciones y extras, con su precio de hoy (como el producto).
      const picks = asHttp(() => pickModifiers(tx, fresh))
      for (const [i, l] of fresh.entries()) {
        const item = items.get(l.variantId)
        if (!item) continue
        tx.insert(tabLine)
          .values({
            id: l.id,
            tabId: id,
            variantId: l.variantId,
            name: item.name,
            qtyMilli: l.qtyMilli,
            priceMinor: item.priceMinor,
            priceCurrency: item.priceCurrency,
            note: l.note?.trim() || null,
            modifiers: picks[i] ?? null,
            addedBy: actorId,
            addedAt: now,
          })
          .run()
      }
      // A la cocina (o la barra): una comanda por estación con lo que le toca.
      createTickets(
        tx,
        {
          kind: "order",
          source: spokenLabel(tx, row),
          tabId: id,
          actorId,
          lines: fresh.map((l, i) => ({
            tabLineId: l.id,
            variantId: l.variantId,
            name: items.get(l.variantId)?.name ?? "",
            qtyMilli: l.qtyMilli,
            modifiers: picks[i] ?? null,
            note: l.note?.trim() || null,
          })),
        },
        now,
      )
      audit(tx, actorId, now, "tab.ordered", id, {
        number: row.number,
        lines: fresh.map((l) => ({
          name: items.get(l.variantId)?.name,
          qtyMilli: l.qtyMilli,
          note: l.note ?? null,
        })),
      })
      return tabDetail(tx, id)
    },
    { behavior: "immediate" },
  )
}

/** Anula (todo o parte de) un producto ya pedido, con el motivo: queda a la vista, tachado. */
export function voidTabLine(
  db: Db,
  id: string,
  lineId: string,
  body: VoidTabLineBody,
  actorId: string,
  now: number,
): TabDetail {
  return db.transaction(
    (tx) => {
      const row = openTabRow(tx, id)
      const [taken] = asHttp(() => takeLines(tx, id, [{ lineId, qtyMilli: body.qtyMilli }]))
      if (!taken) throw new HttpError(404, "NOT_FOUND", "No existe ese producto en la cuenta")
      splitLine(
        tx,
        taken.line,
        taken.qtyMilli,
        { voidedAt: now, voidedBy: actorId, voidReason: body.reason.trim() },
        now,
      )
      // La cocina deja de prepararlo.
      createTickets(
        tx,
        {
          kind: "void",
          source: spokenLabel(tx, row),
          tabId: id,
          actorId,
          lines: [
            {
              tabLineId: taken.line.id,
              variantId: taken.line.variantId,
              name: taken.line.name,
              qtyMilli: taken.qtyMilli,
              modifiers: taken.line.modifiers,
              note: body.reason.trim(),
            },
          ],
        },
        now,
      )
      audit(tx, actorId, now, "tab.line.voided", id, {
        number: row.number,
        name: taken.line.name,
        qtyMilli: taken.qtyMilli,
        reason: body.reason.trim(),
      })
      return tabDetail(tx, id)
    },
    { behavior: "immediate" },
  )
}

/** Los errores del motor (la cuenta cambió) como respuesta HTTP. */
function asHttp<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof PostingError) {
      throw new HttpError(e.code === "TAB_CHANGED" ? 409 : 422, e.code, e.message)
    }
    throw e
  }
}

/** Cierra una cuenta que se quedó sin nada por cobrar (lo pasaron todo a otra mesa, o se anuló). */
function closeIfDone(tx: Tx, id: string, now: number, reason: string): void {
  if (pendingLines(tx, id).length) return
  const paid = tx
    .select({ n: sql<number>`count(*)` })
    .from(tabLine)
    .where(and(eq(tabLine.tabId, id), sql`${tabLine.documentId} is not null`))
    .get()
  const status = (paid?.n ?? 0) > 0 ? "closed" : "cancelled"
  tx.update(tab)
    .set({ status, closedAt: now, cancelReason: status === "cancelled" ? reason : null })
    .where(eq(tab.id, id))
    .run()
}

/**
 * Pasa la cuenta, o solo algunos de sus productos, a otra mesa o cuenta. Si la mesa de destino
 * está libre y se pasa toda, la cuenta se muda; si está ocupada, se juntan. Devuelve la cuenta de
 * destino.
 */
export function moveTab(
  db: Db,
  id: string,
  body: MoveTabBody,
  actorId: string,
  now: number,
): TabDetail {
  return db.transaction(
    (tx) => {
      const source = openTabRow(tx, id)
      const table = body.tableId ? activeTable(tx, body.tableId) : null
      let target = table ? tabAt(tx, table.id) : body.tabId ? openTabRow(tx, body.tabId) : undefined
      if (target?.id === source.id) {
        throw new HttpError(422, "SAME_TAB", "La cuenta ya está en esa mesa")
      }
      const takes: TabTake[] =
        body.lines ?? pendingLines(tx, id).map((l) => ({ lineId: l.id, qtyMilli: l.qtyMilli }))
      // Toda la cuenta a una mesa libre: solo cambia de mesa.
      if (!target && table && !body.lines) {
        tx.update(tab).set({ tableId: table.id }).where(eq(tab.id, id)).run()
        audit(tx, actorId, now, "tab.moved", id, { number: source.number, table: table.name })
        return tabDetail(tx, id)
      }
      const taken = asHttp(() => takeLines(tx, id, takes))
      if (taken.length === 0) {
        throw new HttpError(422, "EMPTY_TAB", "No hay nada por cobrar que pasar")
      }
      if (!target && table) {
        const newId = uuidv7(now)
        insertTab(
          tx,
          {
            id: newId,
            tableId: table.id,
            label: null,
            guests: null,
            note: null,
            waiterId: source.waiterId,
          },
          actorId,
          now,
        )
        target = tx.select().from(tab).where(eq(tab.id, newId)).get()
      }
      if (!target) throw new HttpError(422, "UNKNOWN_TABLE", "Elige adónde pasa")
      for (const t of taken) splitLine(tx, t.line, t.qtyMilli, { tabId: target.id }, now)
      closeIfDone(tx, id, now, `Pasada a la cuenta ${target.number}`)
      audit(tx, actorId, now, "tab.moved", id, {
        number: source.number,
        to: target.number,
        table: table?.name ?? null,
        lines: taken.map((t) => ({ name: t.line.name, qtyMilli: t.qtyMilli })),
      })
      return tabDetail(tx, target.id)
    },
    { behavior: "immediate" },
  )
}

/**
 * Cierra una cuenta sin cobrarla. Lo que quedaba por cobrar se anula con el motivo (eso exige
 * poder anular ventas: lo decide la ruta).
 */
export function cancelTab(
  db: Db,
  id: string,
  reason: string | null,
  actorId: string,
  now: number,
): TabDetail {
  return db.transaction(
    (tx) => {
      const row = openTabRow(tx, id)
      const pending = pendingLines(tx, id)
      const why = reason?.trim() || null
      for (const l of pending) {
        tx.update(tabLine)
          .set({ voidedAt: now, voidedBy: actorId, voidReason: why ?? "Cuenta anulada" })
          .where(eq(tabLine.id, l.id))
          .run()
      }
      closeIfDone(tx, id, now, why ?? "Cuenta anulada")
      createTickets(
        tx,
        {
          kind: "void",
          source: spokenLabel(tx, row),
          tabId: id,
          actorId,
          lines: pending.map((l) => ({
            tabLineId: l.id,
            variantId: l.variantId,
            name: l.name,
            qtyMilli: l.qtyMilli,
            modifiers: l.modifiers,
            note: why,
          })),
        },
        now,
      )
      audit(tx, actorId, now, "tab.cancelled", id, {
        number: row.number,
        reason: why,
        lines: pending.map((l) => ({ name: l.name, qtyMilli: l.qtyMilli })),
      })
      return tabDetail(tx, id)
    },
    { behavior: "immediate" },
  )
}

/** Si a la cuenta le queda algo por cobrar (para saber qué permiso pide anularla). */
export function hasPending(db: Reader, id: string): boolean {
  return pendingLines(db, id).length > 0
}
