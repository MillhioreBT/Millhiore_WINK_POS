import { Database } from "bun:sqlite"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import type { Db } from "@millhiore/db"
import { sql } from "drizzle-orm"

export const BACKUP_LABELS = [
  "daily",
  "pre-migrate",
  "shift-close",
  "manual",
  "pre-restore",
] as const
export type BackupLabel = (typeof BACKUP_LABELS)[number]

const NAME = new RegExp(`^(${BACKUP_LABELS.join("|")})-(\\d{8}T\\d{6}Z)\\.db$`)

export interface BackupInfo {
  name: string
  label: BackupLabel
  /** Momento del respaldo (ms), sacado del nombre del archivo. */
  at: number
  sizeBytes: number
}

function stamp(now: number): string {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
}

/** "20261014T200000Z" → ms. */
function parseStamp(s: string): number {
  return Date.parse(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`,
  )
}

/** Solo nombres de respaldo válidos: evita que una petición lea o restaure otro archivo. */
export function isBackupName(name: string): boolean {
  return NAME.test(name)
}

/**
 * Instantánea consistente de la base con `VACUUM INTO` (no bloquea las ventas ni copia el WAL a
 * medias). Devuelve la ruta del archivo.
 */
export function backupDatabase(db: Db, dir: string, label: BackupLabel, now: number): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${label}-${stamp(now)}.db`)
  if (existsSync(file)) rmSync(file) // mismo segundo: VACUUM INTO no sobrescribe
  db.$client.query("VACUUM INTO ?").run(file)
  return file
}

/** Respaldos de la carpeta, del más reciente al más antiguo. */
export function listBackups(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .flatMap((name) => {
      const m = NAME.exec(name)
      if (!m?.[1] || !m[2]) return []
      return [
        {
          name,
          label: m[1] as BackupLabel,
          at: parseStamp(m[2]),
          sizeBytes: statSync(join(dir, name)).size,
        },
      ]
    })
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
}

/** Momento del último respaldo de un tipo, o null si no hay ninguno. */
export function lastBackupAt(dir: string, label: BackupLabel): number | null {
  return listBackups(dir).find((b) => b.label === label)?.at ?? null
}

/** Conserva solo los `keep` respaldos más recientes de cada etiqueta. Devuelve los borrados. */
export function rotateBackups(dir: string, keep: number): string[] {
  const removed: string[] = []
  const byLabel = new Map<string, BackupInfo[]>()
  for (const b of listBackups(dir)) byLabel.set(b.label, [...(byLabel.get(b.label) ?? []), b])
  for (const list of byLabel.values()) {
    for (const b of list.slice(keep)) {
      rmSync(join(dir, b.name))
      removed.push(b.name)
    }
  }
  return removed
}

/** `PRAGMA integrity_check`: "ok" si la base está sana, o la descripción del problema. */
export function integrityCheck(db: Db): string {
  const rows = db.all<{ integrity_check: string }>(sql`PRAGMA integrity_check`)
  return rows.map((r) => r.integrity_check).join("; ")
}

/**
 * Una consulta suelta que libera la sentencia al terminar: en Windows, una sentencia viva deja el
 * archivo bloqueado aunque se cierre la conexión.
 */
function once<T>(db: Database, query: string, ...params: string[]): T | null {
  const stmt = db.prepare(query)
  try {
    return stmt.get(...params) as T | null
  } finally {
    stmt.finalize()
  }
}

/** Revisa que un archivo sea una base de Millhiore sana antes de restaurarla. */
export function checkBackupFile(file: string): string {
  let copy: Database | undefined
  try {
    copy = new Database(file, { readonly: true })
    const integrity =
      once<{ integrity_check: string }>(copy, "pragma integrity_check")?.integrity_check ?? ""
    if (integrity !== "ok") return `El respaldo está dañado: ${integrity}`
    const tables = once<{ n: number }>(
      copy,
      "select count(*) as n from sqlite_master where type = 'table' and name = 'business'",
    )
    return tables?.n === 1 ? "ok" : "El archivo no es un respaldo de Millhiore WINK POS"
  } catch (e) {
    return `No se pudo leer el respaldo: ${(e as Error).message}`
  } finally {
    copy?.close()
  }
}

// Restaurar con la base abierta no es seguro: se deja anotado y se aplica al arrancar, antes de
// abrir la base.

const MARKER = "restore.pending"

export function pendingRestore(dataDir: string): string | null {
  const file = join(dataDir, MARKER)
  if (!existsSync(file)) return null
  const name = readFileSync(file, "utf8").trim()
  return isBackupName(name) ? name : null
}

export function scheduleRestore(dataDir: string, name: string): void {
  writeFileSync(join(dataDir, MARKER), name)
}

export function cancelRestore(dataDir: string): void {
  rmSync(join(dataDir, MARKER), { force: true })
}

/**
 * Si hay una restauración anotada, guarda la base actual como `pre-restore` y pone el respaldo en
 * su lugar. Se llama al arrancar, antes de abrir la base. Devuelve lo que hizo, para el registro.
 */
export function applyPendingRestore(
  dataDir: string,
  dbFile: string,
  now: number,
): { restored: string; previous: string | null } | { error: string } | null {
  const name = pendingRestore(dataDir)
  if (!name) {
    cancelRestore(dataDir) // marcador vacío o inválido
    return null
  }
  const backupsDir = join(dataDir, "backups")
  const source = join(backupsDir, name)
  const problem = existsSync(source) ? checkBackupFile(source) : "El respaldo ya no existe"
  if (problem !== "ok") {
    cancelRestore(dataDir)
    return { error: `${name}: ${problem}` }
  }
  let previous: string | null = null
  if (existsSync(dbFile)) {
    // Copia consistente de la base actual (incluye lo que esté en el WAL).
    const current = new Database(dbFile)
    previous = join(backupsDir, `pre-restore-${stamp(now)}.db`)
    rmSync(previous, { force: true })
    try {
      once(current, "VACUUM INTO ?", previous)
    } finally {
      current.close()
    }
  }
  for (const suffix of ["-wal", "-shm"]) rmSync(`${dbFile}${suffix}`, { force: true })
  copyFileSync(source, dbFile)
  cancelRestore(dataDir)
  return { restored: name, previous }
}
