import { beforeEach, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { createDb, type Db, migrateDb } from "./client"
import { account, auditLog, currency, document, documentTax } from "./schema"
import { seedCurrencies } from "./seed"

let db: Db

beforeEach(() => {
  db = createDb(":memory:")
  migrateDb(db)
  seedCurrencies(db)
})

const fail = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return String((e as Error).message)
  }
  return ""
}

describe("migraciones", () => {
  test("crean todas las tablas y las monedas base", () => {
    const tables = db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table'`,
    )
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["document", "stock_move", "account_move", "audit_log", "outbox"]),
    )
    expect(db.select().from(currency).all().length).toBe(4)
  })

  test("seedCurrencies es idempotente", () => {
    seedCurrencies(db)
    expect(db.select().from(currency).all().length).toBe(4)
  })

  test("las claves foráneas están activas", () => {
    const msg = fail(() =>
      db.insert(account).values({ id: "a", name: "Caja", kind: "cash", currency: "XXX" }).run(),
    )
    expect(msg).toMatch(/FOREIGN KEY/i)
  })

  test("los CHECK rechazan datos imposibles", () => {
    const msg = fail(() =>
      db.insert(currency).values({ code: "BAD", name: "x", symbol: "x", decimals: 99 }).run(),
    )
    expect(msg).toMatch(/CHECK/i)
  })
})

describe("inmutabilidad", () => {
  test("audit_log no admite UPDATE ni DELETE", () => {
    db.insert(auditLog)
      .values({ id: "1", at: 1, action: "x", entityType: "t", entityId: "e" })
      .run()
    expect(fail(() => db.update(auditLog).set({ action: "y" }).run())).toMatch(/inmutable/)
    expect(fail(() => db.delete(auditLog).run())).toMatch(/inmutable/)
  })

  test("las tablas de documentos y libros tienen sus triggers", () => {
    const triggers = db
      .all<{ name: string }>(sql`select name from sqlite_master where type = 'trigger'`)
      .map((t) => t.name)
    for (const table of [
      "document",
      "document_line",
      "document_tax",
      "document_surcharge",
      "payment",
      "stock_move",
      "account_move",
    ]) {
      expect(triggers).toContain(`${table}_no_update`)
      expect(triggers).toContain(`${table}_no_delete`)
    }
    expect(db.select().from(document).all()).toEqual([])
  })
})

describe("migración de impuestos (0004)", () => {
  test("conserva los documentos anteriores como un grupo no sujeto y no pierde triggers", () => {
    // Base con el esquema anterior a los impuestos: solo las primeras cuatro migraciones.
    const folder = mkdtempSync(join(tmpdir(), "millhiore-mig-"))
    try {
      const source = join(import.meta.dir, "..", "drizzle")
      cpSync(source, folder, { recursive: true })
      const journalPath = join(folder, "meta", "_journal.json")
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] }
      journal.entries = journal.entries.slice(0, 4)
      writeFileSync(journalPath, JSON.stringify(journal))

      const old = createDb(":memory:")
      migrate(old, { migrationsFolder: folder })
      seedCurrencies(old)
      old.run(sql`insert into business (id, name, reference_currency, legal_currency, created_at)
                  values ('b', 'Bodega', 'USD', 'VES', 1)`)
      old.run(
        sql`insert into location (id, business_id, name, kind) values ('l', 'b', 'Tienda', 'store')`,
      )
      old.run(
        sql`insert into terminal (id, location_id, code, name) values ('t', 'l', 'C1', 'Caja 1')`,
      )
      old.run(sql`insert into document (id, type, number, terminal_id, location_id, currency,
                    legal_currency, rate_base, rate_quote, rate_value, total_minor, total_legal_minor,
                    posted_at, created_at)
                  values ('d1', 'SALE', 'C1-000001', 't', 'l', 'USD', 'VES', 'USD', 'VES',
                    '36.50000000', 300, 10950, 1, 1),
                         ('d2', 'ADJUSTMENT', 'C1-AJ-000001', 't', 'l', 'USD', 'VES', 'USD', 'VES',
                    '36.50000000', 0, 0, 1, 1)`)

      migrateDb(old)
      const rows = old.select().from(documentTax).all()
      expect(rows).toEqual([
        expect.objectContaining({
          documentId: "d1",
          position: 1,
          taxId: null,
          kind: "not_subject",
          baseMinor: 300,
          taxMinor: 0,
          baseLegalMinor: 10950,
          taxLegalMinor: 0,
        }),
      ])
      expect(old.select().from(document).all()[0]).toMatchObject({
        pricesIncludeTax: false,
        surchargeMinor: 0,
      })
      const triggers = old
        .all<{ name: string }>(sql`select name from sqlite_master where type = 'trigger'`)
        .map((t) => t.name)
      expect(triggers).toEqual(
        expect.arrayContaining([
          "document_no_update",
          "document_line_no_delete",
          "payment_no_update",
        ]),
      )
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
