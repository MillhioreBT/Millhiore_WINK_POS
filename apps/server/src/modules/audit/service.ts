import type { AuditEntry } from "@millhiore/contracts"
import { auditLog, type Db, user } from "@millhiore/db"
import { and, desc, eq, gte, lt, sql } from "drizzle-orm"

export interface AuditFilter {
  from?: number | undefined
  to?: number | undefined
  /** Prefijo de la clave de la acción (`user.` trae todo lo de usuarios). */
  action?: string | undefined
  actorId?: string | undefined
  limit: number
}

const ESCAPE = "!"

/** Los comodines de LIKE (`%`, `_`) y el propio carácter de escape pasan como texto literal. */
function escapeLike(text: string): string {
  return text.replace(/[!%_]/g, (c) => ESCAPE + c)
}

/** Lo más reciente primero, con el nombre de quien lo hizo. La bitácora nunca se edita ni se borra. */
export function listAudit(db: Db, filter: AuditFilter): AuditEntry[] {
  const where = and(
    filter.from === undefined ? undefined : gte(auditLog.at, filter.from),
    filter.to === undefined ? undefined : lt(auditLog.at, filter.to),
    filter.action
      ? sql`${auditLog.action} like ${`${escapeLike(filter.action)}%`} escape ${ESCAPE}`
      : undefined,
    filter.actorId ? eq(auditLog.actorId, filter.actorId) : undefined,
  )
  return db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      action: auditLog.action,
      actorId: auditLog.actorId,
      actorName: user.name,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      data: auditLog.data,
    })
    .from(auditLog)
    .leftJoin(user, eq(user.id, auditLog.actorId))
    .where(where)
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(filter.limit)
    .all()
}
