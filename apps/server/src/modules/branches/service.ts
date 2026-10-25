import type { BranchInfo, CreateBranchBody, UpdateBranchBody } from "@millhiore/contracts"
import {
  auditLog,
  branch,
  business,
  type Db,
  location,
  priceList,
  terminal,
  user,
  userBranch,
} from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { features } from "../features/routes"
import { satelliteBranchId } from "../sync/link"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Pick<Db, "select">

/** La sucursal que existe siempre: la de todo lo anterior a las sucursales. */
export const MAIN_BRANCH_ID = "main"

const OWNER_ROLE_ID = "owner"

/** La principal primero; después, en el orden en que se crearon. */
export const BRANCH_ORDER = [
  sql`${branch.id} <> ${MAIN_BRANCH_ID}`,
  asc(branch.createdAt),
  asc(branch.name),
] as const

/** Sucursales donde trabaja alguien; null, en todas (o las sucursales están apagadas). */
export type BranchScope = ReadonlySet<string> | null

/**
 * El dueño trabaja siempre en todas (así nadie queda sin poder deshacer una restricción). En el
 * servidor de una sucursal, todos trabajan solo en ella (las demás tienen el suyo).
 */
export function branchScope(db: Reader, userId: string | null): BranchScope {
  const satellite = satelliteBranchId(db)
  if (satellite) return new Set([satellite])
  if (!userId || !features(db).branches) return null
  const who = db.select({ roleId: user.roleId }).from(user).where(eq(user.id, userId)).get()
  if (who?.roleId === OWNER_ROLE_ID) return null
  const rows = db
    .select({ id: userBranch.branchId })
    .from(userBranch)
    .where(eq(userBranch.userId, userId))
    .all()
  return rows.length ? new Set(rows.map((r) => r.id)) : null
}

/** Las ubicaciones de esas sucursales; null, todas. */
export function locationsIn(db: Reader, scope: BranchScope): ReadonlySet<string> | null {
  if (!scope) return null
  return new Set(
    db
      .select({ id: location.id })
      .from(location)
      .where(inArray(location.branchId, [...scope]))
      .all()
      .map((l) => l.id),
  )
}

/** Las sucursales asignadas a cada usuario (sin entrada: en todas). */
export function branchesByUser(db: Reader): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const r of db.select().from(userBranch).orderBy(asc(userBranch.branchId)).all()) {
    out.set(r.userId, [...(out.get(r.userId) ?? []), r.branchId])
  }
  return out
}

/** Cambia las sucursales de alguien: null o vacío, todas. */
export function setUserBranches(
  tx: Pick<Db, "select" | "insert" | "delete">,
  userId: string,
  branchIds: readonly string[] | null,
): void {
  const ids = [...new Set(branchIds ?? [])]
  if (ids.length) {
    const known = tx
      .select({ id: branch.id })
      .from(branch)
      .where(and(inArray(branch.id, ids), eq(branch.active, true)))
      .all()
    if (known.length !== ids.length) {
      throw new HttpError(422, "UNKNOWN_BRANCH", "Alguna sucursal no existe o está inactiva")
    }
  }
  tx.delete(userBranch).where(eq(userBranch.userId, userId)).run()
  for (const branchId of ids) tx.insert(userBranch).values({ userId, branchId }).run()
}

/**
 * Lo registrado en estas sucursales (por la ubicación de la que sale); sin filtro con null. La
 * columna es la de la ubicación del documento o del movimiento.
 */
export function inBranches(
  locationColumn: SQL.Aliased | Parameters<typeof eq>[0],
  ids: readonly string[] | null,
): SQL | undefined {
  if (!ids) return undefined
  if (!ids.length) return sql`0`
  return sql`${locationColumn} in (select ${location.id} from ${location} where ${inArray(location.branchId, [...ids])})`
}

/**
 * Las sucursales que abarca una consulta (un informe, el historial): la pedida, si quien
 * consulta trabaja en ella; si no pidió una, todas las suyas (null: todas).
 */
export function branchesFor(scope: BranchScope, requested: string | undefined): string[] | null {
  if (requested) {
    if (scope && !scope.has(requested)) {
      throw new HttpError(403, "OTHER_BRANCH", "No trabajas en esa sucursal")
    }
    return [requested]
  }
  return scope ? [...scope] : null
}

const columns = {
  id: branch.id,
  name: branch.name,
  address: branch.address,
  phone: branch.phone,
  priceListId: branch.priceListId,
  active: branch.active,
  locations: sql<number>`(select count(*) from "location" as "l"
    where "l"."branch_id" = "branch"."id" and "l"."active" = 1)`,
  terminals: sql<number>`(select count(*) from "terminal" as "t"
    inner join "location" as "l" on "l"."id" = "t"."location_id"
    where "l"."branch_id" = "branch"."id" and "t"."active" = 1)`,
}

export function listBranches(db: Reader, opts: { all?: boolean } = {}): BranchInfo[] {
  return db
    .select(columns)
    .from(branch)
    .where(opts.all ? undefined : eq(branch.active, true))
    .orderBy(...BRANCH_ORDER)
    .all()
}

function branchById(db: Reader, id: string): BranchInfo {
  const row = db.select(columns).from(branch).where(eq(branch.id, id)).get()
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe la sucursal ${id}`)
  return row
}

function audit(tx: Tx, actorId: string, now: number, action: string, id: string, data: unknown) {
  tx.insert(auditLog)
    .values({ id: uuidv7(now), at: now, actorId, action, entityType: "branch", entityId: id, data })
    .run()
}

function requireFreeName(tx: Tx, name: string, exceptId?: string): void {
  const taken = tx
    .select({ id: branch.id })
    .from(branch)
    .where(sql`lower(${branch.name}) = lower(${name})`)
    .all()
    .some((r) => r.id !== exceptId)
  if (taken) throw new HttpError(409, "DUPLICATE_NAME", `Ya existe la sucursal «${name}»`)
}

function requirePriceList(tx: Tx, id: string | null | undefined): void {
  if (!id) return
  const row = tx
    .select({ active: priceList.active })
    .from(priceList)
    .where(eq(priceList.id, id))
    .get()
  if (!row?.active) {
    throw new HttpError(422, "UNKNOWN_PRICE_LIST", "Lista de precios desconocida o inactiva")
  }
}

/** Un nombre de ubicación libre: el de la sucursal, o con un número si ya está tomado. */
function freeLocationName(tx: Tx, name: string): string {
  const used = new Set(
    tx
      .select({ name: location.name })
      .from(location)
      .all()
      .map((l) => l.name.toLowerCase()),
  )
  if (!used.has(name.toLowerCase())) return name
  let n = 2
  while (used.has(`${name} ${n}`.toLowerCase())) n += 1
  return `${name} ${n}`
}

/** El siguiente prefijo libre de caja: C2, C3… */
function nextTerminalCode(tx: Tx): string {
  const used = new Set(
    tx
      .select({ code: terminal.code })
      .from(terminal)
      .all()
      .map((t) => t.code),
  )
  let n = 1
  while (used.has(`C${n}`)) n += 1
  return `C${n}`
}

/** Crea la sucursal con su tienda (del mismo nombre) y su primera caja: lista para vender. */
export function createBranch(
  db: Db,
  input: CreateBranchBody,
  actorId: string,
  now: number,
): BranchInfo {
  return db.transaction(
    (tx) => {
      const biz = tx.select({ id: business.id }).from(business).get()
      if (!biz) throw new HttpError(409, "NOT_SET_UP", "El negocio no está configurado")
      requireFreeName(tx, input.name)
      requirePriceList(tx, input.priceListId)
      const id = uuidv7(now)
      tx.insert(branch)
        .values({
          id,
          name: input.name,
          address: input.address || null,
          phone: input.phone || null,
          priceListId: input.priceListId ?? null,
          createdAt: now,
        })
        .run()
      const locationId = uuidv7(now)
      tx.insert(location)
        .values({
          id: locationId,
          businessId: biz.id,
          branchId: id,
          name: freeLocationName(tx, input.name),
          kind: "store",
        })
        .run()
      const code = nextTerminalCode(tx)
      tx.insert(terminal)
        .values({ id: uuidv7(now), code, name: `Caja ${input.name}`, locationId })
        .run()
      const created = branchById(tx, id)
      audit(tx, actorId, now, "branch.created", id, created)
      return created
    },
    { behavior: "immediate" },
  )
}

export function updateBranch(
  db: Db,
  id: string,
  patch: UpdateBranchBody,
  actorId: string,
  now: number,
): BranchInfo {
  return db.transaction(
    (tx) => {
      const before = branchById(tx, id)
      if (patch.name !== undefined) requireFreeName(tx, patch.name, id)
      requirePriceList(tx, patch.priceListId)
      if (patch.active === false && before.active) {
        if (before.terminals > 0) {
          throw new HttpError(
            409,
            "BRANCH_IN_USE",
            `«${before.name}» tiene cajas activas: desactívalas o muévelas antes`,
          )
        }
        const others = tx
          .select({ n: sql<number>`count(*)` })
          .from(branch)
          .where(and(eq(branch.active, true), sql`${branch.id} <> ${id}`))
          .get()
        if (!others?.n) {
          throw new HttpError(409, "LAST_BRANCH", "Tiene que quedar al menos una sucursal activa")
        }
      }
      const set = {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.address !== undefined ? { address: patch.address || null } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone || null } : {}),
        ...(patch.priceListId !== undefined ? { priceListId: patch.priceListId ?? null } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
      }
      if (Object.keys(set).length) tx.update(branch).set(set).where(eq(branch.id, id)).run()
      const after = branchById(tx, id)
      audit(tx, actorId, now, "branch.updated", id, { before, after })
      return after
    },
    { behavior: "immediate" },
  )
}
