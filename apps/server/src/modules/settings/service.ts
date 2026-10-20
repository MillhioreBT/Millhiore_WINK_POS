import type { BusinessProfile } from "@millhiore/contracts"
import {
  account,
  auditLog,
  business,
  type Db,
  DEFAULT_TAX_ID,
  IGTF_SURCHARGE,
  paymentMethod,
  setting,
  surcharge,
  tax,
} from "@millhiore/db"
import {
  isValidLineTax,
  isValidRateBp,
  TAXPAYER_TYPES,
  type TaxpayerType,
  uuidv7,
} from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import type { PostContext } from "../../posting/post"
import { normalizeTaxId } from "../contacts/service"

export function readSetting<T>(db: Db, key: string): T | undefined {
  const row = db.select().from(setting).where(eq(setting.key, key)).get()
  return row ? (row.value as T) : undefined
}

/** La base o una transacción abierta sobre ella. */
type Writer = Pick<Db, "insert">

export function writeSetting(db: Writer, key: string, value: unknown): void {
  db.insert(setting)
    .values({ key, value })
    .onConflictDoUpdate({ target: setting.key, set: { value } })
    .run()
}

/**
 * Permitir vender aunque las existencias registradas no alcancen. Por defecto sí: en una bodega
 * el inventario casi nunca está perfecto y bloquear la venta en caja es peor que un saldo negativo.
 */
export function allowNegativeStock(db: Db): boolean {
  return readSetting<boolean>(db, "inventory.allowNegativeStock") ?? true
}

/** Vender exige abrir turno (con su conteo de efectivo). Por defecto sí. */
export function requireShift(db: Db): boolean {
  return readSetting<boolean>(db, "cash.requireShift") ?? true
}

/** Permitir vender a crédito (fiado) a clientes registrados. Por defecto sí. */
export function creditEnabled(db: Db): boolean {
  return readSetting<boolean>(db, "credit.enabled") ?? true
}

/** Minutos sin usar la caja para bloquear la pantalla de quien tiene PIN; 0 = nunca. */
export function autoLockMinutes(db: Db): number {
  return readSetting<number>(db, "security.autoLockMinutes") ?? 0
}

export function updateSecuritySettings(
  db: Db,
  minutes: number,
  actorId: string,
  now: number,
): { autoLockMinutes: number } {
  return db.transaction(
    (tx) => {
      const before = autoLockMinutes(db)
      writeSetting(tx, "security.autoLockMinutes", minutes)
      audit(tx, actorId, now, "settings.security.updated", "security", {
        before: { autoLockMinutes: before },
        after: { autoLockMinutes: minutes },
      })
      return { autoLockMinutes: minutes }
    },
    { behavior: "immediate" },
  )
}

/** Activa o desactiva el fiado. Lo ya fiado sigue a deber; solo se frenan las ventas nuevas. */
export function updateCreditSettings(
  db: Db,
  enabled: boolean,
  actorId: string,
  now: number,
): { enabled: boolean } {
  return db.transaction(
    (tx) => {
      const before = creditEnabled(db)
      writeSetting(tx, "credit.enabled", enabled)
      audit(tx, actorId, now, "settings.credit.updated", "credit", {
        before: { enabled: before },
        after: { enabled },
      })
      return { enabled }
    },
    { behavior: "immediate" },
  )
}

/** Reglas vigentes con las que contabiliza una persona ahora mismo. */
export function postingContext(db: Db, now: number, actorId: string | null): PostContext {
  return {
    now,
    actorId,
    allowNegativeStock: allowNegativeStock(db),
    requireShift: requireShift(db),
    creditEnabled: creditEnabled(db),
    fiscal: fiscalSettings(db),
  }
}

export interface FiscalSettings {
  taxpayer: TaxpayerType
  /**
   * Los precios de venta ya incluyen el IVA (precio de vitrina, lo que paga el cliente). Por
   * defecto sí: es como se exhiben los precios al público. Las compras siempre van sin IVA,
   * como en la factura del proveedor, salvo que el documento diga otra cosa.
   */
  pricesIncludeTax: boolean
  /** IVA de los productos que no tienen uno asignado. */
  defaultTaxId: string
}

const FISCAL_KEYS = {
  taxpayer: "fiscal.taxpayer",
  pricesIncludeTax: "fiscal.pricesIncludeTax",
  defaultTaxId: "fiscal.defaultTaxId",
} as const

export function fiscalSettings(db: Db): FiscalSettings {
  const taxpayer = readSetting<string>(db, FISCAL_KEYS.taxpayer)
  return {
    taxpayer: (TAXPAYER_TYPES as readonly string[]).includes(taxpayer ?? "")
      ? (taxpayer as TaxpayerType)
      : "ordinary",
    pricesIncludeTax: readSetting<boolean>(db, FISCAL_KEYS.pricesIncludeTax) ?? true,
    defaultTaxId: readSetting<string>(db, FISCAL_KEYS.defaultTaxId) ?? DEFAULT_TAX_ID,
  }
}

/** Cambios parciales: lo que falte (o venga como undefined) no se toca. */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined }

const PROFILE_KEYS = {
  taxId: "business.taxId",
  address: "business.address",
  phone: "business.phone",
  receiptFooter: "receipt.footer",
} as const

/** Nombre, RIF y datos de contacto del negocio, y el mensaje al pie del recibo. */
export function businessProfile(db: Db): BusinessProfile {
  const biz = db.select().from(business).get()
  if (!biz) throw new HttpError(409, "NOT_CONFIGURED", "El negocio aún no está configurado")
  return {
    name: biz.name,
    taxId: readSetting<string>(db, PROFILE_KEYS.taxId) ?? null,
    address: readSetting<string>(db, PROFILE_KEYS.address) ?? null,
    phone: readSetting<string>(db, PROFILE_KEYS.phone) ?? null,
    receiptFooter: readSetting<string>(db, PROFILE_KEYS.receiptFooter) ?? null,
  }
}

export function writeBusinessProfile(
  db: Pick<Db, "insert" | "update" | "delete">,
  patch: Patch<BusinessProfile>,
): void {
  if (patch.name !== undefined) db.update(business).set({ name: patch.name }).run()
  for (const key of Object.keys(PROFILE_KEYS) as (keyof typeof PROFILE_KEYS)[]) {
    const raw = patch[key]
    if (raw === undefined) continue
    // Vacío = sin dato. El RIF se guarda siempre con el mismo formato (J-12345678-9).
    const value = key === "taxId" ? normalizeTaxId(raw) : raw?.trim() || null
    if (value === null) db.delete(setting).where(eq(setting.key, PROFILE_KEYS[key])).run()
    else writeSetting(db, PROFILE_KEYS[key], value)
  }
}

export function updateBusinessProfile(
  db: Db,
  patch: Patch<BusinessProfile>,
  actorId: string,
  now: number,
): BusinessProfile {
  return db.transaction(
    (tx) => {
      const before = businessProfile(db)
      writeBusinessProfile(tx, patch)
      const after = businessProfile(db)
      audit(tx, actorId, now, "settings.business.updated", "business", { before, after })
      return after
    },
    { behavior: "immediate" },
  )
}

export function writeFiscalSettings(db: Writer, patch: Patch<FiscalSettings>): void {
  for (const key of Object.keys(FISCAL_KEYS) as (keyof FiscalSettings)[]) {
    const value = patch[key]
    if (value !== undefined) writeSetting(db, FISCAL_KEYS[key], value)
  }
}

function audit(
  db: Writer,
  actorId: string,
  now: number,
  action: string,
  entity: string,
  data: unknown,
) {
  db.insert(auditLog)
    .values({
      id: uuidv7(now),
      at: now,
      actorId,
      action,
      entityType: "setting",
      entityId: entity,
      data,
    })
    .run()
}

/**
 * Cambia la condición fiscal. Al pasar a sujeto pasivo especial, los métodos de cobro en divisas
 * empiezan a cobrar el IGTF; al dejar de serlo, dejan de cobrarlo. Queda en la auditoría.
 */
export function updateFiscalSettings(
  db: Db,
  patch: Patch<FiscalSettings>,
  actorId: string,
  now: number,
): FiscalSettings {
  return db.transaction(
    (tx) => {
      const before = fiscalSettings(db)
      if (patch.defaultTaxId !== undefined) {
        const t = tx.select().from(tax).where(eq(tax.id, patch.defaultTaxId)).get()
        if (!t?.active) {
          throw new HttpError(
            422,
            "UNKNOWN_TAX",
            `Impuesto desconocido o inactivo: ${patch.defaultTaxId}`,
          )
        }
      }
      writeFiscalSettings(tx, patch)

      if (patch.taxpayer && (patch.taxpayer === "special") !== (before.taxpayer === "special")) {
        const biz = tx.select().from(business).get()
        const methods = tx
          .select({
            id: paymentMethod.id,
            surchargeId: paymentMethod.surchargeId,
            currency: account.currency,
          })
          .from(paymentMethod)
          .innerJoin(account, eq(paymentMethod.accountId, account.id))
          .all()
        for (const m of methods) {
          if (patch.taxpayer === "special" && !m.surchargeId && m.currency !== biz?.legalCurrency) {
            tx.update(paymentMethod)
              .set({ surchargeId: IGTF_SURCHARGE.id })
              .where(eq(paymentMethod.id, m.id))
              .run()
          } else if (patch.taxpayer !== "special" && m.surchargeId === IGTF_SURCHARGE.id) {
            tx.update(paymentMethod)
              .set({ surchargeId: null })
              .where(eq(paymentMethod.id, m.id))
              .run()
          }
        }
      }

      const after = fiscalSettings(db)
      audit(tx, actorId, now, "settings.fiscal.updated", "fiscal", { before, after })
      return after
    },
    { behavior: "immediate" },
  )
}

/** Cambia nombre, alícuota o estado de un impuesto. Los documentos emitidos no cambian. */
export function updateTax(
  db: Db,
  id: string,
  patch: { name?: string | undefined; rateBp?: number | undefined; active?: boolean | undefined },
  actorId: string,
  now: number,
) {
  return db.transaction(
    (tx) => {
      const before = tx.select().from(tax).where(eq(tax.id, id)).get()
      if (!before) throw new HttpError(404, "NOT_FOUND", `No existe el impuesto ${id}`)
      const after = { ...before, ...definedOnly(patch) }
      if (!isValidLineTax({ taxId: id, kind: after.kind, rateBp: after.rateBp })) {
        throw new HttpError(
          422,
          "INVALID_TAX_RATE",
          after.kind === "taxed"
            ? "Un impuesto gravado necesita una alícuota mayor que 0 y hasta 100 %"
            : "Un impuesto exento, exonerado o no sujeto va al 0 %",
        )
      }
      if (!after.active && fiscalSettings(db).defaultTaxId === id) {
        throw new HttpError(409, "DEFAULT_TAX", "No se puede desactivar el impuesto por defecto")
      }
      tx.update(tax).set(after).where(eq(tax.id, id)).run()
      audit(tx, actorId, now, "tax.updated", id, { before, after })
      return after
    },
    { behavior: "immediate" },
  )
}

/** Cambia la alícuota o el estado de un recargo (p. ej. si el Ejecutivo modifica el IGTF). */
export function updateSurcharge(
  db: Db,
  id: string,
  patch: { name?: string | undefined; rateBp?: number | undefined; active?: boolean | undefined },
  actorId: string,
  now: number,
) {
  return db.transaction(
    (tx) => {
      const before = tx.select().from(surcharge).where(eq(surcharge.id, id)).get()
      if (!before) throw new HttpError(404, "NOT_FOUND", `No existe el recargo ${id}`)
      const after = { ...before, ...definedOnly(patch) }
      if (!isValidRateBp(after.rateBp)) {
        throw new HttpError(422, "INVALID_RATE", "La alícuota debe estar entre 0 y 100 %")
      }
      tx.update(surcharge).set(after).where(eq(surcharge.id, id)).run()
      audit(tx, actorId, now, "surcharge.updated", id, { before, after })
      return after
    },
    { behavior: "immediate" },
  )
}

function definedOnly<T extends object>(patch: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }
}
