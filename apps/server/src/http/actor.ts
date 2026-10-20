import { type Db, role, user } from "@millhiore/db"
import { isPermission, type Permission } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import type { Context } from "hono"
import type { Auth } from "../infra/auth"
import { forbidden, unauthorized } from "./errors"

export interface Actor {
  userId: string
  username: string | null
  name: string
  roleId: string | null
  permissions: ReadonlySet<Permission>
  /** Id de la sesión con la que llegó la petición (para no cerrarla al cambiar la contraseña). */
  sessionId: string
  mustChangePassword: boolean
  hasPin: boolean
}

export type AppEnv = { Variables: { actor: Actor } }

/** Sesión → usuario activo con los permisos de su rol. Nulo si no hay sesión válida. */
export async function resolveActor(auth: Auth, db: Db, headers: Headers): Promise<Actor | null> {
  const session = await auth.api.getSession({ headers })
  if (!session) return null
  const row = db.select().from(user).where(eq(user.id, session.user.id)).get()
  if (!row?.active) return null
  const r = row.roleId ? db.select().from(role).where(eq(role.id, row.roleId)).get() : undefined
  return {
    userId: row.id,
    username: row.username,
    name: row.name,
    roleId: row.roleId,
    permissions: new Set((r?.permissions ?? []).filter(isPermission)),
    sessionId: session.session.id,
    mustChangePassword: row.mustChangePassword,
    hasPin: row.pinHash !== null,
  }
}

export function actorOf(c: Context<AppEnv>): Actor {
  const actor = c.get("actor")
  if (!actor) throw unauthorized()
  return actor
}

/** Los permisos se verifican en el servidor, siempre. */
export function requirePermission(c: Context<AppEnv>, permission: Permission): Actor {
  const actor = actorOf(c)
  if (!actor.permissions.has(permission)) throw forbidden(permission)
  return actor
}
