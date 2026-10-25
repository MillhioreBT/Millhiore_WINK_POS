import type { Db } from "@millhiore/db"

// Acceso directo a SQLite para copiar filas tal cual entre servidores (mismas columnas, mismos
// valores): la sincronización mueve tablas enteras sin pasar por cada módulo.

export type Row = Record<string, unknown>

/** Identificador SQL entre comillas (los nombres vienen de una lista fija, nunca del otro lado). */
const q = (name: string) => `"${name.replace(/"/g, '""')}"`

/** Las columnas de una tabla en esta base, para no confiar en las que manda el otro servidor. */
export function columnsOf(db: Db, table: string): string[] {
  return db.$client
    .query(`pragma table_info(${q(table)})`)
    .all()
    .map((c) => (c as { name: string }).name)
}

export function selectRows(db: Db, sqlText: string, ...params: (string | number)[]): Row[] {
  return db.$client.query(sqlText).all(...params) as Row[]
}

/** Valores que SQLite acepta tal cual (los de JSON ya vienen como texto). */
function value(v: unknown): string | number | bigint | null | Uint8Array {
  if (v === null || v === undefined) return null
  if (typeof v === "boolean") return v ? 1 : 0
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v
  if (v instanceof Uint8Array) return v
  return JSON.stringify(v)
}

const isUnique = (e: unknown) =>
  (e as { code?: string } | null)?.code === "SQLITE_CONSTRAINT_UNIQUE"

/**
 * Inserta filas: `ignore` deja la que ya está; `upsert` la reemplaza por la que llega (sin tocar
 * la clave). Solo usa las columnas que existen aquí. Devuelve cuántas filas nuevas quedaron. Con
 * `retryUnique`, una fila que choca con otro valor único (un código de barras que pasó de un
 * producto a otro) se reintenta después de las demás.
 */
export function writeRows(
  db: Db,
  table: string,
  rows: readonly Row[],
  mode: "ignore" | "upsert",
  pk: readonly string[],
  opts: { retryUnique?: boolean } = {},
): number {
  if (rows.length === 0) return 0
  const known = new Set(columnsOf(db, table))
  const cols = Object.keys(rows[0] ?? {}).filter((c) => known.has(c))
  if (cols.length === 0) return 0
  const update = cols.filter((c) => !pk.includes(c))
  const sqlText =
    `insert into ${q(table)} (${cols.map(q).join(", ")}) values (${cols.map(() => "?").join(", ")})` +
    (mode === "ignore" || update.length === 0
      ? ` on conflict (${pk.map(q).join(", ")}) do nothing`
      : ` on conflict (${pk.map(q).join(", ")}) do update set ${update.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ")}`)
  const statement = db.$client.prepare(sqlText)
  let inserted = 0
  let pending = rows
  for (;;) {
    const failed: Row[] = []
    let error: unknown = null
    for (const row of pending) {
      try {
        inserted += statement.run(...cols.map((c) => value(row[c]))).changes
      } catch (e) {
        if (!opts.retryUnique || !isUnique(e)) throw e
        failed.push(row)
        error = e
      }
    }
    if (failed.length === 0) return inserted
    // Sin avance: el choque es con una fila que no cambia (o un intercambio).
    if (failed.length === pending.length) throw error
    pending = failed
  }
}

/** `?, ?, ?` para una lista (vacía: una que no coincide con nada). */
export const placeholders = (n: number) => (n === 0 ? "null" : Array(n).fill("?").join(", "))
