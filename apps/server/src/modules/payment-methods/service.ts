import type { PaymentMethodRow, UpdatePaymentMethodBody } from "@millhiore/contracts"
import { account, auditLog, type Db, paymentMethod, surcharge } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { asc, eq } from "drizzle-orm"
import { HttpError } from "../../http/errors"

function rows(db: Db): PaymentMethodRow[] {
  return db
    .select({
      id: paymentMethod.id,
      name: paymentMethod.name,
      accountId: paymentMethod.accountId,
      accountName: account.name,
      currency: account.currency,
      kind: account.kind,
      requiresReference: paymentMethod.requiresReference,
      surchargeName: surcharge.name,
      commissionBp: paymentMethod.commissionBp,
      active: paymentMethod.active,
    })
    .from(paymentMethod)
    .innerJoin(account, eq(account.id, paymentMethod.accountId))
    .leftJoin(surcharge, eq(surcharge.id, paymentMethod.surchargeId))
    .orderBy(asc(account.kind), asc(paymentMethod.name))
    .all()
}

/** Todos los métodos de pago, con la cuenta donde cae el dinero y su comisión. */
export const listPaymentMethods = rows

/**
 * Cambia la comisión, si pide referencia o si se ofrece. Lo ya cobrado no cambia: cada pago guarda
 * la comisión con que se contabilizó.
 */
export function updatePaymentMethod(
  db: Db,
  id: string,
  patch: UpdatePaymentMethodBody,
  actorId: string,
  now: number,
): PaymentMethodRow {
  const before = rows(db).find((m) => m.id === id)
  if (!before) throw new HttpError(404, "NOT_FOUND", `No existe el método de pago ${id}`)
  if (patch.active === true) {
    const owner = db.select().from(account).where(eq(account.id, before.accountId)).get()
    if (owner && !owner.active) {
      throw new HttpError(409, "ACCOUNT_INACTIVE", "Activa primero la cuenta de este método")
    }
  }
  const set = {
    ...(patch.requiresReference !== undefined
      ? { requiresReference: patch.requiresReference }
      : {}),
    ...(patch.commissionBp !== undefined ? { commissionBp: patch.commissionBp } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
  }
  if (Object.keys(set).length === 0) return before
  db.transaction(
    (tx) => {
      tx.update(paymentMethod).set(set).where(eq(paymentMethod.id, id)).run()
      tx.insert(auditLog)
        .values({
          id: uuidv7(now),
          at: now,
          actorId,
          action: "payment-method.updated",
          entityType: "payment_method",
          entityId: id,
          data: {
            name: before.name,
            before: {
              commissionBp: before.commissionBp,
              requiresReference: before.requiresReference,
              active: before.active,
            },
            patch,
          },
        })
        .run()
    },
    { behavior: "immediate" },
  )
  const after = rows(db).find((m) => m.id === id)
  if (!after) throw new HttpError(404, "NOT_FOUND", `No existe el método de pago ${id}`)
  return after
}
