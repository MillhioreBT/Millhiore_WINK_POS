import { type Db, plugin, role, user } from "@millhiore/db"
import { isPermission, type Permission } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import type { Actor } from "../../http/actor"
import { branchScope } from "../branches/service"
import type { PluginManager } from "./manager"

/** Lo que pide el plugin encendido; null si no existe o está apagado. */
function grantedBy(db: Pick<Db, "select">, pluginId: string): ReadonlySet<string> | null {
  const row = db.select().from(plugin).where(eq(plugin.id, pluginId)).get()
  return row?.enabled ? new Set(row.manifest.permissions) : null
}

/**
 * El código del plugin llamando a la API con su clave interna: actúa como quien lo instaló, con
 * los permisos que esa persona todavía tiene y que el plugin pidió.
 */
export function pluginTokenActor(
  db: Db,
  plugins: PluginManager | undefined,
  token: string,
): Actor | null {
  const pluginId = plugins?.pluginForToken(token)
  if (!pluginId) return null
  const row = db.select().from(plugin).where(eq(plugin.id, pluginId)).get()
  if (!row?.enabled) return null
  const owner = db.select().from(user).where(eq(user.id, row.installedBy)).get()
  if (!owner?.active) return null
  const r = owner.roleId ? db.select().from(role).where(eq(role.id, owner.roleId)).get() : undefined
  const has = new Set((r?.permissions ?? []).filter(isPermission))
  return {
    userId: owner.id,
    username: owner.username,
    name: owner.name,
    roleId: owner.roleId,
    permissions: new Set(
      row.manifest.permissions.filter((p): p is Permission => isPermission(p) && has.has(p)),
    ),
    sessionId: `plugin:${row.id}`,
    mustChangePassword: false,
    hasPin: false,
    pluginId: row.id,
    branchIds: branchScope(db, owner.id),
  }
}

/** La pantalla del plugin, con la sesión de quien la usa: lo que ambos pueden. */
export function pluginBridgeActor(
  db: Pick<Db, "select">,
  base: Actor,
  pluginId: string,
): Actor | null {
  const granted = grantedBy(db, pluginId)
  if (!granted) return null
  return {
    ...base,
    permissions: new Set([...base.permissions].filter((p) => granted.has(p))),
    pluginId,
  }
}
