import { createHash, randomBytes } from "node:crypto"
import type { SyncPeer } from "@millhiore/contracts"
import { auditLog, branch, type Db, syncPairing, syncPeer } from "@millhiore/db"
import { splitTax, uuidv7 } from "@millhiore/domain"
import { asc, eq, lt } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { MAIN_BRANCH_ID } from "../branches/service"
import { fiscalSettings } from "../settings/service"
import {
  branchPlaces,
  bundleDocuments,
  bundleShifts,
  checkOwnership,
  type DocumentBundle,
  type ShiftBundle,
  writeDocuments,
  writeShifts,
} from "./documents"
import { buildMasterSnapshot, type MasterSnapshot, requireSameSchema } from "./master"
import { placeholders, type Row, selectRows, writeRows } from "./raw"

/** Un código vale una hora y una sola vez. */
const CODE_TTL_MS = 3_600_000
/** La clave con que el servidor de una sucursal habla con el central (solo se guarda su SHA-256). */
export const SYNC_TOKEN_PREFIX = "mws_"
/** Documentos por envío (en las dos direcciones). */
export const BATCH = 200

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

/** El código como se escribe: sin espacios ni guiones, en mayúsculas. */
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "")

function audit(
  db: Pick<Db, "insert">,
  actorId: string | null,
  now: number,
  action: string,
  id: string,
  data: unknown,
) {
  db.insert(auditLog)
    .values({ id: uuidv7(now), at: now, actorId, action, entityType: "branch", entityId: id, data })
    .run()
}

/**
 * Un código para emparejar el servidor de una sucursal. La sucursal tiene que existir aquí (con
 * sus cajas y ubicaciones) y no tener turnos abiertos: desde que se empareja, se vende allá.
 */
export function createPairingCode(
  db: Db,
  branchId: string,
  actorId: string,
  now: number,
): { code: string; expiresAt: number } {
  if (branchId === MAIN_BRANCH_ID) {
    throw new HttpError(422, "MAIN_BRANCH", "La sucursal principal es la de este servidor")
  }
  const b = db.select().from(branch).where(eq(branch.id, branchId)).get()
  if (!b?.active) throw new HttpError(404, "NOT_FOUND", "No existe esa sucursal (o está inactiva)")
  requireNoOpenShifts(db, branchId, b.name)
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const raw = [...randomBytes(12)].map((x) => alphabet[x % alphabet.length]).join("")
  const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`
  const expiresAt = now + CODE_TTL_MS
  db.insert(syncPairing)
    .values({
      codeHash: sha(normalizeCode(code)),
      branchId,
      createdBy: actorId,
      createdAt: now,
      expiresAt,
    })
    .run()
  audit(db, actorId, now, "sync.pairing.created", branchId, { expiresAt })
  return { code, expiresAt }
}

/** Desde que se empareja, la sucursal vende allá: no puede quedar un turno suyo abierto aquí. */
function requireNoOpenShifts(db: Db, branchId: string, name: string): void {
  const { terminals } = branchPlaces(db, branchId)
  const open = terminals.length
    ? selectRows(
        db,
        `select 1 from cash_shift where status = 'open' and terminal_id in (${placeholders(terminals.length)})`,
        ...terminals,
      )
    : []
  if (open.length) {
    throw new HttpError(409, "SHIFT_OPEN", `Cierra antes los turnos abiertos de ${name}`)
  }
}

export interface PairResult {
  token: string
  peerId: string
  branchId: string
  branchName: string
  businessName: string
  master: MasterSnapshot
  /** Por dónde va la numeración de sus cajas. */
  sequences: Row[]
}

/**
 * El servidor de la sucursal se empareja con su código: recibe su clave (una sola vez), todo lo
 * que decide el central y por dónde va la numeración de sus cajas. Si esa sucursal ya tenía un
 * servidor, el nuevo lo reemplaza (el viejo deja de poder entrar).
 */
export function pairPeer(
  db: Db,
  code: string,
  name: string,
  schema: number,
  now: number,
): PairResult {
  requireSameSchema(db, schema)
  const pairing = db
    .select()
    .from(syncPairing)
    .where(eq(syncPairing.codeHash, sha(normalizeCode(code))))
    .get()
  if (!pairing || pairing.usedAt !== null || pairing.expiresAt < now) {
    throw new HttpError(
      422,
      "INVALID_CODE",
      "El código no es válido o ya venció: pide otro en el central",
    )
  }
  const token = `${SYNC_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`
  const peerId = uuidv7(now)
  const b = db.select().from(branch).where(eq(branch.id, pairing.branchId)).get()
  db.transaction(
    (tx) => {
      requireNoOpenShifts(db, pairing.branchId, b?.name ?? "la sucursal")
      const history = selectRows(db, "select coalesce(max(rowid), 0) as n from document")[0]
      tx.update(syncPairing)
        .set({ usedAt: now })
        .where(eq(syncPairing.codeHash, pairing.codeHash))
        .run()
      tx.delete(syncPeer).where(eq(syncPeer.branchId, pairing.branchId)).run()
      tx.insert(syncPeer)
        .values({
          id: peerId,
          branchId: pairing.branchId,
          name: name.trim() || "Servidor de la sucursal",
          tokenHash: sha(token),
          pairedAt: now,
          historyRowid: Number(history?.n ?? 0),
          pairedBy: pairing.createdBy,
        })
        .run()
      audit(tx, pairing.createdBy, now, "sync.paired", pairing.branchId, { peerId, name })
    },
    { behavior: "immediate" },
  )
  const { terminals } = branchPlaces(db, pairing.branchId)
  const business = selectRows(db, "select name from business limit 1")[0]
  return {
    token,
    peerId,
    branchId: pairing.branchId,
    branchName: b?.name ?? "",
    businessName: String(business?.name ?? ""),
    master: buildMasterSnapshot(db, now),
    sequences: terminals.length
      ? selectRows(
          db,
          `select * from document_sequence where terminal_id in (${placeholders(terminals.length)})`,
          ...terminals,
        )
      : [],
  }
}

export type PeerRow = typeof syncPeer.$inferSelect

/** El servidor de una sucursal, por su clave; anota que se vio. */
export function peerByToken(db: Db, token: string, now: number): PeerRow | null {
  if (!token.startsWith(SYNC_TOKEN_PREFIX)) return null
  const peer = db
    .select()
    .from(syncPeer)
    .where(eq(syncPeer.tokenHash, sha(token)))
    .get()
  if (!peer) return null
  db.update(syncPeer).set({ lastSeenAt: now }).where(eq(syncPeer.id, peer.id)).run()
  return peer
}

export function listPeers(db: Db): SyncPeer[] {
  return db
    .select({
      id: syncPeer.id,
      branchId: syncPeer.branchId,
      branchName: branch.name,
      name: syncPeer.name,
      pairedAt: syncPeer.pairedAt,
      lastSeenAt: syncPeer.lastSeenAt,
      lastPushAt: syncPeer.lastPushAt,
      documentsReceived: syncPeer.documentsReceived,
    })
    .from(syncPeer)
    .innerJoin(branch, eq(branch.id, syncPeer.branchId))
    .orderBy(asc(branch.name))
    .all()
}

/** Deja de recibir a ese servidor (su clave deja de servir); lo ya recibido queda. */
export function unpairPeer(db: Db, branchId: string, actorId: string, now: number): void {
  const removed = db.delete(syncPeer).where(eq(syncPeer.branchId, branchId)).returning().all()
  if (removed.length) audit(db, actorId, now, "sync.unpaired", branchId, { peerId: removed[0]?.id })
}

/** Lo que sube una sucursal en cada envío. */
export interface PushBatch {
  schema: number
  contacts: Row[]
  shifts: ShiftBundle[]
  documents: DocumentBundle[]
  audit: Row[]
  events: Row[]
  /** Los números de las facturas anotadas (o cambiadas) en la sucursal. */
  invoices: Row[]
}

/**
 * Recibe lo que registró la sucursal: clientes nuevos, turnos, documentos (con lo que hay en
 * cada ubicación y cuenta), la bitácora y los eventos (para los webhooks, Telegram y los plugins
 * del central). Solo acepta lo suyo; lo repetido no se vuelve a escribir.
 */
export function receivePush(
  db: Db,
  peer: PeerRow,
  batch: PushBatch,
  now: number,
): { inserted: number } {
  requireSameSchema(db, batch.schema)
  checkOwnership(branchPlaces(db, peer.branchId), batch.documents, batch.shifts)
  return db.transaction(
    () => {
      writeRows(
        db,
        "contact",
        batch.contacts.map((c) => withFreeTaxId(db, c)),
        "ignore",
        ["id"],
      )
      writeShifts(db, batch.shifts)
      const { inserted } = writeDocuments(db, batch.documents)
      applyCosts(
        db,
        batch.documents.filter((b) => inserted.includes(String(b.document.id))),
      )
      writeRows(db, "audit_log", batch.audit, "ignore", ["id"])
      // Solo de sus ventas que ya están aquí.
      const { terminals } = branchPlaces(db, peer.branchId)
      const own = batch.invoices.filter(
        (f) =>
          selectRows(
            db,
            `select 1 from document where id = ? and terminal_id in (${placeholders(terminals.length)})`,
            String(f.document_id),
            ...terminals,
          ).length,
      )
      writeRows(db, "fiscal_invoice", own, "upsert", ["document_id"])
      writeRows(
        db,
        "outbox",
        batch.events.map((e) => ({ ...e, delivered_at: null, attempts: 0 })),
        "ignore",
        ["id"],
      )
      db.update(syncPeer)
        .set({
          lastPushAt: now,
          lastSeenAt: now,
          documentsReceived: peer.documentsReceived + inserted.length,
        })
        .where(eq(syncPeer.id, peer.id))
        .run()
      return { inserted: inserted.length }
    },
    { behavior: "immediate" },
  )
}

/**
 * Un cliente nuevo de la sucursal con un RIF que aquí ya tiene otro (lo crearon a la vez en los
 * dos lados) queda sin RIF, con el RIF en sus notas: sus ventas no se pierden.
 */
function withFreeTaxId(db: Db, contact: Row): Row {
  if (!contact.tax_id) return contact
  const taken = selectRows(db, "select id from contact where tax_id = ?", String(contact.tax_id))[0]
  if (!taken || taken.id === contact.id) return contact
  const note = `RIF ${contact.tax_id} (repetido: creado también en la sucursal)`
  return {
    ...contact,
    tax_id: null,
    notes: contact.notes
      ? `${contact.notes}
${note}`
      : note,
  }
}

/**
 * Las compras de una sucursal dejan su costo en el producto, como las de aquí (y lo producido,
 * el de su receta). Mismo cálculo que el motor: sin el IVA si el negocio lo acredita.
 */
function applyCosts(db: Db, bundles: readonly DocumentBundle[]): void {
  const { taxpayer } = fiscalSettings(db)
  const update = db.$client.prepare(
    "update variant set cost_minor = ?, cost_currency = ? where id = ?",
  )
  for (const b of bundles) {
    const d = b.document
    if (d.reverses_document_id) continue
    if (d.type === "PURCHASE") {
      const includes = Number(d.prices_include_tax) === 1
      for (const l of b.lines) {
        const price = Number(l.unit_price_minor)
        const rate = Number(l.tax_rate_bp)
        const net =
          includes && rate > 0 && taxpayer !== "none"
            ? splitTax(price, rate, true).baseMinor
            : !includes && rate > 0 && taxpayer === "none"
              ? price + splitTax(price, rate, false).taxMinor
              : price
        update.run(net, String(d.currency), String(l.variant_id))
      }
    } else if (d.type === "PRODUCTION") {
      for (const l of b.lines) {
        if (l.cost_minor !== null && l.cost_minor !== undefined && Number(l.qty_milli) > 0) {
          update.run(Number(l.cost_minor), String(l.cost_currency), String(l.variant_id))
        }
      }
    }
  }
}

/**
 * Lo que la sucursal tiene que recibir, después de `after` (un número de fila de los documentos
 * de aquí): su historia de antes de emparejarse (lo registrado en sus cajas hasta entonces) y lo
 * que otros movieron en sus ubicaciones (antes, y después los traslados que le mandan).
 */
export function buildInbox(
  db: Db,
  peer: PeerRow,
  after: number,
): { documents: DocumentBundle[]; shifts: ShiftBundle[]; next: number; more: boolean } {
  const { terminals, locations } = branchPlaces(db, peer.branchId)
  const t = placeholders(terminals.length)
  const l = placeholders(locations.length)
  const rows = selectRows(
    db,
    `select rowid as _rowid, * from document d where rowid > ? and (
       (d.terminal_id in (${t}) and d.rowid <= ?)
       or (d.terminal_id not in (${t}) and exists (
         select 1 from stock_move m where m.document_id = d.id and m.location_id in (${l})))
     ) order by rowid limit ${BATCH}`,
    after,
    ...terminals,
    peer.historyRowid,
    ...terminals,
    ...locations,
  )
  const more = rows.length === BATCH
  const last = Number(rows.at(-1)?._rowid ?? after)
  const top = Number(
    (selectRows(db, "select coalesce(max(rowid), 0) as n from document")[0] as { n: number }).n,
  )
  const shiftIds = [
    ...new Set(
      rows
        .map((r) => r.shift_id)
        .filter(Boolean)
        .map(String),
    ),
  ]
  const shifts = shiftIds.length
    ? selectRows(
        db,
        `select * from cash_shift where id in (${placeholders(shiftIds.length)})`,
        ...shiftIds,
      )
    : []
  return {
    documents: bundleDocuments(db, rows),
    shifts: bundleShifts(db, shifts),
    next: more ? last : Math.max(top, after),
    more,
  }
}

/** Las sucursales que tienen su propio servidor (en el central). */
export function remoteBranchIds(db: Pick<Db, "select">): Set<string> {
  return new Set(
    db
      .select({ id: syncPeer.branchId })
      .from(syncPeer)
      .all()
      .map((r) => r.id),
  )
}

/** Hay alguna sucursal emparejada: este servidor es el central. */
export const isCentral = (db: Pick<Db, "select">) =>
  db.select({ id: syncPeer.id }).from(syncPeer).limit(1).get() !== undefined

/** Para que no se acumulen: los códigos vencidos hace más de un día. */
export function prunePairings(db: Db, now: number): void {
  db.delete(syncPairing)
    .where(lt(syncPairing.expiresAt, now - 86_400_000))
    .run()
}
