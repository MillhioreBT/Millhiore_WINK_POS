import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Backup, BackupList } from "@millhiore/contracts"
import { createDb, migrateDb, seedCurrencies } from "@millhiore/db"
import { applyPendingRestore, backupDatabase, lastBackupAt, listBackups } from "../../infra/backups"
import { harness, setUp } from "../../testing/harness"

const dirs: string[] = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "millhiore-bk-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  Bun.gc(true) // en Windows un archivo SQLite queda bloqueado hasta que el GC suelta sus sentencias
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // mejor esfuerzo
    }
  }
})

describe("respaldos por HTTP", () => {
  test("listar, respaldar ahora, descargar y anotar/cancelar una restauración", async () => {
    const dataDir = tmp()
    const h = harness({ backups: { dataDir, keep: 5 } })
    const { owner } = await setUp(h)

    const empty = (await (await h.call("/api/backups", { cookie: owner })).json()) as BackupList
    expect(empty).toMatchObject({ backups: [], pendingRestore: null, keep: 5 })
    expect(empty.dir.endsWith("backups")).toBe(true)

    const created = await h.call("/api/backups", { cookie: owner, body: {} })
    expect(created.status).toBe(201)
    const backup = (await created.json()) as Backup
    expect(backup.label).toBe("manual")
    expect(backup.sizeBytes).toBeGreaterThan(0)

    const file = await h.call(`/api/backups/${backup.name}`, { cookie: owner })
    expect(file.status).toBe(200)
    expect(file.headers.get("content-disposition")).toContain(backup.name)
    expect(new TextDecoder().decode((await file.arrayBuffer()).slice(0, 15))).toBe(
      "SQLite format 3",
    )

    // Nombres que no son respaldos (o intentos de salir de la carpeta) no se sirven.
    for (const bad of ["..%2Fmillhiore.db", "notas.txt", "manual-x.db"]) {
      expect((await h.call(`/api/backups/${bad}`, { cookie: owner })).status).toBe(404)
    }

    const scheduled = await h.call(`/api/backups/${backup.name}/restore`, {
      cookie: owner,
      body: {},
    })
    expect(((await scheduled.json()) as BackupList).pendingRestore).toBe(backup.name)
    const cancelled = await h.call("/api/backups/restore", { method: "DELETE", cookie: owner })
    expect(((await cancelled.json()) as BackupList).pendingRestore).toBeNull()
  })

  test("un archivo ajeno no se acepta para restaurar; el cajero no ve respaldos", async () => {
    const dataDir = tmp()
    const h = harness({ backups: { dataDir, keep: 5 } })
    const { owner } = await setUp(h)
    const name = "manual-20261014T200000Z.db"
    const other = new Database(join(dataDir, "backups-tmp.db"))
    other.run("create table x (a)")
    other.close()
    const { mkdirSync, copyFileSync } = await import("node:fs")
    mkdirSync(join(dataDir, "backups"), { recursive: true })
    copyFileSync(join(dataDir, "backups-tmp.db"), join(dataDir, "backups", name))
    const res = await h.call(`/api/backups/${name}/restore`, { cookie: owner, body: {} })
    expect(res.status).toBe(422)

    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await h.call("/api/backups", { cookie: cashier })).status).toBe(403)
  })
})

describe("restauración al arrancar", () => {
  test("guarda la base actual como pre-restore y pone el respaldo en su lugar", () => {
    const dataDir = tmp()
    const dbFile = join(dataDir, "millhiore.db")
    const backupsDir = join(dataDir, "backups")

    // Base con monedas → respaldo; luego se le agrega una tabla que el respaldo no tiene.
    const live = createDb(dbFile)
    migrateDb(live)
    seedCurrencies(live)
    const backup = backupDatabase(live, backupsDir, "daily", Date.parse("2026-10-14T12:00:00Z"))
    live.$client.run("create table despues_del_respaldo (a)")
    live.$client.close()
    Bun.gc(true) // como al arrancar el servidor: nadie más tiene la base abierta

    const name = backup.split(/[\\/]/).pop() ?? ""
    writeFileSync(join(dataDir, "restore.pending"), name)
    const result = applyPendingRestore(dataDir, dbFile, Date.parse("2026-10-15T12:00:00Z"))
    expect(result).toMatchObject({ restored: name })
    expect(existsSync(join(dataDir, "restore.pending"))).toBe(false)

    const restored = new Database(dbFile, { readonly: true })
    const tables = restored
      .prepare("select name from sqlite_master where name = 'despues_del_respaldo'")
      .all()
    restored.close()
    expect(tables).toEqual([])
    expect(readdirSync(backupsDir).some((f) => f.startsWith("pre-restore-20261015T120000Z"))).toBe(
      true,
    )
    expect(listBackups(backupsDir).map((b) => b.label)).toEqual(["pre-restore", "daily"])
    expect(lastBackupAt(backupsDir, "daily")).toBe(Date.parse("2026-10-14T12:00:00Z"))

    // Sin nada anotado no hace nada.
    expect(applyPendingRestore(dataDir, dbFile, Date.now())).toBeNull()
  })

  test("si el respaldo anotado ya no existe, no toca la base y avisa", () => {
    const dataDir = tmp()
    writeFileSync(join(dataDir, "restore.pending"), "daily-20261014T120000Z.db")
    const result = applyPendingRestore(dataDir, join(dataDir, "millhiore.db"), Date.now())
    expect(result).toMatchObject({ error: expect.stringContaining("ya no existe") })
    expect(existsSync(join(dataDir, "restore.pending"))).toBe(false)
  })
})
