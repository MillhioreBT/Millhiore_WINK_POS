import type { JoinCentralBody } from "@millhiore/contracts"
import { auditLog, type Db, syncReceived } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { HttpError } from "../../http/errors"
import { isConfigured } from "../setup/service"
import { BATCH, type PairResult, type PushBatch } from "./central"
import {
  branchPlaces,
  bundleDocuments,
  bundleShifts,
  type DocumentBundle,
  type ShiftBundle,
  writeDocuments,
  writeShifts,
} from "./documents"
import { readLink, type SyncLink, writeLink } from "./link"
import { applyMasterSnapshot, type MasterSnapshot, schemaVersion } from "./master"
import { placeholders, selectRows, writeRows } from "./raw"

/** Lo que sube a cada vuelta, además de los documentos. */
const SYNCED_EVENTS = ["document.posted", "document.voided", "shift.opened", "shift.closed"]
const AUDIT_BATCH = 1000
/** Una vuelta cada 30 s; la primera, al arrancar. */
export const SYNC_INTERVAL_MS = 30_000
const TIMEOUT_MS = 60_000

/** La dirección del central como se escribe: sin `http://` se le pone; sin barra al final. */
export function normalizeCentralUrl(input: string): string {
  const text = input.trim().replace(/\/+$/, "")
  const url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`)
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new HttpError(422, "INVALID_URL", "Escribe solo la dirección del central, sin rutas")
  }
  return url.origin
}

const maxRowid = (db: Db, table: string) =>
  Number(selectRows(db, `select coalesce(max(rowid), 0) as n from "${table}"`)[0]?.n ?? 0)

/** Una respuesta del central que no es la esperada, con su mensaje en español. */
async function failure(res: Response): Promise<HttpError> {
  let message = `El central respondió ${res.status}`
  let code = "SYNC_FAILED"
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    if (body.error?.message) message = body.error.message
    if (body.error?.code) code = body.error.code
  } catch {
    // sin cuerpo JSON
  }
  return new HttpError(res.status === 401 ? 401 : 502, code, message)
}

export interface SyncClientOptions {
  now?: () => number
  /** Inyectable en las pruebas (lleva al `app.request` del central). */
  fetcher?: typeof fetch
}

/**
 * La sincronización de una sucursal con su central: sube lo que se registró aquí y baja lo que
 * decide el central (catálogo, clientes, usuarios, ajustes) y lo que le mandan (su historia y los
 * traslados). Una vuelta no empieza mientras la anterior sigue.
 */
export class SyncClient {
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number
  readonly fetcher: typeof fetch

  constructor(
    private readonly db: Db,
    opts: SyncClientOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.fetcher = opts.fetcher ?? fetch
  }

  start(intervalMs = SYNC_INTERVAL_MS): void {
    this.stop()
    void this.run()
    this.timer = setInterval(() => void this.run(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Vuelve a subir todo lo registrado aquí desde que se unió (si el central restauró un respaldo
   * anterior): lo que el central ya tiene no se repite.
   */
  async resendAll(): Promise<void> {
    await this.running
    const link = readLink(this.db)
    if (!link) return
    link.cursors = {
      ...link.cursors,
      documents: 0,
      contacts: 0,
      audit: 0,
      events: 0,
      shiftsAt: link.joinedAt,
      invoicesAt: link.joinedAt,
    }
    writeLink(this.db, link)
    await this.run()
  }

  /** Una vuelta (si ya hay una, espera esa). Los errores quedan en el estado, no se lanzan. */
  run(): Promise<void> {
    if (!readLink(this.db)) return Promise.resolve()
    this.running ??= this.once().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async request(link: SyncLink, path: string, init: RequestInit = {}): Promise<Response> {
    return await this.fetcher(`${link.centralUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${link.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  }

  private async once(): Promise<void> {
    const link = readLink(this.db)
    if (!link) return
    try {
      await this.push(link)
      await this.pullMaster(link)
      await this.pullInbox(link)
      link.lastSyncAt = this.now()
      link.lastError = null
      link.lastErrorAt = null
    } catch (e) {
      link.lastError =
        e instanceof HttpError
          ? e.message
          : e instanceof Error && e.name === "TimeoutError"
            ? "El central no respondió a tiempo"
            : "No se pudo llegar al central (¿está encendido y en la misma red de Tailscale?)"
      link.lastErrorAt = this.now()
      if (!(e instanceof HttpError)) console.warn("[sync]", e)
    }
    // El vínculo se relee: si alguien lo quitó mientras tanto, no se vuelve a escribir.
    if (readLink(this.db)?.peerId === link.peerId) writeLink(this.db, link)
  }

  /** Sube todo lo pendiente, en tandas. */
  private async push(link: SyncLink): Promise<void> {
    for (;;) {
      const { batch, next, more } = collectPush(this.db, link, this.now())
      const empty =
        batch.documents.length +
          batch.contacts.length +
          batch.shifts.length +
          batch.audit.length +
          batch.events.length +
          batch.invoices.length ===
        0
      if (!empty) {
        const res = await this.request(link, "/api/sync/push", {
          method: "POST",
          body: JSON.stringify(batch),
        })
        if (!res.ok) throw await failure(res)
      }
      link.cursors = { ...link.cursors, ...next }
      writeLink(this.db, link)
      if (!more) return
    }
  }

  /** Baja lo que decide el central, si cambió. */
  private async pullMaster(link: SyncLink): Promise<void> {
    const res = await this.request(link, "/api/sync/master", {
      headers: link.masterVersion ? { "if-none-match": `"${link.masterVersion}"` } : {},
    })
    if (res.status === 304) return
    if (!res.ok) throw await failure(res)
    const snapshot = (await res.json()) as MasterSnapshot
    // Los clientes que baja no se vuelven a subir: si ya se subió todo lo de aquí, se salta.
    const before = maxRowid(this.db, "contact")
    applyMasterSnapshot(this.db, snapshot)
    if (link.cursors.contacts >= before) link.cursors.contacts = maxRowid(this.db, "contact")
    link.masterVersion = snapshot.version
    link.lastMasterAt = this.now()
  }

  /** Baja lo que le mandan: su historia y los traslados a sus ubicaciones. */
  private async pullInbox(link: SyncLink): Promise<void> {
    for (;;) {
      const res = await this.request(link, `/api/sync/inbox?after=${link.cursors.inbox}`)
      if (!res.ok) throw await failure(res)
      const inbox = (await res.json()) as {
        documents: DocumentBundle[]
        shifts: ShiftBundle[]
        next: number
        more: boolean
      }
      receiveInbox(this.db, inbox, this.now())
      link.cursors.inbox = inbox.next
      writeLink(this.db, link)
      if (!inbox.more) return
    }
  }
}

/** Escribe lo que llegó del central y lo marca para no volver a subirlo. */
export function receiveInbox(
  db: Db,
  inbox: { documents: DocumentBundle[]; shifts: ShiftBundle[] },
  now: number,
): void {
  db.transaction(
    () => {
      // Antes que los documentos: se marcan como recibidos aunque ya estuvieran.
      for (const b of inbox.documents) {
        db.insert(syncReceived)
          .values({ documentId: String(b.document.id), receivedAt: now })
          .onConflictDoNothing()
          .run()
      }
      writeShifts(db, inbox.shifts)
      writeDocuments(db, inbox.documents)
    },
    { behavior: "immediate" },
  )
}

/**
 * Lo que falta subir: los documentos de sus cajas (sin los que llegaron del central), sus
 * clientes nuevos, sus turnos (abiertos o cerrados hace poco), la bitácora y los eventos. Los
 * eventos esperan a que suban todos los documentos (nombran documentos que el central debe tener).
 */
export function collectPush(
  db: Db,
  link: SyncLink,
  now: number,
): { batch: PushBatch; next: Partial<SyncLink["cursors"]>; more: boolean } {
  const { terminals } = branchPlaces(db, link.branchId)
  const t = placeholders(terminals.length)
  const c = link.cursors
  const documents = selectRows(
    db,
    `select rowid as _rowid, * from document
     where rowid > ? and terminal_id in (${t})
       and id not in (select document_id from sync_received)
     order by rowid limit ${BATCH}`,
    c.documents,
    ...terminals,
  )
  const moreDocuments = documents.length === BATCH
  const documentsNext = moreDocuments ? Number(documents.at(-1)?._rowid) : maxRowid(db, "document")
  const contacts = selectRows(
    db,
    "select rowid as _rowid, * from contact where rowid > ? order by rowid",
    c.contacts,
  )
  const shifts = selectRows(
    db,
    `select * from cash_shift where terminal_id in (${t}) and opened_at >= ?
       and (status = 'open' or closed_at >= ?)`,
    ...terminals,
    link.joinedAt,
    c.shiftsAt,
  )
  const audit = selectRows(
    db,
    `select rowid as _rowid, * from audit_log where rowid > ? order by rowid limit ${AUDIT_BATCH}`,
    c.audit,
  )
  const moreAudit = audit.length === AUDIT_BATCH
  const events = moreDocuments
    ? []
    : selectRows(
        db,
        `select rowid as _rowid, * from outbox where rowid > ? and type in (${placeholders(SYNCED_EVENTS.length)}) order by rowid`,
        c.events,
        ...SYNCED_EVENTS,
      )
  // Como los eventos, esperan a que suban todas las ventas.
  const invoices = moreDocuments
    ? []
    : selectRows(
        db,
        `select f.* from fiscal_invoice f join document d on d.id = f.document_id
         where d.terminal_id in (${t}) and f.recorded_at >= ?`,
        ...terminals,
        c.invoicesAt ?? link.joinedAt,
      )
  return {
    batch: {
      schema: schemaVersion(db),
      contacts,
      shifts: bundleShifts(db, shifts),
      documents: bundleDocuments(db, documents),
      audit,
      events,
      invoices,
    },
    next: {
      documents: documentsNext,
      contacts: Number(contacts.at(-1)?._rowid ?? c.contacts),
      shiftsAt: now,
      audit: moreAudit ? Number(audit.at(-1)?._rowid) : maxRowid(db, "audit_log"),
      ...(moreDocuments ? {} : { events: maxRowid(db, "outbox"), invoicesAt: now }),
    },
    more: moreDocuments || moreAudit,
  }
}

/**
 * Une una instalación nueva como sucursal de un central: se empareja con el código, baja todo lo
 * que decide el central (el negocio, sus sucursales, el catálogo, los usuarios…) y la numeración
 * de sus cajas. Después se entra con los mismos usuarios del central.
 */
export async function joinCentral(
  db: Db,
  input: JoinCentralBody,
  fetcher: typeof fetch,
  now: number,
): Promise<{ businessName: string; branchName: string }> {
  if (isConfigured(db)) {
    throw new HttpError(409, "ALREADY_CONFIGURED", "Esta PC ya tiene un negocio configurado")
  }
  let centralUrl: string
  try {
    centralUrl = normalizeCentralUrl(input.centralUrl)
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(422, "INVALID_URL", "La dirección del central no es válida")
  }
  let res: Response
  try {
    res = await fetcher(`${centralUrl}/api/sync/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        name: input.name ?? "",
        schema: schemaVersion(db),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new HttpError(
      502,
      "CENTRAL_UNREACHABLE",
      "No se pudo llegar al central: revisa la dirección y que las dos PC estén en Tailscale",
    )
  }
  if (!res.ok) {
    const e = await failure(res)
    throw new HttpError(e.status === 502 ? 422 : e.status, e.code, e.message)
  }
  const pair = (await res.json()) as PairResult
  if (isConfigured(db)) {
    throw new HttpError(409, "ALREADY_CONFIGURED", "Esta PC ya tiene un negocio configurado")
  }
  applyMasterSnapshot(db, pair.master)
  db.transaction(
    () => {
      writeRows(db, "document_sequence", pair.sequences, "upsert", ["terminal_id", "type"])
      writeLink(db, {
        centralUrl,
        token: pair.token,
        peerId: pair.peerId,
        branchId: pair.branchId,
        branchName: pair.branchName,
        joinedAt: now,
        masterVersion: pair.master.version,
        lastMasterAt: now,
        lastSyncAt: null,
        lastError: null,
        lastErrorAt: null,
        cursors: {
          documents: maxRowid(db, "document"),
          contacts: maxRowid(db, "contact"),
          audit: maxRowid(db, "audit_log"),
          events: maxRowid(db, "outbox"),
          shiftsAt: now,
          invoicesAt: now,
          inbox: 0,
        },
      })
      db.insert(auditLog)
        .values({
          id: uuidv7(now),
          at: now,
          actorId: null,
          action: "sync.joined",
          entityType: "branch",
          entityId: pair.branchId,
          data: { centralUrl, peerId: pair.peerId },
        })
        .run()
    },
    { behavior: "immediate" },
  )
  return { businessName: pair.businessName, branchName: pair.branchName }
}
