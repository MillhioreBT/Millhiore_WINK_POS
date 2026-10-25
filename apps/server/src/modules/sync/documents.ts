import type { Db } from "@millhiore/db"
import { HttpError } from "../../http/errors"
import { placeholders, type Row, selectRows, writeRows } from "./raw"

/** Un documento con todo lo que cuelga de él, tal como está en la base. */
export interface DocumentBundle {
  document: Row
  lines: Row[]
  taxes: Row[]
  surcharges: Row[]
  charges: Row[]
  payments: Row[]
  allocations: Row[]
  lots: Row[]
  stockMoves: Row[]
  accountMoves: Row[]
}

/** Un turno de caja con el arqueo de cada cuenta. */
export interface ShiftBundle {
  shift: Row
  accounts: Row[]
}

const byDocument = (db: Db, table: string, column: string, ids: string[]) =>
  ids.length
    ? selectRows(
        db,
        `select * from "${table}" where ${column} in (${placeholders(ids.length)}) order by rowid`,
        ...ids,
      )
    : []

/** Los documentos (en el orden en que se registraron) con sus líneas, pagos y movimientos. */
export function bundleDocuments(db: Db, documents: Row[]): DocumentBundle[] {
  const ids = documents.map((d) => String(d.id))
  const group = (rows: Row[], key = "document_id") => {
    const map = new Map<string, Row[]>()
    for (const r of rows) {
      const k = String(r[key])
      const list = map.get(k)
      if (list) list.push(r)
      else map.set(k, [r])
    }
    return map
  }
  const lines = group(byDocument(db, "document_line", "document_id", ids))
  const taxes = group(byDocument(db, "document_tax", "document_id", ids))
  const surcharges = group(byDocument(db, "document_surcharge", "document_id", ids))
  const charges = group(byDocument(db, "document_charge", "document_id", ids))
  const payments = group(byDocument(db, "payment", "document_id", ids))
  const allocations = group(
    byDocument(db, "allocation", "payment_document_id", ids),
    "payment_document_id",
  )
  const stockMoves = group(byDocument(db, "stock_move", "document_id", ids))
  const accountMoves = group(byDocument(db, "account_move", "document_id", ids))
  // Los lotes que nombran sus movimientos (de este documento o de uno anterior).
  const lotIds = [
    ...new Set(
      [...stockMoves.values()]
        .flat()
        .map((m) => m.lot_id)
        .filter(Boolean)
        .map(String),
    ),
  ]
  const lots = lotIds.length
    ? selectRows(db, `select * from lot where id in (${placeholders(lotIds.length)})`, ...lotIds)
    : []
  return documents.map((d) => {
    const id = String(d.id)
    const moves = stockMoves.get(id) ?? []
    const own = new Set(
      moves
        .map((m) => m.lot_id)
        .filter(Boolean)
        .map(String),
    )
    return {
      document: d,
      lines: lines.get(id) ?? [],
      taxes: taxes.get(id) ?? [],
      surcharges: surcharges.get(id) ?? [],
      charges: charges.get(id) ?? [],
      payments: payments.get(id) ?? [],
      allocations: allocations.get(id) ?? [],
      lots: lots.filter((l) => own.has(String(l.id))),
      stockMoves: moves,
      accountMoves: accountMoves.get(id) ?? [],
    }
  })
}

export function bundleShifts(db: Db, shifts: Row[]): ShiftBundle[] {
  const ids = shifts.map((s) => String(s.id))
  const accounts = byDocument(db, "cash_shift_account", "shift_id", ids)
  return shifts.map((s) => ({ shift: s, accounts: accounts.filter((a) => a.shift_id === s.id) }))
}

/**
 * Escribe turnos que llegan de otro servidor: uno nuevo se agrega; uno que aquí sigue abierto
 * se actualiza (primero su arqueo, porque cerrado ya no se puede tocar); uno cerrado no cambia.
 */
export function writeShifts(db: Db, shifts: readonly ShiftBundle[]): void {
  for (const { shift, accounts } of shifts) {
    const here = selectRows(db, "select status from cash_shift where id = ?", String(shift.id))[0]
    if (here?.status === "closed") continue
    if (!here) {
      writeRows(db, "cash_shift", [shift], "ignore", ["id"])
      writeRows(db, "cash_shift_account", accounts, "ignore", ["shift_id", "account_id"])
      continue
    }
    writeRows(db, "cash_shift_account", accounts, "upsert", ["shift_id", "account_id"])
    writeRows(db, "cash_shift", [shift], "upsert", ["id"])
  }
}

export interface WrittenDocuments {
  /** Los que no estaban. */
  inserted: string[]
}

/**
 * Escribe documentos que llegan de otro servidor, sin repetir los que ya están. Un lote cuyo
 * documento de entrada no está aquí queda como entrado con el documento que lo trae (pasa con un
 * traslado). Luego rehace lo que hay en cada ubicación, lote y cuenta que tocaron.
 */
export function writeDocuments(db: Db, bundles: readonly DocumentBundle[]): WrittenDocuments {
  const inserted: string[] = []
  const stockKeys = new Set<string>()
  const lotKeys = new Set<string>()
  const accounts = new Set<string>()
  for (const b of bundles) {
    const id = String(b.document.id)
    if (selectRows(db, "select 1 from document where id = ?", id).length) continue
    writeRows(db, "document", [b.document], "ignore", ["id"])
    writeRows(db, "document_line", b.lines, "ignore", ["id"])
    writeRows(db, "document_tax", b.taxes, "ignore", ["id"])
    writeRows(db, "document_surcharge", b.surcharges, "ignore", ["id"])
    writeRows(db, "document_charge", b.charges, "ignore", ["id"])
    writeRows(db, "payment", b.payments, "ignore", ["id"])
    for (const lot of b.lots) {
      const origin = selectRows(db, "select 1 from document where id = ?", String(lot.document_id))
      writeRows(db, "lot", [origin.length ? lot : { ...lot, document_id: id }], "ignore", ["id"])
    }
    writeRows(db, "stock_move", b.stockMoves, "ignore", ["id"])
    writeRows(db, "account_move", b.accountMoves, "ignore", ["id"])
    // Un abono a una venta que este servidor no tiene se queda sin aplicar aquí.
    const allocations = b.allocations.filter(
      (a) =>
        selectRows(db, "select 1 from document where id = ?", String(a.sale_document_id)).length,
    )
    writeRows(db, "allocation", allocations, "ignore", ["id"])
    for (const m of b.stockMoves) {
      stockKeys.add(`${m.variant_id}|${m.location_id}`)
      if (m.lot_id) lotKeys.add(`${m.lot_id}|${m.location_id}`)
    }
    for (const m of b.accountMoves) accounts.add(String(m.account_id))
    inserted.push(id)
  }
  recomputeBalances(db, stockKeys, lotKeys, accounts)
  return { inserted }
}

/** Lo que hay es la suma de sus movimientos: se rehace para lo que tocaron los documentos. */
function recomputeBalances(
  db: Db,
  stockKeys: ReadonlySet<string>,
  lotKeys: ReadonlySet<string>,
  accounts: ReadonlySet<string>,
): void {
  const stock = db.$client.prepare(
    `insert into stock_balance (variant_id, location_id, qty_milli)
     select ?1, ?2, coalesce((select sum(qty_milli) from stock_move where variant_id = ?1 and location_id = ?2), 0)
     on conflict (variant_id, location_id) do update set qty_milli = excluded.qty_milli`,
  )
  for (const k of stockKeys) {
    const [variantId, locationId] = k.split("|")
    stock.run(variantId ?? "", locationId ?? "")
  }
  const lots = db.$client.prepare(
    `insert into lot_balance (lot_id, location_id, qty_milli)
     select ?1, ?2, coalesce((select sum(qty_milli) from stock_move where lot_id = ?1 and location_id = ?2), 0)
     on conflict (lot_id, location_id) do update set qty_milli = excluded.qty_milli`,
  )
  for (const k of lotKeys) {
    const [lotId, locationId] = k.split("|")
    lots.run(lotId ?? "", locationId ?? "")
  }
  const money = db.$client.prepare(
    `insert into account_balance (account_id, amount_minor)
     select ?1, coalesce((select sum(amount_minor) from account_move where account_id = ?1), 0)
     on conflict (account_id) do update set amount_minor = excluded.amount_minor`,
  )
  for (const a of accounts) money.run(a)
}

/** Las cajas y ubicaciones de una sucursal. */
export function branchPlaces(
  db: Db,
  branchId: string,
): { terminals: string[]; locations: string[] } {
  const locations = selectRows(db, "select id from location where branch_id = ?", branchId).map(
    (r) => String(r.id),
  )
  const terminals = locations.length
    ? selectRows(
        db,
        `select id from terminal where location_id in (${placeholders(locations.length)})`,
        ...locations,
      ).map((r) => String(r.id))
    : []
  return { terminals, locations }
}

/**
 * Lo que manda una sucursal tiene que ser suyo: documentos y turnos de sus cajas, movimientos en
 * sus ubicaciones (o en el destino de un traslado suyo).
 */
export function checkOwnership(
  places: { terminals: string[]; locations: string[] },
  bundles: readonly DocumentBundle[],
  shifts: readonly ShiftBundle[],
): void {
  const terminals = new Set(places.terminals)
  const locations = new Set(places.locations)
  const reject = (what: string) =>
    new HttpError(403, "SYNC_FOREIGN", `La sucursal mandó ${what} que no es suyo`)
  for (const s of shifts) {
    if (!terminals.has(String(s.shift.terminal_id))) throw reject(`el turno ${s.shift.id}`)
  }
  for (const b of bundles) {
    const d = b.document
    if (!terminals.has(String(d.terminal_id))) throw reject(`el documento ${d.number}`)
    for (const m of b.stockMoves) {
      const own = locations.has(String(m.location_id))
      const destination = d.type === "STOCK_TRANSFER" && m.location_id === d.to_location_id
      if (!own && !destination) throw reject(`un movimiento de ${d.number} en otra ubicación`)
    }
  }
}
