import type { SessionRow } from "@millhiore/contracts"
import { auditLog, type Db, session, user } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, desc, eq, gt, ne } from "drizzle-orm"
import type { Actor } from "../../http/actor"
import { HttpError } from "../../http/errors"

function audit(
  db: Pick<Db, "insert">,
  actorId: string,
  action: string,
  sessionId: string,
  data: unknown,
) {
  const now = Date.now()
  db.insert(auditLog)
    .values({
      id: uuidv7(now),
      at: now,
      actorId,
      action,
      entityType: "session",
      entityId: sessionId,
      data, // nunca el token
    })
    .run()
}

/** Las sesiones vigentes: las propias, o las de todos si se pide y se puede administrar usuarios. */
export function listSessions(
  db: Db,
  actor: Actor,
  opts: { all: boolean; now: number },
): SessionRow[] {
  if (opts.all && !actor.permissions.has("user.manage")) {
    throw new HttpError(403, "FORBIDDEN", "Falta el permiso user.manage")
  }
  const mine = eq(session.userId, actor.userId)
  return db
    .select({
      id: session.id,
      userId: session.userId,
      userName: user.name,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(and(gt(session.expiresAt, new Date(opts.now)), opts.all ? undefined : mine))
    .orderBy(desc(session.updatedAt))
    .all()
    .map((s) => ({
      id: s.id,
      userId: s.userId,
      userName: s.userName,
      createdAt: s.createdAt.getTime(),
      lastSeenAt: s.updatedAt.getTime(),
      expiresAt: s.expiresAt.getTime(),
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      current: s.id === actor.sessionId,
    }))
}

/** Cierra una sesión ajena a la actual: la propia con su dueño, cualquiera con `user.manage`. */
export function revokeSession(db: Db, actor: Actor, id: string): void {
  if (id === actor.sessionId) {
    throw new HttpError(409, "CURRENT_SESSION", "Esa es la sesión actual: usa «Cerrar sesión»")
  }
  const row = db.select().from(session).where(eq(session.id, id)).get()
  if (!row) throw new HttpError(404, "NOT_FOUND", "Esa sesión ya no existe")
  if (row.userId !== actor.userId && !actor.permissions.has("user.manage")) {
    throw new HttpError(403, "FORBIDDEN", "Falta el permiso user.manage")
  }
  db.transaction((tx) => {
    tx.delete(session).where(eq(session.id, id)).run()
    audit(tx, actor.userId, "session.revoked", id, { userId: row.userId })
  })
}

/** Cierra todas las sesiones propias menos la actual. Devuelve cuántas cerró. */
export function revokeOtherSessions(db: Db, actor: Actor): number {
  return db.transaction((tx) => {
    const others = tx
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.userId, actor.userId), ne(session.id, actor.sessionId)))
      .all()
    if (others.length === 0) return 0
    tx.delete(session)
      .where(and(eq(session.userId, actor.userId), ne(session.id, actor.sessionId)))
      .run()
    audit(tx, actor.userId, "session.revoked.others", actor.sessionId, { count: others.length })
    return others.length
  })
}
