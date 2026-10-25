import { type Db, setting } from "@millhiore/db"
import { eq } from "drizzle-orm"

/** En una sucursal: con qué central se sincroniza y por dónde va. */
export interface SyncLink {
  centralUrl: string
  /** La clave con que entra al central (`mws_…`). */
  token: string
  peerId: string
  branchId: string
  branchName: string
  /** Cuándo se unió, con el reloj de esta PC. */
  joinedAt: number
  masterVersion: string | null
  lastMasterAt: number | null
  lastSyncAt: number | null
  lastError: string | null
  lastErrorAt: number | null
  /** Hasta qué fila de cada tabla ya subió (y hasta cuál del central ya bajó). */
  cursors: {
    documents: number
    contacts: number
    audit: number
    events: number
    /** Los turnos cerrados desde entonces se vuelven a subir. */
    shiftsAt: number
    /** Las facturas anotadas desde entonces se vuelven a subir. */
    invoicesAt?: number
    inbox: number
  }
}

const KEY = "sync"

export function readLink(db: Pick<Db, "select">): SyncLink | null {
  const row = db.select().from(setting).where(eq(setting.key, KEY)).get()
  return (row?.value as SyncLink | undefined) ?? null
}

export function writeLink(db: Pick<Db, "insert">, link: SyncLink): void {
  db.insert(setting)
    .values({ key: KEY, value: link })
    .onConflictDoUpdate({ target: setting.key, set: { value: link } })
    .run()
}

/** La sucursal de este servidor si es una sucursal unida a un central; si no, null. */
export const satelliteBranchId = (db: Pick<Db, "select">): string | null =>
  readLink(db)?.branchId ?? null
