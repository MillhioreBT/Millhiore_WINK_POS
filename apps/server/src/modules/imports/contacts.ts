import { type ImportBody, type ImportResult, taxIdSchema } from "@millhiore/contracts"
import { auditLog, business, contact, currency, type Db, terminal } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { HttpError } from "../../http/errors"
import { postDocumentIn } from "../../posting/post"
import { normalizeTaxId } from "../contacts/service"
import { rateAt } from "../rates/service"
import { postingContext } from "../settings/service"
import { amount, type Cell, key, text } from "./cells"

type Row = ImportResult["rows"][number]
type Kind = "customer" | "supplier" | "both"

interface Plan {
  existingId: string | null
  kind: Kind | undefined
  name: string | null
  taxId: string | null
  phone: string | null
  email: string | null
  address: string | null
  notes: string | null
  creditDays: number | undefined
  creditLimitMinor: number | undefined
  /** Lo que ya debía (cliente) o se le debía (proveedor), en la moneda de referencia. */
  balanceMinor: number | undefined
}

/** Quien importa puede anotar lo que deben los clientes y lo que se les debe a los proveedores. */
export interface DebtPermissions {
  receivable: boolean
  payable: boolean
}

const email = z.email()

function kindOf(raw: string | null): Kind | undefined | null {
  if (!raw) return undefined
  const k = key(raw)
  if (/^(cliente|clientes|customer|c)$/.test(k)) return "customer"
  if (/^(proveedor|proveedores|supplier|p)$/.test(k)) return "supplier"
  if (/^(ambos|los dos|both|cliente y proveedor)$/.test(k)) return "both"
  return null
}

/**
 * Importa clientes y proveedores. Se reconocen por la cédula o el RIF: si ya existe, se actualiza
 * (con `updateExisting`) o se omite. El límite de crédito y el saldo van en la moneda de
 * referencia; el saldo de un contacto nuevo queda anotado como una deuda que se cobra o se paga
 * después (a uno que ya existe no se le anota, para que importar dos veces no lo duplique).
 */
export function importContacts(
  db: Db,
  body: ImportBody,
  actorId: string,
  now: number,
  may: DebtPermissions = { receivable: false, payable: false },
): ImportResult {
  return db.transaction(
    (tx) => {
      const biz = tx.select().from(business).get()
      if (!biz) throw new HttpError(409, "NOT_CONFIGURED", "El negocio aún no está configurado")
      const refDecimals =
        tx.select().from(currency).where(eq(currency.code, biz.referenceCurrency)).get()
          ?.decimals ?? 2
      const byTaxId = new Map(
        tx
          .select({ id: contact.id, taxId: contact.taxId })
          .from(contact)
          .all()
          .flatMap((c) => (c.taxId ? [[c.taxId, c.id] as const] : [])),
      )
      // Un saldo en divisas necesita la tasa del día para su monto en moneda legal.
      const rate =
        biz.referenceCurrency === biz.legalCurrency
          ? null
          : (rateAt(tx, biz.referenceCurrency, biz.legalCurrency, now) ?? undefined)

      const rows: Row[] = []
      const plans: Plan[] = []
      const seen = new Map<string, number>()
      for (const { row, values } of body.rows) {
        const v = (k: string): Cell => values[k]
        const messages: string[] = []
        const name = text(v("name"))?.slice(0, 120) ?? null
        const rawTaxId = text(v("taxId"))
        let taxId: string | null = null
        if (rawTaxId) {
          const parsed = taxIdSchema.safeParse(rawTaxId)
          if (parsed.success) taxId = normalizeTaxId(parsed.data)
          else messages.push(`Cédula o RIF inválido: ${rawTaxId}`)
        }
        const existingId = taxId ? (byTaxId.get(taxId) ?? null) : null
        if (!name && !existingId) messages.push("Falta el nombre")
        if (taxId) {
          const other = seen.get(taxId)
          if (other) messages.push(`La cédula o RIF ${taxId} se repite (fila ${other})`)
          else seen.set(taxId, row)
        }
        const kind = kindOf(text(v("kind")))
        if (kind === null)
          messages.push(`Tipo desconocido: ${text(v("kind"))} (cliente, proveedor o ambos)`)
        const mail = text(v("email"))
        if (mail && !email.safeParse(mail).success) messages.push(`Correo inválido: ${mail}`)
        const phone = text(v("phone"))?.slice(0, 30) ?? null
        const daysMinor = amount(v("creditDays"), 0)
        if (daysMinor === null || (daysMinor !== undefined && daysMinor > 365)) {
          messages.push("Los días de crédito van de 0 a 365")
        }
        const creditLimitMinor = amount(v("creditLimit"), refDecimals)
        if (creditLimitMinor === null) messages.push("El límite de crédito no es un monto válido")
        const balance = amount(v("balance"), refDecimals)
        if (balance === null) messages.push("El saldo no es un monto válido")
        const owes = balance !== null && balance !== undefined && balance > 0
        if (owes && !existingId) {
          const asKind = kind ?? "customer"
          if (asKind === "both") {
            messages.push("Para anotar el saldo, di si es cliente (te debe) o proveedor (le debes)")
          } else if (asKind === "customer" ? !may.receivable : !may.payable) {
            messages.push(
              asKind === "customer"
                ? "Anotar lo que debe un cliente exige el permiso finance.manage"
                : "Anotar lo que se le debe a un proveedor exige el permiso payable.manage",
            )
          } else if (rate === undefined) {
            messages.push("Hace falta la tasa del día para anotar el saldo")
          }
        }

        const label = name ?? taxId ?? `Fila ${row}`
        if (messages.length) {
          rows.push({ row, name: label, status: "error", messages })
          continue
        }
        if (existingId && !body.updateExisting) {
          rows.push({
            row,
            name: label,
            status: "skip",
            messages: ["Ya existe (misma cédula o RIF)"],
          })
          continue
        }
        rows.push({
          row,
          name: label,
          status: existingId ? "update" : "create",
          messages:
            owes && existingId
              ? ["El saldo no se anota a un contacto que ya existe: hazlo en Fiado o en Por pagar"]
              : [],
        })
        plans.push({
          existingId,
          kind: kind ?? undefined,
          name,
          taxId,
          phone,
          email: mail,
          address: text(v("address"))?.slice(0, 200) ?? null,
          notes: text(v("notes"))?.slice(0, 500) ?? null,
          creditDays: daysMinor ?? undefined,
          creditLimitMinor: creditLimitMinor ?? undefined,
          balanceMinor: owes && !existingId ? balance : undefined,
        })
      }

      let debts = 0
      if (body.apply && plans.length) {
        const term = plans.some((p) => p.balanceMinor)
          ? tx.select().from(terminal).where(eq(terminal.active, true)).get()
          : undefined
        for (const p of plans) {
          if (p.existingId) {
            const set = {
              ...(p.kind ? { kind: p.kind } : {}),
              ...(p.name ? { name: p.name } : {}),
              ...(p.phone ? { phone: p.phone } : {}),
              ...(p.email ? { email: p.email } : {}),
              ...(p.address ? { address: p.address } : {}),
              ...(p.notes ? { notes: p.notes } : {}),
              ...(p.creditDays !== undefined ? { creditDays: p.creditDays } : {}),
              ...(p.creditLimitMinor !== undefined ? { creditLimitMinor: p.creditLimitMinor } : {}),
            }
            if (Object.keys(set).length) {
              tx.update(contact).set(set).where(eq(contact.id, p.existingId)).run()
            }
          } else {
            const id = uuidv7(now)
            tx.insert(contact)
              .values({
                id,
                kind: p.kind ?? "customer",
                name: p.name ?? "",
                taxId: p.taxId,
                phone: p.phone,
                email: p.email,
                address: p.address,
                notes: p.notes,
                creditDays: p.creditDays ?? 0,
                creditLimitMinor: p.creditLimitMinor ?? null,
                createdAt: now,
              })
              .run()
            if (p.balanceMinor) {
              if (!term) throw new HttpError(409, "NO_TERMINAL", "No hay ninguna caja activa")
              postDocumentIn(
                tx,
                {
                  id: uuidv7(now),
                  type: (p.kind ?? "customer") === "customer" ? "DEBT_IN" : "DEBT_OUT",
                  terminalId: term.id,
                  currency: biz.referenceCurrency,
                  rate: rate ? { base: rate.base, quote: rate.quote, value: rate.value } : null,
                  lines: [],
                  payments: [],
                  contactId: id,
                  note: "Saldo anterior",
                  amountMinor: p.balanceMinor,
                  creditMinor: p.balanceMinor,
                  creditCurrency: biz.referenceCurrency,
                },
                postingContext(tx, now, actorId),
              )
              debts += 1
            }
          }
        }
        tx.insert(auditLog)
          .values({
            id: uuidv7(now),
            at: now,
            actorId,
            action: "contact.imported",
            entityType: "contact",
            entityId: uuidv7(now),
            data: {
              count: plans.length,
              created: plans.filter((p) => !p.existingId).length,
              updated: plans.filter((p) => p.existingId).length,
              debts,
            },
          })
          .run()
      }
      const count = (s: Row["status"]) => rows.filter((r) => r.status === s).length
      return {
        applied: body.apply && plans.length > 0,
        created: count("create"),
        updated: count("update"),
        skipped: count("skip"),
        errors: count("error"),
        rows,
        newCategories: [],
        stockDocumentNumber: null,
        debts: body.apply ? debts : plans.filter((p) => p.balanceMinor).length,
      }
    },
    { behavior: body.apply ? "immediate" : "deferred" },
  )
}
