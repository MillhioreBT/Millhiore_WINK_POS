import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  type CreateLocationBody,
  type CreateTerminalBody,
  createLocationSchema,
  createTerminalSchema,
  type StockLocation,
  stockLocationSchema,
  type TerminalInfo,
  terminalSchema,
  type UpdateLocationBody,
  type UpdateTerminalBody,
  updateLocationSchema,
  updateTerminalSchema,
} from "@millhiore/contracts"
import { auditLog, branch, business, cashShift, type Db, location, terminal } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, asc, eq, sql } from "drizzle-orm"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { MAIN_BRANCH_ID } from "../branches/service"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Pick<Db, "select">

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

/** La tienda primero, después el depósito y la cocina. */
const KIND_ORDER = { store: 0, warehouse: 1, kitchen: 2 } as const

const locationColumns = {
  id: location.id,
  name: location.name,
  kind: location.kind,
  active: location.active,
  branchId: sql<string>`coalesce(${location.branchId}, ${MAIN_BRANCH_ID})`,
  branchName: sql<string>`coalesce(${branch.name}, '')`,
  // Nombres explícitos: en una consulta de una sola tabla drizzle no califica las columnas.
  productsInStock: sql<number>`(select count(*) from "stock_balance" as "b"
    where "b"."location_id" = "location"."id" and "b"."qty_milli" <> 0)`,
}

function sortLocations<T extends { kind: keyof typeof KIND_ORDER; name: string }>(rows: T[]): T[] {
  return rows.sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name, "es"),
  )
}

export function listLocations(db: Reader, opts: { all?: boolean } = {}): StockLocation[] {
  return sortLocations(
    db
      .select(locationColumns)
      .from(location)
      .leftJoin(branch, eq(branch.id, location.branchId))
      .where(opts.all ? undefined : eq(location.active, true))
      .all(),
  )
}

function locationById(db: Reader, id: string): StockLocation {
  const row = db
    .select(locationColumns)
    .from(location)
    .leftJoin(branch, eq(branch.id, location.branchId))
    .where(eq(location.id, id))
    .get()
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe la ubicación ${id}`)
  return row
}

function audit(
  tx: Tx,
  actorId: string,
  now: number,
  action: string,
  entityType: "location" | "terminal",
  id: string,
  data: unknown,
) {
  tx.insert(auditLog)
    .values({ id: uuidv7(now), at: now, actorId, action, entityType, entityId: id, data })
    .run()
}

function requireActiveBranch(tx: Tx, id: string): void {
  const row = tx.select({ active: branch.active }).from(branch).where(eq(branch.id, id)).get()
  if (!row?.active)
    throw new HttpError(422, "UNKNOWN_BRANCH", `Sucursal desconocida o inactiva: ${id}`)
}

/** Dos ubicaciones con el mismo nombre (sin importar mayúsculas) confundirían los traslados. */
function requireFreeName(tx: Tx, name: string, exceptId?: string): void {
  const taken = tx
    .select({ id: location.id })
    .from(location)
    .where(sql`lower(${location.name}) = lower(${name})`)
    .all()
    .some((r) => r.id !== exceptId)
  if (taken) throw new HttpError(409, "DUPLICATE_NAME", `Ya existe la ubicación «${name}»`)
}

export function createLocation(
  db: Db,
  input: CreateLocationBody,
  actorId: string,
  now: number,
): StockLocation {
  return db.transaction(
    (tx) => {
      const biz = tx.select({ id: business.id }).from(business).get()
      if (!biz) throw new HttpError(409, "NOT_SET_UP", "El negocio no está configurado")
      requireFreeName(tx, input.name)
      const branchId = input.branchId ?? MAIN_BRANCH_ID
      requireActiveBranch(tx, branchId)
      const id = uuidv7(now)
      tx.insert(location)
        .values({ id, businessId: biz.id, branchId, name: input.name, kind: input.kind })
        .run()
      const created = locationById(tx, id)
      audit(tx, actorId, now, "location.created", "location", id, created)
      return created
    },
    { behavior: "immediate" },
  )
}

export function updateLocation(
  db: Db,
  id: string,
  patch: UpdateLocationBody,
  actorId: string,
  now: number,
): StockLocation {
  return db.transaction(
    (tx) => {
      const before = locationById(tx, id)
      if (patch.name !== undefined) requireFreeName(tx, patch.name, id)
      const movesBranch = patch.branchId !== undefined && patch.branchId !== before.branchId
      if (movesBranch) {
        requireActiveBranch(tx, patch.branchId as string)
        // Lo vendido y lo contado en ella ya cuenta para su sucursal: con existencia o cajas, no.
        const till = tx
          .select({ name: terminal.name })
          .from(terminal)
          .where(and(eq(terminal.locationId, id), eq(terminal.active, true)))
          .get()
        if (till || before.productsInStock > 0) {
          throw new HttpError(
            409,
            "LOCATION_IN_USE",
            `«${before.name}» ya tiene ${till ? "cajas" : "existencia"}: crea una ubicación nueva en la otra sucursal`,
          )
        }
      }
      if (patch.active === false && before.active) {
        const till = tx
          .select({ name: terminal.name })
          .from(terminal)
          .where(and(eq(terminal.locationId, id), eq(terminal.active, true)))
          .get()
        if (till) {
          throw new HttpError(
            409,
            "LOCATION_IN_USE",
            `${till.name} vende desde «${before.name}»: muévela a otra ubicación antes`,
          )
        }
        if (before.productsInStock > 0) {
          throw new HttpError(
            409,
            "LOCATION_HAS_STOCK",
            `«${before.name}» todavía tiene existencia: trasládala o ajústala antes de desactivarla`,
          )
        }
      }
      const set = {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        ...(movesBranch ? { branchId: patch.branchId } : {}),
      }
      if (Object.keys(set).length) tx.update(location).set(set).where(eq(location.id, id)).run()
      const after = locationById(tx, id)
      audit(tx, actorId, now, "location.updated", "location", id, { before, after })
      return after
    },
    { behavior: "immediate" },
  )
}

const terminalColumns = {
  id: terminal.id,
  code: terminal.code,
  name: terminal.name,
  locationId: terminal.locationId,
  locationName: location.name,
  branchId: sql<string>`coalesce(${location.branchId}, ${MAIN_BRANCH_ID})`,
  branchName: sql<string>`coalesce(${branch.name}, '')`,
  active: terminal.active,
  shiftOpen: sql<boolean>`exists (select 1 from ${cashShift}
    where ${cashShift.terminalId} = ${terminal.id} and ${cashShift.status} = 'open')`.mapWith(
    Boolean,
  ),
}

export function listTerminals(db: Reader, opts: { all?: boolean } = {}): TerminalInfo[] {
  return db
    .select(terminalColumns)
    .from(terminal)
    .innerJoin(location, eq(location.id, terminal.locationId))
    .leftJoin(branch, eq(branch.id, location.branchId))
    .where(opts.all ? undefined : eq(terminal.active, true))
    .orderBy(asc(terminal.code))
    .all()
}

function terminalById(db: Reader, id: string): TerminalInfo {
  const row = db
    .select(terminalColumns)
    .from(terminal)
    .innerJoin(location, eq(location.id, terminal.locationId))
    .leftJoin(branch, eq(branch.id, location.branchId))
    .where(eq(terminal.id, id))
    .get()
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe la caja ${id}`)
  return row
}

function requireActiveLocation(tx: Tx, id: string): void {
  const row = tx.select({ active: location.active }).from(location).where(eq(location.id, id)).get()
  if (!row?.active) {
    throw new HttpError(422, "UNKNOWN_LOCATION", `Ubicación desconocida o inactiva: ${id}`)
  }
}

/** El siguiente prefijo libre: C2, C3… (el de la primera caja es C1). */
function nextCode(tx: Tx): string {
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

export function createTerminal(
  db: Db,
  input: CreateTerminalBody,
  actorId: string,
  now: number,
): TerminalInfo {
  return db.transaction(
    (tx) => {
      requireActiveLocation(tx, input.locationId)
      const code = input.code?.toUpperCase() ?? nextCode(tx)
      if (tx.select({ id: terminal.id }).from(terminal).where(eq(terminal.code, code)).get()) {
        throw new HttpError(409, "DUPLICATE_CODE", `Ya hay una caja con el prefijo ${code}`)
      }
      const id = uuidv7(now)
      tx.insert(terminal).values({ id, code, name: input.name, locationId: input.locationId }).run()
      const created = terminalById(tx, id)
      audit(tx, actorId, now, "terminal.created", "terminal", id, created)
      return created
    },
    { behavior: "immediate" },
  )
}

export function updateTerminal(
  db: Db,
  id: string,
  patch: UpdateTerminalBody,
  actorId: string,
  now: number,
): TerminalInfo {
  return db.transaction(
    (tx) => {
      const before = terminalById(tx, id)
      const moves = patch.locationId !== undefined && patch.locationId !== before.locationId
      const closes = patch.active === false && before.active
      if (moves) requireActiveLocation(tx, patch.locationId as string)
      // Un turno vende de una sola ubicación y cuenta una sola gaveta.
      if ((moves || closes) && before.shiftOpen) {
        throw new HttpError(409, "SHIFT_OPEN", `Cierra el turno de ${before.name} antes`)
      }
      if (closes) {
        const others = tx
          .select({ n: sql<number>`count(*)` })
          .from(terminal)
          .where(and(eq(terminal.active, true), sql`${terminal.id} <> ${id}`))
          .get()
        if (!others?.n) {
          throw new HttpError(409, "LAST_TERMINAL", "Tiene que quedar al menos una caja activa")
        }
      }
      if (patch.active === true && !before.active) {
        requireActiveLocation(tx, patch.locationId ?? before.locationId)
      }
      const set = {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.locationId !== undefined ? { locationId: patch.locationId } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
      }
      if (Object.keys(set).length) tx.update(terminal).set(set).where(eq(terminal.id, id)).run()
      const after = terminalById(tx, id)
      audit(tx, actorId, now, "terminal.updated", "terminal", id, { before, after })
      return after
    },
    { behavior: "immediate" },
  )
}

const all = z.object({ all: z.enum(["true", "false"]).optional() })

const listLocationsRoute = createRoute({
  method: "get",
  path: "/api/locations",
  tags: ["Inventario"],
  summary: "Ubicaciones (tienda, depósito, cocina…)",
  request: { query: all },
  responses: { 200: { description: "Ubicaciones", content: json(z.array(stockLocationSchema)) } },
})

const createLocationRoute = createRoute({
  method: "post",
  path: "/api/locations",
  tags: ["Inventario"],
  summary: "Crea una ubicación",
  request: { body: { content: json(createLocationSchema), required: true } },
  responses: {
    201: { description: "Creada", content: json(stockLocationSchema) },
    403: { description: "Falta settings.manage", ...err },
    409: { description: "Nombre repetido", ...err },
  },
})

const updateLocationRoute = createRoute({
  method: "patch",
  path: "/api/locations/{id}",
  tags: ["Inventario"],
  summary: "Renombra, cambia el tipo o desactiva una ubicación",
  description:
    "No se desactiva mientras tenga existencia o una caja activa venda desde ella; lo registrado no cambia.",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(updateLocationSchema), required: true },
  },
  responses: {
    200: { description: "Guardada", content: json(stockLocationSchema) },
    403: { description: "Falta settings.manage", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Nombre repetido, con existencia o con una caja", ...err },
  },
})

const listTerminalsRoute = createRoute({
  method: "get",
  path: "/api/terminals",
  tags: ["Turnos"],
  summary: "Cajas, con su ubicación y si tienen un turno abierto",
  request: { query: all },
  responses: { 200: { description: "Cajas", content: json(z.array(terminalSchema)) } },
})

const createTerminalRoute = createRoute({
  method: "post",
  path: "/api/terminals",
  tags: ["Turnos"],
  summary: "Crea una caja",
  description:
    "Vende de la existencia de su ubicación, numera sus documentos con su prefijo y abre y cierra su propio turno con su gaveta.",
  request: { body: { content: json(createTerminalSchema), required: true } },
  responses: {
    201: { description: "Creada", content: json(terminalSchema) },
    403: { description: "Falta settings.manage", ...err },
    409: { description: "Prefijo repetido", ...err },
    422: { description: "Ubicación inválida", ...err },
  },
})

const updateTerminalRoute = createRoute({
  method: "patch",
  path: "/api/terminals/{id}",
  tags: ["Turnos"],
  summary: "Renombra, mueve a otra ubicación o desactiva una caja",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(updateTerminalSchema), required: true },
  },
  responses: {
    200: { description: "Guardada", content: json(terminalSchema) },
    403: { description: "Falta settings.manage", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Turno abierto o última caja activa", ...err },
    422: { description: "Ubicación inválida", ...err },
  },
})

export function registerLocationRoutes(app: App, deps: AppDeps): void {
  app.openapi(listLocationsRoute, (c) => {
    actorOf(c)
    return c.json(listLocations(deps.db, { all: c.req.valid("query").all === "true" }), 200)
  })

  app.openapi(createLocationRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    return c.json(createLocation(deps.db, c.req.valid("json"), actor.userId, deps.now()), 201)
  })

  app.openapi(updateLocationRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    const { id } = c.req.valid("param")
    return c.json(updateLocation(deps.db, id, c.req.valid("json"), actor.userId, deps.now()), 200)
  })

  app.openapi(listTerminalsRoute, (c) => {
    actorOf(c)
    return c.json(listTerminals(deps.db, { all: c.req.valid("query").all === "true" }), 200)
  })

  app.openapi(createTerminalRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    return c.json(createTerminal(deps.db, c.req.valid("json"), actor.userId, deps.now()), 201)
  })

  app.openapi(updateTerminalRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    const { id } = c.req.valid("param")
    return c.json(updateTerminal(deps.db, id, c.req.valid("json"), actor.userId, deps.now()), 200)
  })
}
