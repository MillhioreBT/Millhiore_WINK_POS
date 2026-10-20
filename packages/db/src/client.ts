import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import * as schema from "./schema"

export type Db = ReturnType<typeof createDb>

/** Junto al paquete, o donde diga MIGRATIONS_DIR (el servidor compilado de la app de escritorio). */
const MIGRATIONS_FOLDER = process.env.MIGRATIONS_DIR ?? join(import.meta.dir, "..", "drizzle")

/**
 * Abre la base con los PRAGMAs de integridad: WAL, `synchronous=FULL` (cortes de luz),
 * claves foráneas activas y espera ante bloqueos.
 */
export function createDb(path: string) {
  const sqlite = new Database(path, { create: true })
  sqlite.exec("PRAGMA journal_mode = WAL")
  sqlite.exec("PRAGMA synchronous = FULL")
  sqlite.exec("PRAGMA foreign_keys = ON")
  sqlite.exec("PRAGMA busy_timeout = 5000")
  return drizzle(sqlite, { schema })
}

/** Aplica las migraciones pendientes. */
export function migrateDb(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
}

/** Cuántas migraciones del repositorio aún no se aplicaron a esta base (0 = al día). */
export function pendingMigrations(db: Db): number {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as { entries: unknown[] }
  let applied = 0
  try {
    applied = db.all<{ n: number }>(sql`select count(*) as n from __drizzle_migrations`)[0]?.n ?? 0
  } catch {
    // la tabla de control no existe todavía: base nueva
  }
  return journal.entries.length - applied
}
