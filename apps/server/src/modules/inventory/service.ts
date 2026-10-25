import type {
  CreateStockReasonBody,
  ProductionRow,
  StockAdjustmentRow,
  StockAdjustments,
  StockReason,
  UpdateStockReasonBody,
} from "@millhiore/contracts"
import {
  auditLog,
  business,
  currency,
  type Db,
  document,
  documentLine,
  location,
  stockReason,
  user,
  variant,
} from "@millhiore/db"
import { convert, exchangeRate, money, uuidv7 } from "@millhiore/domain"
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { HttpError } from "../../http/errors"
import { inBranches } from "../branches/service"
import { rateAt } from "../rates/service"

// Producción por tandas

/** Lo producido en un período, la más reciente primero (con sus anulaciones). */
export function listProduction(
  db: Db,
  opts: { from?: number | undefined; to?: number | undefined; seeCost: boolean },
): ProductionRow[] {
  const reversal = alias(document, "reversal")
  return db
    .select({
      id: document.id,
      number: document.number,
      postedAt: document.postedAt,
      variantId: documentLine.variantId,
      productName: variant.name,
      qtyMilli: documentLine.qtyMilli,
      unitCostMinor: documentLine.costMinor,
      costCurrency: documentLine.costCurrency,
      locationId: document.locationId,
      locationName: location.name,
      note: document.note,
      createdBy: user.name,
      reversedBy: reversal.id,
      reversesDocumentId: document.reversesDocumentId,
    })
    .from(document)
    .innerJoin(documentLine, eq(documentLine.documentId, document.id))
    .innerJoin(variant, eq(variant.id, documentLine.variantId))
    .innerJoin(location, eq(location.id, document.locationId))
    .leftJoin(reversal, eq(reversal.reversesDocumentId, document.id))
    .leftJoin(user, eq(user.id, document.createdBy))
    .where(
      and(
        eq(document.type, "PRODUCTION"),
        opts.from === undefined ? undefined : gte(document.postedAt, opts.from),
        opts.to === undefined ? undefined : lt(document.postedAt, opts.to),
      ),
    )
    .orderBy(desc(document.postedAt), desc(document.id), asc(documentLine.lineNo))
    .all()
    .map((r) => (opts.seeCost ? r : { ...r, unitCostMinor: null, costCurrency: null }))
}

// Motivos

const reasonColumns = {
  id: stockReason.id,
  name: stockReason.name,
  direction: stockReason.direction,
  position: stockReason.position,
  active: stockReason.active,
  // Ajustes vigentes: los originales menos los que se anularon (un reverso resta uno).
  adjustmentCount: sql<number>`coalesce((select sum(case when "d"."reverses_document_id" is null then 1 else -1 end)
    from "document" as "d" where "d"."stock_reason_id" = "stock_reason"."id"), 0)`,
}

export function listStockReasons(db: Db, opts: { all?: boolean } = {}): StockReason[] {
  return db
    .select(reasonColumns)
    .from(stockReason)
    .where(opts.all ? undefined : eq(stockReason.active, true))
    .orderBy(asc(stockReason.position), asc(stockReason.name))
    .all()
}

function reasonById(db: Db, id: string): StockReason {
  const row = db.select(reasonColumns).from(stockReason).where(eq(stockReason.id, id)).get()
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe el motivo ${id}`)
  return row
}

function duplicate(e: unknown): never {
  if (/UNIQUE/i.test(String((e as Error).cause ?? (e as Error).message))) {
    throw new HttpError(409, "DUPLICATE_NAME", "Ya existe un motivo con ese nombre")
  }
  throw e
}

function audit(db: Db, actorId: string, now: number, action: string, id: string, data: unknown) {
  db.insert(auditLog)
    .values({
      id: uuidv7(now),
      at: now,
      actorId,
      action,
      entityType: "stock_reason",
      entityId: id,
      data,
    })
    .run()
}

export function createStockReason(
  db: Db,
  body: CreateStockReasonBody,
  actorId: string,
  now: number,
): StockReason {
  const id = uuidv7(now)
  try {
    const last = db
      .select({ max: sql<number>`coalesce(max(${stockReason.position}), 0)` })
      .from(stockReason)
      .get()
    db.insert(stockReason)
      .values({ id, name: body.name, direction: body.direction, position: (last?.max ?? 0) + 1 })
      .run()
  } catch (e) {
    duplicate(e)
  }
  const created = reasonById(db, id)
  audit(db, actorId, now, "stock.reason.created", id, created)
  return created
}

export function updateStockReason(
  db: Db,
  id: string,
  patch: UpdateStockReasonBody,
  actorId: string,
  now: number,
): StockReason {
  const before = reasonById(db, id)
  const set = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.position !== undefined ? { position: patch.position } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
  }
  try {
    if (Object.keys(set).length) {
      db.update(stockReason).set(set).where(eq(stockReason.id, id)).run()
    }
  } catch (e) {
    duplicate(e)
  }
  const after = reasonById(db, id)
  audit(db, actorId, now, "stock.reason.updated", id, { before, after })
  return after
}

// Ajustes

/**
 * Los ajustes de inventario de un rango (los más recientes primero), una fila por producto, con lo
 * que valen en moneda legal (último costo del producto al registrarlos, a la tasa de ese día) y
 * el total por motivo. Las anulaciones restan: un reverso lleva la cantidad contraria.
 */
export function listAdjustments(
  db: Db,
  opts: {
    from?: number | undefined
    to?: number | undefined
    reasonId?: string | undefined
    limit: number
    /** Quien consulta puede ver costos; si no, los valores van vacíos. */
    seeCost: boolean
    /** Solo los de estas sucursales; null, todas. */
    branchIds?: readonly string[] | null | undefined
  },
): StockAdjustments {
  const biz = db.select().from(business).get()
  if (!biz) throw new HttpError(409, "NOT_CONFIGURED", "El negocio aún no está configurado")
  const legal = biz.legalCurrency
  const book = Object.fromEntries(
    db
      .select()
      .from(currency)
      .all()
      .map((c) => [c.code, { code: c.code, decimals: c.decimals }]),
  )
  const reversal = alias(document, "reversal")
  const lines = db
    .select({
      id: document.id,
      number: document.number,
      postedAt: document.postedAt,
      reasonId: document.stockReasonId,
      reasonName: stockReason.name,
      direction: stockReason.direction,
      variantId: documentLine.variantId,
      productName: variant.name,
      sku: variant.sku,
      qtyMilli: documentLine.qtyMilli,
      costMinor: documentLine.costMinor,
      costCurrency: documentLine.costCurrency,
      note: document.note,
      createdBy: user.name,
      reversedBy: reversal.id,
      reversesDocumentId: document.reversesDocumentId,
    })
    .from(document)
    .innerJoin(documentLine, eq(documentLine.documentId, document.id))
    .innerJoin(variant, eq(variant.id, documentLine.variantId))
    .leftJoin(stockReason, eq(stockReason.id, document.stockReasonId))
    .leftJoin(reversal, eq(reversal.reversesDocumentId, document.id))
    .leftJoin(user, eq(user.id, document.createdBy))
    .where(
      and(
        eq(document.type, "ADJUSTMENT"),
        opts.from === undefined ? undefined : gte(document.postedAt, opts.from),
        opts.to === undefined ? undefined : lt(document.postedAt, opts.to),
        opts.reasonId ? eq(document.stockReasonId, opts.reasonId) : undefined,
        inBranches(document.locationId, opts.branchIds ?? null),
      ),
    )
    .orderBy(desc(document.postedAt), desc(document.id), asc(documentLine.lineNo))
    .all()

  const legalValue = (l: (typeof lines)[number]): number | null => {
    if (!opts.seeCost || l.costMinor === null || l.costCurrency === null) return null
    // cantidad (milésimas) × costo unitario, redondeado a la unidad menor
    const sign = Math.sign(l.qtyMilli)
    const own = Math.round((Math.abs(l.qtyMilli) * l.costMinor) / 1000)
    if (l.costCurrency === legal) return sign * own
    const base = book[l.costCurrency]
    const quote = book[legal]
    const stored = base && quote ? rateAt(db, l.costCurrency, legal, l.postedAt) : undefined
    if (!(base && quote && stored)) return null
    return (
      sign *
      convert(money(own, l.costCurrency), exchangeRate(stored.base, stored.quote, stored.value), {
        base,
        quote,
      }).amountMinor
    )
  }

  const rows: StockAdjustmentRow[] = lines.map((l) => ({
    id: l.id,
    number: l.number,
    postedAt: l.postedAt,
    reasonId: l.reasonId,
    reasonName: l.reasonName,
    direction: l.direction ?? (l.qtyMilli < 0 ? "out" : "in"),
    variantId: l.variantId,
    productName: l.productName,
    sku: l.sku,
    qtyMilli: l.qtyMilli,
    unitCostMinor: opts.seeCost ? l.costMinor : null,
    costCurrency: opts.seeCost ? l.costCurrency : null,
    valueLegalMinor: legalValue(l),
    note: l.note,
    createdBy: l.createdBy,
    reversedBy: l.reversedBy,
    reversesDocumentId: l.reversesDocumentId,
  }))

  const byReason = new Map<string, StockAdjustments["byReason"][number]>()
  let withoutCost = 0
  const countedDocs = new Set<string>()
  for (const r of rows) {
    const key = r.reasonId ?? "-"
    const row = byReason.get(key) ?? {
      reasonId: r.reasonId,
      reasonName: r.reasonName ?? "Sin motivo",
      direction: r.direction,
      count: 0,
      valueLegalMinor: opts.seeCost ? 0 : null,
    }
    // Un documento cuenta una vez aunque lleve varios productos; el reverso lo resta.
    if (!countedDocs.has(r.id)) {
      countedDocs.add(r.id)
      row.count += r.reversesDocumentId ? -1 : 1
    }
    if (row.valueLegalMinor !== null && r.valueLegalMinor !== null) {
      row.valueLegalMinor += r.valueLegalMinor
    }
    byReason.set(key, row)
    if (opts.seeCost && r.valueLegalMinor === null && !r.reversesDocumentId) withoutCost += 1
  }
  const reasons = [...byReason.values()].filter((r) => r.count !== 0 || r.valueLegalMinor)
  const sum = (direction: "in" | "out") =>
    opts.seeCost
      ? Math.abs(
          reasons
            .filter((r) => r.direction === direction)
            .reduce((acc, r) => acc + (r.valueLegalMinor ?? 0), 0),
        )
      : null

  return {
    rows: rows.slice(0, opts.limit),
    byReason: reasons.sort((a, b) => a.reasonName.localeCompare(b.reasonName, "es")),
    outLegalMinor: sum("out"),
    inLegalMinor: sum("in"),
    withoutCost,
    legalCurrency: legal,
  }
}
