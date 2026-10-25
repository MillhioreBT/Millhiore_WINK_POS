import { type Db, role, user } from "@millhiore/db"
import { isPermission, type Permission } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import type { Context } from "hono"
import type { Auth } from "../infra/auth"
import { type BranchScope, branchScope } from "../modules/branches/service"
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
  /** Llegó con una clave de la API (`Authorization: Bearer mwk_…`), no con una sesión. */
  apiKeyId?: string | undefined
  /**
   * Llega de un plugin: de su código (con su clave interna) o de su pantalla (con la sesión de
   * quien la usa). Puede lo que el plugin pide y la persona tiene, nunca más.
   */
  pluginId?: string | undefined
  /** Sucursales donde trabaja; null, en todas (o las sucursales están apagadas). */
  branchIds: BranchScope
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
    branchIds: branchScope(db, row.id),
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
