import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDb, currency, migrateDb, pendingMigrations, seedCurrencies } from "@millhiore/db"
import { backupDatabase, integrityCheck, rotateBackups } from "./backups"
import { defaultTrustedOrigins, loadConfig, resolveAuthSecret } from "./config"

const dirs: string[] = []
const open: { close(): void }[] = []
const openDb = (path: string) => {
  const db = createDb(path)
  open.push(db.$client)
  return db
}
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "millhiore-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const c of open.splice(0)) c.close()
  Bun.gc(true) // Bun finaliza las sentencias preparadas con el GC; en Windows el archivo sigue bloqueado hasta entonces
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // mejor esfuerzo: el sistema limpia la carpeta temporal
    }
  }
})

describe("config", () => {
  test("lee el entorno y aplica valores por defecto", () => {
    const dataDir = tmp()
    const cfg = loadConfig({ DATA_DIR: dataDir })
    expect(cfg).toMatchObject({
      port: 3000,
      baseURL: "http://localhost:3000",
      dataDir,
      backupsKeep: 14,
    })
    expect(cfg.trustedOrigins).toEqual(defaultTrustedOrigins(3000))
  })

  test("admite orígenes extra y rechaza un puerto inválido", () => {
    const dataDir = tmp()
    const cfg = loadConfig({
      DATA_DIR: dataDir,
      PORT: "4000",
      TRUSTED_ORIGINS: "https://caja.ts.net, http://tablet:4000",
    })
    expect(cfg.trustedOrigins.slice(-2)).toEqual(["https://caja.ts.net", "http://tablet:4000"])
    expect(() => loadConfig({ DATA_DIR: dataDir, PORT: "abc" })).toThrow(/PORT/)
    expect(() => loadConfig({ DATA_DIR: dataDir, PORT: "70000" })).toThrow(/PORT/)
  })

  test("el secreto se genera una vez y se reutiliza", () => {
    const dataDir = tmp()
    const first = resolveAuthSecret(dataDir, {})
    expect(first.length).toBeGreaterThanOrEqual(32)
    expect(resolveAuthSecret(dataDir, {})).toBe(first)
    expect(readFileSync(join(dataDir, "auth.secret"), "utf8")).toBe(first)
  })

  test("AUTH_SECRET del entorno tiene prioridad; uno corto se ignora", () => {
    const dataDir = tmp()
    const fromEnv = "x".repeat(40)
    expect(resolveAuthSecret(dataDir, { AUTH_SECRET: fromEnv })).toBe(fromEnv)
    expect(existsSync(join(dataDir, "auth.secret"))).toBe(false)
    expect(resolveAuthSecret(dataDir, { AUTH_SECRET: "corto" })).not.toBe("corto")
  })
})

describe("respaldos", () => {
  test("VACUUM INTO produce una copia completa y consistente", () => {
    const dir = tmp()
    const db = openDb(join(dir, "live.db"))
    migrateDb(db)
    seedCurrencies(db)

    const file = backupDatabase(
      db,
      join(dir, "backups"),
      "daily",
      Date.parse("2026-10-14T20:00:00Z"),
    )
    expect(file).toMatch(/daily-20261014T200000Z\.db$/)

    const copy = new Database(file, { readonly: true })
    expect((copy.query("select count(*) as n from currency").get() as { n: number }).n).toBe(
      db.select().from(currency).all().length,
    )
    expect(copy.query("pragma integrity_check").get()).toEqual({ integrity_check: "ok" })
    copy.close()
    expect(integrityCheck(db)).toBe("ok")
  })

  test("dos respaldos en el mismo segundo no fallan", () => {
    const dir = tmp()
    const db = openDb(join(dir, "live.db"))
    migrateDb(db)
    const at = Date.parse("2026-10-14T20:00:00Z")
    backupDatabase(db, join(dir, "b"), "daily", at)
    expect(() => backupDatabase(db, join(dir, "b"), "daily", at)).not.toThrow()
    expect(readdirSync(join(dir, "b"))).toHaveLength(1)
  })

  test("la rotación conserva los más recientes de cada tipo y no toca otros archivos", () => {
    const dir = tmp()
    for (const day of ["10", "11", "12", "13"])
      writeFileSync(join(dir, `daily-202610${day}T030000Z.db`), "x")
    writeFileSync(join(dir, "pre-migrate-20261001T000000Z.db"), "x")
    writeFileSync(join(dir, "notas.txt"), "x")

    const removed = rotateBackups(dir, 2)
    expect(removed.sort()).toEqual(["daily-20261010T030000Z.db", "daily-20261011T030000Z.db"])
    expect(readdirSync(dir).sort()).toEqual([
      "daily-20261012T030000Z.db",
      "daily-20261013T030000Z.db",
      "notas.txt",
      "pre-migrate-20261001T000000Z.db",
    ])
    expect(rotateBackups(join(dir, "no-existe"), 2)).toEqual([])
  })
})

describe("migraciones pendientes", () => {
  test("una base nueva las tiene todas pendientes y migrada ninguna", () => {
    const db = createDb(":memory:")
    expect(pendingMigrations(db)).toBeGreaterThan(0)
    migrateDb(db)
    expect(pendingMigrations(db)).toBe(0)
  })
})
