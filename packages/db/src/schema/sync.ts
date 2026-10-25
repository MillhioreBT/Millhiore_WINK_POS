import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { user } from "./access"
import { branch } from "./core"

/**
 * En el central: una sucursal con su propio servidor. Ese servidor entra con su clave (se guarda
 * solo su SHA-256), sube lo que registra y baja el catálogo, los clientes y los usuarios.
 */
export const syncPeer = sqliteTable("sync_peer", {
  id: text("id").primaryKey(),
  branchId: text("branch_id")
    .notNull()
    .unique()
    .references(() => branch.id),
  /** El nombre de la PC de la sucursal. */
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  pairedAt: integer("paired_at").notNull(),
  /**
   * El último documento del central al emparejarse: lo de sus cajas hasta ahí es su historia (y
   * baja a la sucursal); lo de después lo registra ella.
   */
  historyRowid: integer("history_rowid").notNull().default(0),
  pairedBy: text("paired_by").references(() => user.id),
  lastSeenAt: integer("last_seen_at"),
  lastPushAt: integer("last_push_at"),
  /** Documentos que subió en total (para mostrarlo). */
  documentsReceived: integer("documents_received").notNull().default(0),
})

/** Un código para emparejar el servidor de una sucursal (de un solo uso, vence en una hora). */
export const syncPairing = sqliteTable("sync_pairing", {
  codeHash: text("code_hash").primaryKey(),
  branchId: text("branch_id")
    .notNull()
    .references(() => branch.id),
  createdBy: text("created_by").references(() => user.id),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
})

/**
 * En una sucursal: los documentos que llegaron del central (su historia anterior, los traslados
 * que le mandan), para no volver a subirlos.
 */
export const syncReceived = sqliteTable("sync_received", {
  documentId: text("document_id").primaryKey(),
  receivedAt: integer("received_at").notNull(),
})
