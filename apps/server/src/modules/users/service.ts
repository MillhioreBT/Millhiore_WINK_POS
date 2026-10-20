import type { ChangePasswordBody, UpdateUserBody, UserRow } from "@millhiore/contracts"
import { auditLog, authAccount, business, type Db, role, session, user } from "@millhiore/db"
import { passwordProblem, uuidv7 } from "@millhiore/domain"
import { and, eq, ne } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { type Auth, hashPassword, syntheticEmail, verifyPassword } from "../../infra/auth"

export interface NewUser {
  name: string
  username: string
  password: string
  roleId: string
}

/** El rol de fábrica con todos los permisos. Solo otro dueño puede tocar la cuenta de un dueño. */
export const OWNER_ROLE = "owner"

function businessName(db: Db): string | null {
  return db.select({ name: business.name }).from(business).get()?.name ?? null
}

/** Las reglas de contraseñas del dominio, con el contexto de la persona y el negocio. */
export function checkPassword(
  db: Db,
  password: string,
  who: { username: string | null; name: string },
): void {
  const problem = passwordProblem(password, { ...who, businessName: businessName(db) })
  if (problem) throw new HttpError(422, "WEAK_PASSWORD", problem)
}

function audit(db: Pick<Db, "insert">, actorId: string | null, action: string, userId: string) {
  const now = Date.now()
  db.insert(auditLog)
    .values({
      id: uuidv7(now),
      at: now,
      actorId,
      action,
      entityType: "user",
      entityId: userId,
      data: {}, // nunca la contraseña
    })
    .run()
}

/**
 * Crea un usuario con su rol. El registro público de Better Auth está cerrado, así que esta es
 * la única vía. Devuelve el id del usuario.
 */
export async function createUserAccount(auth: Auth, db: Db, input: NewUser): Promise<string> {
  if (!db.select().from(role).where(eq(role.id, input.roleId)).get()) {
    throw new HttpError(422, "UNKNOWN_ROLE", `Rol desconocido: ${input.roleId}`)
  }
  if (db.select().from(user).where(eq(user.username, input.username)).get()) {
    throw new HttpError(409, "USERNAME_TAKEN", `El usuario ${input.username} ya existe`)
  }
  checkPassword(db, input.password, input)
  const created = await auth.api.signUpEmail({
    body: {
      name: input.name,
      email: syntheticEmail(input.username),
      password: input.password,
      username: input.username,
    },
  })
  db.update(user).set({ roleId: input.roleId }).where(eq(user.id, created.user.id)).run()
  return created.user.id
}

export function listUsers(db: Db): UserRow[] {
  return db
    .select({
      id: user.id,
      username: user.username,
      name: user.name,
      roleId: user.roleId,
      active: user.active,
      mustChangePassword: user.mustChangePassword,
    })
    .from(user)
    .all()
}

function findUser(db: Db, id: string) {
  const row = db.select().from(user).where(eq(user.id, id)).get()
  if (!row) throw new HttpError(404, "NOT_FOUND", "No existe ese usuario")
  return row
}

/** Dueños activos que quedarían si `exceptId` dejara de serlo. */
function otherActiveOwners(db: Db, exceptId: string): number {
  return db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.roleId, OWNER_ROLE), eq(user.active, true), ne(user.id, exceptId)))
    .all().length
}

/**
 * Guarda el hash de la contraseña y cierra sesiones: `all` (restablecer), `others` (todas menos
 * `keepSessionId`) o `none`. Sirve para el cambio propio, el restablecimiento del dueño y la
 * recuperación por consola.
 */
export async function setPassword(
  db: Db,
  userId: string,
  password: string,
  opts:
    | { mustChange: boolean; signOut: "all" | "none" }
    | {
        mustChange: boolean
        signOut: "others"
        keepSessionId: string
      },
): Promise<void> {
  const hash = await hashPassword(password)
  const now = new Date()
  db.transaction(
    (tx) => {
      const credential = and(
        eq(authAccount.userId, userId),
        eq(authAccount.providerId, "credential"),
      )
      if (!tx.select({ id: authAccount.id }).from(authAccount).where(credential).get()) {
        throw new HttpError(409, "NO_PASSWORD", "Ese usuario no entra con contraseña")
      }
      tx.update(authAccount).set({ password: hash, updatedAt: now }).where(credential).run()
      tx.update(user)
        .set({
          mustChangePassword: opts.mustChange,
          updatedAt: now,
          // Una contraseña restablecida (por el dueño o desde la consola) es una recuperación de
          // la cuenta: el PIN anterior ya no vale y la persona pone uno nuevo.
          ...(opts.signOut === "all" ? { pinHash: null } : {}),
        })
        .where(eq(user.id, userId))
        .run()
      if (opts.signOut === "all") tx.delete(session).where(eq(session.userId, userId)).run()
      if (opts.signOut === "others") {
        tx.delete(session)
          .where(and(eq(session.userId, userId), ne(session.id, opts.keepSessionId)))
          .run()
      }
    },
    { behavior: "immediate" },
  )
}

// Intentos fallidos de cambiar la propia contraseña, por usuario: frena a quien adivina la actual
// desde una sesión ajena abierta.
const failures = new Map<string, number[]>()
const WINDOW_MS = 15 * 60_000
const MAX_FAILURES = 5

/** Cambio de la propia contraseña: exige la actual. Mantiene abierta la sesión desde la que se pide. */
export async function changeOwnPassword(
  db: Db,
  actor: { userId: string; sessionId: string },
  input: ChangePasswordBody,
  now: number,
): Promise<void> {
  const recent = (failures.get(actor.userId) ?? []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= MAX_FAILURES) {
    throw new HttpError(429, "TOO_MANY_ATTEMPTS", "Demasiados intentos. Espera 15 minutos")
  }
  const me = findUser(db, actor.userId)
  const account = db
    .select({ password: authAccount.password })
    .from(authAccount)
    .where(and(eq(authAccount.userId, me.id), eq(authAccount.providerId, "credential")))
    .get()
  if (!account?.password || !(await verifyPassword(input.currentPassword, account.password))) {
    failures.set(actor.userId, [...recent, now])
    throw new HttpError(422, "WRONG_PASSWORD", "La contraseña actual no es correcta")
  }
  failures.delete(actor.userId)
  if (input.newPassword === input.currentPassword) {
    throw new HttpError(422, "SAME_PASSWORD", "La nueva debe ser distinta de la actual")
  }
  checkPassword(db, input.newPassword, me)
  await setPassword(
    db,
    me.id,
    input.newPassword,
    input.signOutOthers
      ? { mustChange: false, signOut: "others", keepSessionId: actor.sessionId }
      : { mustChange: false, signOut: "none" },
  )
  audit(db, me.id, "user.password.changed", me.id)
}

/**
 * El dueño (user.manage) pone una contraseña temporal a otra persona: se cierran todas sus
 * sesiones y al entrar debe elegir la suya.
 */
export async function resetUserPassword(
  db: Db,
  actor: { userId: string; roleId: string | null },
  targetId: string,
  temporaryPassword: string,
): Promise<void> {
  if (targetId === actor.userId) {
    throw new HttpError(409, "OWN_ACCOUNT", "Para tu propia contraseña usa «Mi cuenta»")
  }
  const target = findUser(db, targetId)
  if (target.roleId === OWNER_ROLE && actor.roleId !== OWNER_ROLE) {
    throw new HttpError(403, "OWNER_ONLY", "Solo otro dueño puede restablecer la de un dueño")
  }
  checkPassword(db, temporaryPassword, target)
  await setPassword(db, targetId, temporaryPassword, { mustChange: true, signOut: "all" })
  audit(db, actor.userId, "user.password.reset", targetId)
}

/** Cambia nombre, rol o estado. Nunca deja el negocio sin un dueño activo. */
export function updateUser(
  db: Db,
  actor: { userId: string; roleId: string | null },
  targetId: string,
  patch: UpdateUserBody,
): UserRow {
  const target = findUser(db, targetId)
  if (target.roleId === OWNER_ROLE && actor.roleId !== OWNER_ROLE) {
    throw new HttpError(403, "OWNER_ONLY", "Solo otro dueño puede modificar a un dueño")
  }
  if (patch.roleId === OWNER_ROLE && actor.roleId !== OWNER_ROLE) {
    throw new HttpError(403, "OWNER_ONLY", "Solo un dueño puede nombrar a otro dueño")
  }
  if (
    patch.roleId !== undefined &&
    !db.select().from(role).where(eq(role.id, patch.roleId)).get()
  ) {
    throw new HttpError(422, "UNKNOWN_ROLE", `Rol desconocido: ${patch.roleId}`)
  }
  if (patch.active === false && targetId === actor.userId) {
    throw new HttpError(409, "OWN_ACCOUNT", "No puedes desactivar tu propia cuenta")
  }
  const losesOwner =
    target.roleId === OWNER_ROLE &&
    target.active &&
    (patch.active === false || (patch.roleId !== undefined && patch.roleId !== OWNER_ROLE))
  if (losesOwner && otherActiveOwners(db, targetId) === 0) {
    throw new HttpError(409, "LAST_OWNER", "El negocio necesita al menos un dueño activo")
  }
  const set = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.roleId !== undefined ? { roleId: patch.roleId } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
  }
  if (Object.keys(set).length) {
    db.update(user)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(user.id, targetId))
      .run()
    // Desactivar cierra sus sesiones al instante (además, cada petición revisa que siga activo).
    if (patch.active === false) db.delete(session).where(eq(session.userId, targetId)).run()
    audit(db, actor.userId, "user.updated", targetId)
  }
  const row = listUsers(db).find((u) => u.id === targetId)
  if (!row) throw new HttpError(404, "NOT_FOUND", "No existe ese usuario")
  return row
}
