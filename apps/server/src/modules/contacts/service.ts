import type { Contact, CreateContactBody, UpdateContactBody } from "@millhiore/contracts"
import { auditLog, contact, type Db } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, asc, eq, inArray, like, or } from "drizzle-orm"
import { HttpError } from "../../http/errors"

/** "v12345678" → "V-12345678"; "j123456789" → "J-12345678-9" (formato del RIF). */
export function normalizeTaxId(raw: string | null | undefined): string | null {
  if (!raw) return null
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, "")
  const letter = compact[0] ?? ""
  const digits = compact.slice(1)
  if (letter === "V" || letter === "E") return `${letter}-${digits}`
  // RIF jurídico: 8 dígitos + dígito verificador.
  return digits.length === 9
    ? `${letter}-${digits.slice(0, 8)}-${digits.slice(8)}`
    : `${letter}-${digits}`
}

export function listContacts(
  db: Db,
  opts: { search?: string | undefined; kind?: "customer" | "supplier" | undefined; all?: boolean },
): Contact[] {
  const term = opts.search?.trim()
  const filters = [
    opts.all ? undefined : eq(contact.active, true),
    opts.kind ? inArray(contact.kind, [opts.kind, "both"]) : undefined,
    term
      ? or(
          like(contact.name, `%${term}%`),
          like(contact.taxId, `%${term.replace(/[^A-Za-z0-9]/g, "")}%`),
          like(contact.taxId, `%${term.toUpperCase()}%`),
          like(contact.phone, `%${term}%`),
        )
      : undefined,
  ].filter((f) => f !== undefined)
  return db
    .select()
    .from(contact)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(contact.name))
    .limit(500)
    .all()
}

function duplicate(e: unknown): never {
  if (/UNIQUE/i.test(String((e as Error).cause ?? (e as Error).message))) {
    throw new HttpError(409, "DUPLICATE_TAX_ID", "Ya existe un contacto con esa cédula o RIF")
  }
  throw e
}

function audit(
  db: Pick<Db, "insert">,
  actorId: string,
  now: number,
  action: string,
  id: string,
  data: unknown,
) {
  db.insert(auditLog)
    .values({
      id: uuidv7(now),
      at: now,
      actorId,
      action,
      entityType: "contact",
      entityId: id,
      data,
    })
    .run()
}

export function createContact(
  db: Db,
  input: CreateContactBody,
  actorId: string,
  now: number,
): Contact {
  const id = uuidv7(now)
  return db.transaction((tx) => {
    try {
      tx.insert(contact)
        .values({
          id,
          kind: input.kind,
          name: input.name,
          taxId: normalizeTaxId(input.taxId),
          phone: input.phone || null,
          email: input.email || null,
          address: input.address || null,
          notes: input.notes || null,
          creditDays: input.creditDays ?? 0,
          creditLimitMinor: input.creditLimitMinor ?? null,
          createdAt: now,
        })
        .run()
    } catch (e) {
      duplicate(e)
    }
    const row = tx.select().from(contact).where(eq(contact.id, id)).get()
    if (!row) throw new Error("El contacto recién creado no se encontró")
    audit(tx, actorId, now, "contact.created", id, row)
    return row
  })
}

export function updateContact(
  db: Db,
  id: string,
  patch: UpdateContactBody,
  actorId: string,
  now: number,
): Contact {
  return db.transaction((tx) => {
    const before = tx.select().from(contact).where(eq(contact.id, id)).get()
    if (!before) throw new HttpError(404, "NOT_FOUND", `No existe el contacto ${id}`)
    const set = {
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.taxId !== undefined ? { taxId: normalizeTaxId(patch.taxId) } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone || null } : {}),
      ...(patch.email !== undefined ? { email: patch.email || null } : {}),
      ...(patch.address !== undefined ? { address: patch.address || null } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes || null } : {}),
      ...(patch.creditDays !== undefined ? { creditDays: patch.creditDays } : {}),
      ...(patch.creditLimitMinor !== undefined ? { creditLimitMinor: patch.creditLimitMinor } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    }
    try {
      if (Object.keys(set).length) tx.update(contact).set(set).where(eq(contact.id, id)).run()
    } catch (e) {
      duplicate(e)
    }
    const after = tx.select().from(contact).where(eq(contact.id, id)).get()
    if (!after) throw new Error("El contacto desapareció")
    audit(tx, actorId, now, "contact.updated", id, { before, after })
    return after
  })
}
