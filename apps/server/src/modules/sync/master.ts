import { createHash } from "node:crypto"
import type { Db } from "@millhiore/db"
import { HttpError } from "../../http/errors"
import { placeholders, type Row, selectRows, writeRows } from "./raw"

/**
 * Lo que decide el central y baja a cada sucursal, en el orden en que se escribe (cada tabla
 * después de las que nombra). `replace`: la sucursal la deja igual a la del central (las que se
 * reemplazan enteras al editar un producto o un usuario).
 */
const MASTER_TABLES: { name: string; pk: string[]; replace?: boolean; where?: string }[] = [
  { name: "currency", pk: ["code"] },
  { name: "business", pk: ["id"] },
  { name: "branch", pk: ["id"] },
  { name: "location", pk: ["id"] },
  { name: "terminal", pk: ["id"] },
  { name: "tax", pk: ["id"] },
  { name: "surcharge", pk: ["id"] },
  { name: "account", pk: ["id"] },
  { name: "payment_method", pk: ["id"] },
  { name: "expense_category", pk: ["id"] },
  { name: "stock_reason", pk: ["id"] },
  { name: "category", pk: ["id"] },
  { name: "price_list", pk: ["id"] },
  { name: "product", pk: ["id"] },
  { name: "variant", pk: ["id"] },
  { name: "price_list_price", pk: ["price_list_id", "variant_id"], replace: true },
  { name: "sale_charge", pk: ["id"] },
  { name: "discount_code", pk: ["id"] },
  { name: "modifier_group", pk: ["id"] },
  { name: "modifier", pk: ["id"] },
  { name: "product_modifier_group", pk: ["product_id", "group_id"], replace: true },
  { name: "recipe_item", pk: ["product_id", "ingredient_id"], replace: true },
  { name: "contact", pk: ["id"] },
  { name: "role", pk: ["id"] },
  { name: "user", pk: ["id"] },
  { name: "auth_account", pk: ["id"] },
  { name: "user_branch", pk: ["user_id", "branch_id"], replace: true },
  // La tasa de los últimos tres meses (las sucursales no la consultan por su cuenta).
  { name: "exchange_rate", pk: ["id"], where: "effective_at >= ?" },
]

/** Los ajustes del negocio (los de cada equipo, como la impresora o Telegram, no bajan). */
export const MASTER_SETTING =
  /^(business\.|cash\.|credit\.|features$|fiscal\.|inventory\.|labels$|receipt\.|security\.)/

const RATES_DAYS = 90

export interface MasterSnapshot {
  /** Cuántas migraciones tiene la base: los dos servidores tienen que tener la misma versión. */
  schema: number
  /** Huella del contenido: si no cambió, la sucursal no vuelve a escribir nada. */
  version: string
  tables: Record<string, Row[]>
  settings: Row[]
}

export function schemaVersion(db: Db): number {
  return (
    (selectRows(db, "select count(*) as n from __drizzle_migrations")[0] as { n?: number })?.n ?? 0
  )
}

export function requireSameSchema(db: Db, other: number): void {
  const mine = schemaVersion(db)
  if (mine !== other) {
    throw new HttpError(
      409,
      "SYNC_VERSION",
      `El central y la sucursal tienen versiones distintas de la app (${mine} y ${other}): actualiza las dos a la misma`,
    )
  }
}

/** Todo lo que baja del central, con su huella. */
export function buildMasterSnapshot(db: Db, now: number): MasterSnapshot {
  const tables: Record<string, Row[]> = {}
  for (const t of MASTER_TABLES) {
    tables[t.name] = t.where
      ? selectRows(
          db,
          `select * from "${t.name}" where ${t.where} order by rowid`,
          now - RATES_DAYS * 86_400_000,
        )
      : selectRows(db, `select * from "${t.name}" order by rowid`)
  }
  // La última tasa, aunque sea vieja (sin ella no se vende en dos monedas).
  const latest = selectRows(db, "select * from exchange_rate order by effective_at desc limit 1")
  for (const r of latest) {
    if (!tables.exchange_rate?.some((x) => x.id === r.id)) tables.exchange_rate?.push(r)
  }
  const settings = selectRows(db, "select * from setting order by key").filter((s) =>
    MASTER_SETTING.test(String(s.key)),
  )
  const version = createHash("sha256").update(JSON.stringify({ tables, settings })).digest("hex")
  return { schema: schemaVersion(db), version, tables, settings }
}

/**
 * Deja la sucursal con lo que decide el central: actualiza o agrega cada fila, deja iguales las
 * tablas que se reemplazan y quita los ajustes del negocio que el central ya no tiene. Lo que
 * se registró en la sucursal (ventas, inventario, caja) no se toca.
 */
export function applyMasterSnapshot(db: Db, snapshot: MasterSnapshot): void {
  requireSameSchema(db, snapshot.schema)
  db.transaction(
    () => {
      // Primero se vacían las que se reemplazan (de la última a la primera, por sus referencias).
      for (const t of [...MASTER_TABLES].reverse()) {
        if (t.replace) db.$client.run(`delete from "${t.name}"`)
      }
      for (const t of MASTER_TABLES) {
        writeRows(db, t.name, snapshot.tables[t.name] ?? [], "upsert", t.pk, { retryUnique: true })
      }
      const keys = snapshot.settings.map((s) => String(s.key))
      const stale = selectRows(db, "select key from setting")
        .map((r) => String(r.key))
        .filter((k) => MASTER_SETTING.test(k) && !keys.includes(k))
      if (stale.length) {
        db.$client
          .prepare(`delete from setting where key in (${placeholders(stale.length)})`)
          .run(...stale)
      }
      writeRows(db, "setting", snapshot.settings, "upsert", ["key"])
    },
    { behavior: "immediate" },
  )
}
