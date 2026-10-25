import type { SetupBody } from "@millhiore/contracts"
import {
  account,
  branch,
  business,
  currency,
  type Db,
  DEFAULT_TAX_ID,
  exchangeRate,
  IGTF_SURCHARGE,
  location,
  paymentMethod,
  seedCurrencies,
  seedRoles,
  seedTaxes,
  terminal,
  user,
} from "@millhiore/db"
import { exchangeRate as makeRate, passwordProblem, uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import type { Auth } from "../../infra/auth"
import { MAIN_BRANCH_ID } from "../branches/service"
import { writeBusinessProfile, writeFiscalSettings } from "../settings/service"
import { createUserAccount } from "../users/service"

export function isConfigured(db: Db): boolean {
  return db.select({ id: business.id }).from(business).get() !== undefined
}

/** Cuentas y métodos de cobro con los que arranca una bodega venezolana típica. */
function defaultMoneyAccounts(referenceCurrency: string, legalCurrency: string) {
  return [
    {
      key: "cash-ref",
      name: `Efectivo ${referenceCurrency}`,
      kind: "cash",
      currency: referenceCurrency,
      ref: false,
    },
    {
      key: "cash-legal",
      name: `Efectivo ${legalCurrency}`,
      kind: "cash",
      currency: legalCurrency,
      ref: false,
    },
    { key: "mobile", name: "Pago móvil", kind: "mobile", currency: legalCurrency, ref: true },
    { key: "card", name: "Punto de venta", kind: "bank", currency: legalCurrency, ref: true },
    { key: "zelle", name: "Zelle", kind: "wallet", currency: referenceCurrency, ref: true },
  ] as const
}

/**
 * Asistente inicial: crea negocio, local, caja, cuentas, métodos de pago, roles, dueño y,
 * opcionalmente, la primera tasa. Solo corre sobre una base vacía.
 */
export async function runSetup(
  auth: Auth,
  db: Db,
  input: SetupBody,
  now: number,
): Promise<{ businessId: string; ownerId: string }> {
  if (isConfigured(db))
    throw new HttpError(409, "ALREADY_CONFIGURED", "El negocio ya está configurado")
  if (input.referenceCurrency === input.legalCurrency) {
    throw new HttpError(
      422,
      "INVALID_CURRENCIES",
      "La moneda de referencia y la legal deben ser distintas",
    )
  }

  seedCurrencies(db)
  seedTaxes(db)
  seedRoles(db)
  for (const code of [input.referenceCurrency, input.legalCurrency]) {
    if (!db.select().from(currency).where(eq(currency.code, code)).get()) {
      throw new HttpError(422, "UNKNOWN_CURRENCY", `Moneda no soportada: ${code}`)
    }
  }

  // El negocio aún no existe: su nombre se revisa aquí.
  const weak = passwordProblem(input.owner.password, {
    ...input.owner,
    businessName: input.business.name,
  })
  if (weak) throw new HttpError(422, "WEAK_PASSWORD", weak)

  // El dueño se crea primero (Better Auth maneja su propia escritura); si el resto falla, se retira.
  const ownerId = await createUserAccount(auth, db, { ...input.owner, roleId: "owner" })

  try {
    const businessId = uuidv7(now)
    db.transaction(
      (tx) => {
        if (tx.select({ id: business.id }).from(business).get()) {
          throw new HttpError(409, "ALREADY_CONFIGURED", "El negocio ya está configurado")
        }
        tx.insert(business)
          .values({
            id: businessId,
            name: input.business.name,
            referenceCurrency: input.referenceCurrency,
            legalCurrency: input.legalCurrency,
            timezone: input.timezone,
            createdAt: now,
          })
          .run()
        tx.insert(branch)
          .values({ id: MAIN_BRANCH_ID, name: "Principal", createdAt: now })
          .onConflictDoNothing()
          .run()
        const locationId = uuidv7(now)
        tx.insert(location)
          .values({
            id: locationId,
            businessId,
            branchId: MAIN_BRANCH_ID,
            name: input.locationName,
            kind: "store",
          })
          .run()
        tx.insert(terminal)
          .values({
            id: uuidv7(now),
            locationId,
            code: input.terminalCode,
            name: `Caja ${input.terminalCode}`,
          })
          .run()
        // Un sujeto pasivo especial percibe el IGTF de los pagos en divisas; los ordinarios no.
        const igtfFor = (currencyCode: string) =>
          input.taxpayer === "special" && currencyCode !== input.legalCurrency
            ? IGTF_SURCHARGE.id
            : null
        for (const a of defaultMoneyAccounts(input.referenceCurrency, input.legalCurrency)) {
          const accountId = uuidv7(now)
          tx.insert(account)
            .values({ id: accountId, name: a.name, kind: a.kind, currency: a.currency })
            .run()
          tx.insert(paymentMethod)
            .values({
              id: uuidv7(now),
              name: a.name,
              accountId,
              requiresReference: a.ref,
              surchargeId: igtfFor(a.currency),
            })
            .run()
        }
        writeFiscalSettings(tx, {
          taxpayer: input.taxpayer,
          pricesIncludeTax: input.pricesIncludeTax,
          defaultTaxId: DEFAULT_TAX_ID,
        })
        if (input.business.taxId) writeBusinessProfile(tx, { taxId: input.business.taxId })
        if (input.initialRate) {
          const rate = makeRate(input.referenceCurrency, input.legalCurrency, input.initialRate)
          tx.insert(exchangeRate)
            .values({
              id: uuidv7(now),
              base: rate.base,
              quote: rate.quote,
              value: rate.value,
              source: "manual",
              effectiveAt: now,
              createdBy: ownerId,
              createdAt: now,
            })
            .run()
        }
      },
      { behavior: "immediate" },
    )
    return { businessId, ownerId }
  } catch (e) {
    db.delete(user).where(eq(user.id, ownerId)).run() // cascada: sesión y credenciales
    throw e
  }
}
