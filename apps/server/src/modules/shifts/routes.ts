import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  closeShiftSchema,
  openShiftSchema,
  shiftReportSchema,
  shiftSchema,
} from "@millhiore/contracts"
import { terminal } from "@millhiore/db"
import { eq } from "drizzle-orm"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { requireOwnBranch } from "../../posting/post"
import { postingContext } from "../settings/service"
import { closeShift, currentShift, getShift, listShifts, openShift, shiftReport } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const currentRoute = createRoute({
  method: "get",
  path: "/api/shifts/current",
  tags: ["Turnos"],
  summary: "Turno abierto de una terminal (null si está cerrada)",
  request: { query: z.object({ terminalId: z.string().min(1) }) },
  responses: { 200: { description: "Turno", content: json(shiftSchema.nullable()) } },
})

const openRoute = createRoute({
  method: "post",
  path: "/api/shifts",
  tags: ["Turnos"],
  summary: "Abre el turno contando el efectivo",
  description:
    "Si lo contado no coincide con los libros, la diferencia se asienta como ingreso o retiro.",
  request: { body: { content: json(openShiftSchema), required: true } },
  responses: {
    201: { description: "Abierto", content: json(shiftSchema) },
    403: { description: "Falta shift.manage", ...err },
    409: { description: "Ya hay un turno abierto o falta la tasa", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const closeRoute = createRoute({
  method: "post",
  path: "/api/shifts/{id}/close",
  tags: ["Turnos"],
  summary: "Cierra el turno con el arqueo",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(closeShiftSchema), required: true },
  },
  responses: {
    200: { description: "Cerrado", content: json(shiftSchema) },
    403: { description: "Falta shift.manage", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Ya cerrado o falta la tasa", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const listRoute = createRoute({
  method: "get",
  path: "/api/shifts",
  tags: ["Turnos"],
  summary: "Turnos recientes",
  request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
  responses: {
    200: { description: "Turnos", content: json(z.array(shiftSchema)) },
    403: { description: "Falta finance.view o shift.manage", ...err },
  },
})

const reportRoute = createRoute({
  method: "get",
  path: "/api/shifts/{id}/report",
  tags: ["Turnos"],
  summary: "Cierre de caja: ventas, cobrado por método, movimientos y arqueo",
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: {
    200: { description: "Resumen", content: json(shiftReportSchema) },
    403: { description: "Sin permiso", ...err },
    404: { description: "No existe", ...err },
  },
})

export function registerShiftRoutes(app: App, deps: AppDeps): void {
  const canSee = (permissions: ReadonlySet<string>) =>
    permissions.has("shift.manage") || permissions.has("finance.view")

  app.openapi(currentRoute, (c) => {
    actorOf(c)
    return c.json(currentShift(deps.db, c.req.valid("query").terminalId), 200)
  })

  app.openapi(openRoute, (c) => {
    const actor = requirePermission(c, "shift.manage")
    const shift = openShift(
      deps.db,
      c.req.valid("json"),
      postingContext(deps.db, deps.now(), actor.userId),
    )
    return c.json(shift, 201)
  })

  app.openapi(closeRoute, (c) => {
    const actor = requirePermission(c, "shift.manage")
    const shift = closeShift(
      deps.db,
      c.req.valid("param").id,
      c.req.valid("json"),
      postingContext(deps.db, deps.now(), actor.userId),
    )
    deps.onShiftClosed?.(shift.id)
    return c.json(shift, 200)
  })

  app.openapi(listRoute, (c) => {
    const actor = actorOf(c)
    if (!canSee(actor.permissions)) {
      throw new HttpError(403, "FORBIDDEN", "Falta el permiso finance.view")
    }
    const branches = actor.branchIds ? [...actor.branchIds] : null
    return c.json(listShifts(deps.db, c.req.valid("query").limit, branches), 200)
  })

  app.openapi(reportRoute, (c) => {
    const actor = actorOf(c)
    if (!canSee(actor.permissions)) {
      throw new HttpError(403, "FORBIDDEN", "Falta el permiso finance.view")
    }
    const { id } = c.req.valid("param")
    const shift = getShift(deps.db, id)
    const term = deps.db.select().from(terminal).where(eq(terminal.id, shift.terminalId)).get()
    if (term) requireOwnBranch(deps.db, actor, [term.locationId])
    return c.json(shiftReport(deps.db, id), 200)
  })
}
