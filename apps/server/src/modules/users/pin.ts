import type { SetPinBody } from "@millhiore/contracts"
import { auditLog, authAccount, type Db, user } from "@millhiore/db"
import { pinProblem, uuidv7 } from "@millhiore/domain"
import { and, eq } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { hashPassword, verifyPassword } from "../../infra/auth"

// Intentos fallidos por usuario. Un PIN tiene pocas combinaciones: tras cinco errores se frena
// la comprobación unos minutos (y quien insista debe entrar con su contraseña). Es en memoria:
// reiniciar el servidor las borra, igual que con el cambio de contraseña.
const failures = new Map<string, number[]>()
const PIN_WINDOW_MS = 5 * 60_000
const PIN_MAX_FAILURES = 5
const PASSWORD_WINDOW_MS = 15 * 60_000

function recent(key: string, now: number, windowMs: number): number[] {
  return (failures.get(key) ?? []).filter((t) => now - t < windowMs)
}

function audit(db: Db, userId: string, action: string, now: number) {
  db.insert(auditLog)
    .values({
      id: uuidv7(now),
      at: now,
      actorId: userId,
      action,
      entityType: "user",
      entityId: userId,
      data: {}, // nunca el PIN
    })
    .run()
}

/** Pone, cambia o quita (pin = null) el PIN propio. Exige la contraseña actual. */
export async function setOwnPin(
  db: Db,
  userId: string,
  input: SetPinBody,
  now: number,
): Promise<void> {
  const key = `password:${userId}`
  if (recent(key, now, PASSWORD_WINDOW_MS).length >= PIN_MAX_FAILURES) {
    throw new HttpError(429, "TOO_MANY_ATTEMPTS", "Demasiados intentos. Espera 15 minutos")
  }
  const account = db
    .select({ password: authAccount.password })
    .from(authAccount)
    .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, "credential")))
    .get()
  if (!account?.password || !(await verifyPassword(input.currentPassword, account.password))) {
    failures.set(key, [...recent(key, now, PASSWORD_WINDOW_MS), now])
    throw new HttpError(422, "WRONG_PASSWORD", "La contraseña no es correcta")
  }
  failures.delete(key)

  if (input.pin === null) {
    db.update(user).set({ pinHash: null }).where(eq(user.id, userId)).run()
    failures.delete(`pin:${userId}`)
    audit(db, userId, "user.pin.removed", now)
    return
  }
  const problem = pinProblem(input.pin)
  if (problem) throw new HttpError(422, "WEAK_PIN", problem)
  const hash = await hashPassword(input.pin)
  db.update(user).set({ pinHash: hash }).where(eq(user.id, userId)).run()
  failures.delete(`pin:${userId}`)
  audit(db, userId, "user.pin.set", now)
}

/** Comprueba el PIN propio: desbloquear la pantalla. No abre ni cambia ninguna sesión. */
export async function verifyOwnPin(
  db: Db,
  userId: string,
  pin: string,
  now: number,
): Promise<void> {
  const key = `pin:${userId}`
  const past = recent(key, now, PIN_WINDOW_MS)
  if (past.length >= PIN_MAX_FAILURES) {
    const wait = Math.ceil((PIN_WINDOW_MS - (now - (past[0] ?? now))) / 60_000)
    throw new HttpError(
      429,
      "PIN_LOCKED",
      `Demasiados intentos. Espera ${wait} minuto${wait === 1 ? "" : "s"} o sal e ingresa con tu contraseña`,
    )
  }
  const row = db.select({ pinHash: user.pinHash }).from(user).where(eq(user.id, userId)).get()
  if (!row?.pinHash) throw new HttpError(409, "NO_PIN", "No tienes un PIN: usa tu contraseña")
  if (!(await verifyPassword(pin, row.pinHash))) {
    failures.set(key, [...past, now])
    throw new HttpError(401, "WRONG_PIN", "PIN incorrecto")
  }
  failures.delete(key)
}
