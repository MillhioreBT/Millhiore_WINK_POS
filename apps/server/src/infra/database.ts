import { mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  createDb,
  type Db,
  migrateDb,
  pendingMigrations,
  seedCurrencies,
  seedRoles,
  seedTaxes,
} from "@millhiore/db"
import { applyPendingRestore, backupDatabase } from "./backups"

/**
 * Abre la base de la carpeta de datos dejándola lista: aplica una restauración pendiente (solo el
 * servidor), respalda antes de migrar si hay migraciones nuevas, migra y carga los datos de fábrica.
 */
export function openDatabase(dataDir: string, opts: { applyRestore: boolean }): Db {
  mkdirSync(dataDir, { recursive: true })
  const dbFile = join(dataDir, "millhiore.db")

  if (opts.applyRestore) {
    const restore = applyPendingRestore(dataDir, dbFile, Date.now())
    if (restore && "error" in restore) console.error(`[respaldos] no se restauró: ${restore.error}`)
    else if (restore) {
      console.info(
        `[respaldos] restaurado ${restore.restored}${restore.previous ? `; la base anterior quedó en ${restore.previous}` : ""}`,
      )
    }
  }

  const db = createDb(dbFile)
  const pending = pendingMigrations(db)
  if (pending > 0) {
    const hasData = db.$client
      .query("select count(*) as n from sqlite_master where type = 'table'")
      .get() as { n: number }
    if (hasData.n > 0) {
      const file = backupDatabase(db, join(dataDir, "backups"), "pre-migrate", Date.now())
      console.info(`[db] ${pending} migración(es) pendiente(s); respaldo previo: ${file}`)
    }
    migrateDb(db)
  }
  seedCurrencies(db)
  seedTaxes(db)
  seedRoles(db)
  return db
}
