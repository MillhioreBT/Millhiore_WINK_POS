import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  branchSchema,
  createBranchSchema,
  updateBranchSchema,
} from "@millhiore/contracts"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { createBranch, listBranches, updateBranch } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const listRoute = createRoute({
  method: "get",
  path: "/api/branches",
  tags: ["Sucursales"],
  summary: "Sucursales, con cuántas ubicaciones y cajas activas tiene cada una",
  request: { query: z.object({ all: z.enum(["true", "false"]).optional() }) },
  responses: { 200: { description: "Sucursales", content: json(z.array(branchSchema)) } },
})

const createRouteDef = createRoute({
  method: "post",
  path: "/api/branches",
  tags: ["Sucursales"],
  summary: "Crea una sucursal con su tienda y su primera caja",
  description:
    "La tienda lleva el nombre de la sucursal y la caja, el siguiente prefijo libre (C2, C3…): queda lista para abrir el turno y vender.",
  request: { body: { content: json(createBranchSchema), required: true } },
  responses: {
    201: { description: "Creada", content: json(branchSchema) },
    403: { description: "Falta settings.manage", ...err },
    409: { description: "Nombre repetido", ...err },
    422: { description: "Lista de precios inválida", ...err },
  },
})

const updateRoute = createRoute({
  method: "patch",
  path: "/api/branches/{id}",
  tags: ["Sucursales"],
  summary: "Cambia los datos, la lista de precios o desactiva una sucursal",
  description: "No se desactiva mientras tenga cajas activas, ni la última activa.",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(updateBranchSchema), required: true },
  },
  responses: {
    200: { description: "Guardada", content: json(branchSchema) },
    403: { description: "Falta settings.manage", ...err },
    404: { description: "No existe", ...err },
    409: { description: "Nombre repetido, con cajas o la última", ...err },
    422: { description: "Lista de precios inválida", ...err },
  },
})

export function registerBranchRoutes(app: App, deps: AppDeps): void {
  app.openapi(listRoute, (c) => {
    actorOf(c)
    return c.json(listBranches(deps.db, { all: c.req.valid("query").all === "true" }), 200)
  })

  app.openapi(createRouteDef, (c) => {
    const actor = requirePermission(c, "settings.manage")
    return c.json(createBranch(deps.db, c.req.valid("json"), actor.userId, deps.now()), 201)
  })

  app.openapi(updateRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    const { id } = c.req.valid("param")
    return c.json(updateBranch(deps.db, id, c.req.valid("json"), actor.userId, deps.now()), 200)
  })
}
