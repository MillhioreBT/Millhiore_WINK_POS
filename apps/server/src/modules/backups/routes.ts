import { join, resolve } from "node:path"
import { createRoute, z } from "@hono/zod-openapi"
import { apiErrorSchema, backupListSchema, backupSchema } from "@millhiore/contracts"
import { requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import {
  backupDatabase,
  cancelRestore,
  checkBackupFile,
  isBackupName,
  listBackups,
  pendingRestore,
  rotateBackups,
  scheduleRestore,
} from "../../infra/backups"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })
const nameParam = z.object({ name: z.string().min(1) })

const listRoute = createRoute({
  method: "get",
  path: "/api/backups",
  tags: ["Respaldos"],
  summary: "Respaldos guardados en el equipo y restauración pendiente",
  responses: {
    200: { description: "Respaldos", content: json(backupListSchema) },
    403: { description: "Falta settings.manage", ...err },
  },
})

const createBackupRoute = createRoute({
  method: "post",
  path: "/api/backups",
  tags: ["Respaldos"],
  summary: "Respalda la base ahora mismo",
  responses: {
    201: { description: "Respaldo creado", content: json(backupSchema) },
    403: { description: "Falta settings.manage", ...err },
  },
})

const downloadRoute = createRoute({
  method: "get",
  path: "/api/backups/{name}",
  tags: ["Respaldos"],
  summary: "Descarga un respaldo (archivo SQLite)",
  request: { params: nameParam },
  responses: {
    200: { description: "Archivo", content: { "application/vnd.sqlite3": { schema: z.any() } } },
    403: { description: "Falta settings.manage", ...err },
    404: { description: "No existe", ...err },
  },
})

const restoreRoute = createRoute({
  method: "post",
  path: "/api/backups/{name}/restore",
  tags: ["Respaldos"],
  summary: "Deja anotado restaurar un respaldo al reiniciar el programa",
  description:
    "Antes de restaurar se guarda la base actual como respaldo «pre-restore», así que también se puede deshacer.",
  request: { params: nameParam },
  responses: {
    200: { description: "Anotado", content: json(backupListSchema) },
    403: { description: "Falta settings.manage", ...err },
    404: { description: "No existe", ...err },
    422: { description: "Respaldo dañado o ajeno", ...err },
  },
})

const cancelRoute = createRoute({
  method: "delete",
  path: "/api/backups/restore",
  tags: ["Respaldos"],
  summary: "Cancela la restauración pendiente",
  responses: {
    200: { description: "Cancelada", content: json(backupListSchema) },
    403: { description: "Falta settings.manage", ...err },
  },
})

export function registerBackupRoutes(app: App, deps: AppDeps): void {
  const config = () => {
    if (!deps.backups) throw new HttpError(404, "NO_BACKUPS", "Los respaldos no están disponibles")
    return { ...deps.backups, dir: join(deps.backups.dataDir, "backups") }
  }
  const state = () => {
    const { dir, dataDir, keep } = config()
    return {
      backups: listBackups(dir),
      pendingRestore: pendingRestore(dataDir),
      keep,
      dir: resolve(dir),
    }
  }
  const existing = (name: string) => {
    const { dir } = config()
    const found = isBackupName(name) ? listBackups(dir).find((b) => b.name === name) : undefined
    if (!found) throw new HttpError(404, "NOT_FOUND", "No existe ese respaldo")
    return { ...found, file: join(dir, name) }
  }

  app.openapi(listRoute, (c) => {
    requirePermission(c, "settings.manage")
    return c.json(state(), 200)
  })

  app.openapi(createBackupRoute, (c) => {
    requirePermission(c, "settings.manage")
    const { dir, keep } = config()
    const file = backupDatabase(deps.db, dir, "manual", deps.now())
    rotateBackups(dir, keep)
    const created = listBackups(dir).find((b) => file.endsWith(b.name))
    if (!created) throw new HttpError(500, "BACKUP_FAILED", "No se pudo crear el respaldo")
    return c.json(created, 201)
  })

  // Se registra antes que la descarga para que "restore" no se lea como un nombre de archivo.
  app.openapi(cancelRoute, (c) => {
    requirePermission(c, "settings.manage")
    cancelRestore(config().dataDir)
    return c.json(state(), 200)
  })

  app.openapi(downloadRoute, (c) => {
    requirePermission(c, "settings.manage")
    const b = existing(c.req.valid("param").name)
    return new Response(Bun.file(b.file), {
      headers: {
        "content-type": "application/vnd.sqlite3",
        "content-disposition": `attachment; filename="millhiore-${b.name}"`,
        "cache-control": "no-store",
      },
    }) as never
  })

  app.openapi(restoreRoute, (c) => {
    requirePermission(c, "settings.manage")
    const b = existing(c.req.valid("param").name)
    const problem = checkBackupFile(b.file)
    if (problem !== "ok") throw new HttpError(422, "BAD_BACKUP", problem)
    scheduleRestore(config().dataDir, b.name)
    return c.json(state(), 200)
  })
}
