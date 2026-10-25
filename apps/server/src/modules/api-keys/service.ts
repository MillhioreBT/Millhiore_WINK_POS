import { createHash, randomBytes } from "node:crypto"
import type { ApiKey, CreateApiKeyBody, CreatedApiKey } from "@millhiore/contracts"
import { apiKey, auditLog, type Db, role, user } from "@millhiore/db"
import { API_KEY_PERMISSIONS, isPermission, uuidv7 } from "@millhiore/domain"
import { desc, eq } from "drizzle-orm"
import type { Actor } from "../../http/actor"
import { HttpError } from "../../http/errors"
import { branchScope } from "../branches/service"

/** Todas las claves empiezan así: se reconocen en un registro o en un repositorio público. */
export const API_KEY_PREFIX = "mwk_"

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex")

/** No se escribe en cada petición: basta con saber que se usó en el último minuto. */
const LAST_USED_EVERY_MS = 60_000

function toApiKey(row: typeof apiKey.$inferSelect, userName: string): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    permissions: row.permissions.filter((p) =>
      (API_KEY_PERMISSIONS as readonly string[]).includes(p),
    ) as ApiKey["permissions"],
    userId: row.userId,
    userName,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  }
}

/** Las claves, las vigentes primero y las más nuevas arriba. */
export function listApiKeys(db: Db): ApiKey[] {
  return db
    .select({ key: apiKey, userName: user.name })
    .from(apiKey)
    .innerJoin(user, eq(user.id, apiKey.userId))
    .orderBy(desc(apiKey.createdAt), desc(apiKey.id))
    .all()
    .map((r) => toApiKey(r.key, r.userName))
    .sort((a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null))
}

/**
 * Crea una clave que actúa como quien la crea. No puede tener permisos que esa persona no tiene.
 * El secreto se devuelve una sola vez; se guarda su hash.
 */
export function createApiKey(
  db: Db,
  input: CreateApiKeyBody,
  actor: Actor,
  now: number,
): CreatedApiKey {
  const permissions = [...new Set(input.permissions)]
  const missing = permissions.filter((p) => !actor.permissions.has(p))
  if (missing.length) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `No puedes dar a una clave permisos que no tienes: ${missing.join(", ")}`,
    )
  }
  const secret = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`
  const row = {
    id: uuidv7(now),
    name: input.name,
    prefix: secret.slice(0, API_KEY_PREFIX.length + 8),
    secretHash: hash(secret),
    permissions,
    userId: actor.userId,
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  }
  db.transaction(
    (tx) => {
      tx.insert(apiKey).values(row).run()
      const { secretHash: _, ...data } = row
      tx.insert(auditLog)
        .values({
          id: uuidv7(now),
          at: now,
          actorId: actor.userId,
          action: "api_key.created",
          entityType: "api_key",
          entityId: row.id,
          data,
        })
        .run()
    },
    { behavior: "immediate" },
  )
  return { key: toApiKey(row, actor.name), secret }
}

/** Revoca una clave: deja de funcionar al instante y para siempre. */
export function revokeApiKey(db: Db, id: string, actorId: string, now: number): ApiKey {
  return db.transaction(
    (tx) => {
      const found = tx
        .select({ key: apiKey, userName: user.name })
        .from(apiKey)
        .innerJoin(user, eq(user.id, apiKey.userId))
        .where(eq(apiKey.id, id))
        .get()
      if (!found) throw new HttpError(404, "NOT_FOUND", "No existe esa clave")
      if (found.key.revokedAt !== null) return toApiKey(found.key, found.userName)
      tx.update(apiKey).set({ revokedAt: now }).where(eq(apiKey.id, id)).run()
      tx.insert(auditLog)
        .values({
          id: uuidv7(now),
          at: now,
          actorId,
          action: "api_key.revoked",
          entityType: "api_key",
          entityId: id,
          data: { name: found.key.name, prefix: found.key.prefix },
        })
        .run()
      return toApiKey({ ...found.key, revokedAt: now }, found.userName)
    },
    { behavior: "immediate" },
  )
}

/**
 * La clave de un `Authorization: Bearer mwk_…` → quien la creó, con los permisos de la clave que
 * esa persona todavía tiene. Nulo si la clave no existe, está revocada o su usuario está inactivo.
 */
export function resolveApiKeyActor(db: Db, secret: string, now: number): Actor | null {
  if (!secret.startsWith(API_KEY_PREFIX)) return null
  const row = db
    .select()
    .from(apiKey)
    .where(eq(apiKey.secretHash, hash(secret)))
    .get()
  if (!row || row.revokedAt !== null) return null
  const owner = db.select().from(user).where(eq(user.id, row.userId)).get()
  if (!owner?.active) return null
  const r = owner.roleId ? db.select().from(role).where(eq(role.id, owner.roleId)).get() : undefined
  const allowed = new Set((r?.permissions ?? []).filter(isPermission))
  if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_EVERY_MS) {
    db.update(apiKey).set({ lastUsedAt: now }).where(eq(apiKey.id, row.id)).run()
  }
  return {
    userId: owner.id,
    username: owner.username,
    name: owner.name,
    roleId: owner.roleId,
    permissions: new Set(row.permissions.filter((p) => allowed.has(p))),
    sessionId: `api-key:${row.id}`,
    mustChangePassword: false,
    hasPin: false,
    apiKeyId: row.id,
    branchIds: branchScope(db, owner.id),
  }
}
