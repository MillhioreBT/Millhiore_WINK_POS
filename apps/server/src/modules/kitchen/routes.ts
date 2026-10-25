import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  kitchenStationSchema,
  kitchenTicketSchema,
  saveKitchenStationSchema,
} from "@millhiore/contracts"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { forbidden } from "../../http/errors"
import {
  listStations,
  listTickets,
  printPending,
  queueReprint,
  saveStation,
  setTicketStatus,
  ticketById,
} from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })
const ticketParam = z.object({ id: z.string().min(1) })
const ticketResponses = {
  200: { description: "La comanda", content: json(kitchenTicketSchema) },
  403: { description: "Falta kitchen.view", ...err },
  404: { description: "No existe", ...err },
}

const stationsRoute = createRoute({
  method: "get",
  path: "/api/kitchen/stations",
  tags: ["Restaurante"],
  summary: "Estaciones de la cocina (cocina, barra…)",
  request: { query: z.object({ all: z.coerce.boolean().optional() }) },
  responses: {
    200: { description: "Estaciones", content: json(z.array(kitchenStationSchema)) },
    403: { description: "Falta kitchen.view o settings.manage", ...err },
  },
})

const createStationRoute = createRoute({
  method: "post",
  path: "/api/kitchen/stations",
  tags: ["Restaurante"],
  summary: "Crea una estación con sus categorías y su impresora",
  request: { body: { content: json(saveKitchenStationSchema), required: true } },
  responses: {
    201: { description: "Creada", content: json(kitchenStationSchema) },
    403: { description: "Falta settings.manage", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const saveStationRoute = createRoute({
  method: "put",
  path: "/api/kitchen/stations/{id}",
  tags: ["Restaurante"],
  summary: "Cambia una estación",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(saveKitchenStationSchema), required: true },
  },
  responses: {
    200: { description: "Guardada", content: json(kitchenStationSchema) },
    403: { description: "Falta settings.manage", ...err },
    404: { description: "No existe", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const ticketsRoute = createRoute({
  method: "get",
  path: "/api/kitchen/tickets",
  tags: ["Restaurante"],
  summary: "Comandas pendientes (la más vieja primero) o las últimas listas",
  request: {
    query: z.object({
      stationId: z.string().min(1).optional(),
      status: z.enum(["pending", "ready"]).default("pending"),
    }),
  },
  responses: {
    200: { description: "Comandas", content: json(z.array(kitchenTicketSchema)) },
    403: { description: "Falta kitchen.view", ...err },
  },
})

const readyRoute = createRoute({
  method: "post",
  path: "/api/kitchen/tickets/{id}/ready",
  tags: ["Restaurante"],
  summary: "Marca la comanda lista",
  request: { params: ticketParam },
  responses: ticketResponses,
})

const unreadyRoute = createRoute({
  method: "post",
  path: "/api/kitchen/tickets/{id}/unready",
  tags: ["Restaurante"],
  summary: "Devuelve una comanda a pendiente (se marcó lista por error)",
  request: { params: ticketParam },
  responses: ticketResponses,
})

const reprintRoute = createRoute({
  method: "post",
  path: "/api/kitchen/tickets/{id}/reprint",
  tags: ["Restaurante"],
  summary: "Vuelve a mandar la comanda a la impresora de su estación",
  request: { params: ticketParam },
  responses: ticketResponses,
})

export function registerKitchenRoutes(app: App, deps: AppDeps): void {
  /** La cocina la ve quien cocina, quien atiende las mesas y quien configura. */
  const canSee = (p: ReadonlySet<string>) =>
    p.has("kitchen.view") || p.has("table.serve") || p.has("settings.manage")

  app.openapi(stationsRoute, (c) => {
    if (!canSee(actorOf(c).permissions)) throw forbidden("kitchen.view")
    return c.json(listStations(deps.db, { all: c.req.valid("query").all ?? false }), 200)
  })

  app.openapi(createStationRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    return c.json(saveStation(deps.db, null, c.req.valid("json"), actor.userId, deps.now()), 201)
  })

  app.openapi(saveStationRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    const { id } = c.req.valid("param")
    return c.json(saveStation(deps.db, id, c.req.valid("json"), actor.userId, deps.now()), 200)
  })

  app.openapi(ticketsRoute, (c) => {
    if (!canSee(actorOf(c).permissions)) throw forbidden("kitchen.view")
    const q = c.req.valid("query")
    return c.json(
      listTickets(deps.db, {
        stationId: q.stationId,
        status: q.status,
        limit: q.status === "ready" ? 12 : 200,
      }),
      200,
    )
  })

  app.openapi(readyRoute, (c) => {
    const actor = requirePermission(c, "kitchen.view")
    const { id } = c.req.valid("param")
    return c.json(setTicketStatus(deps.db, id, "ready", actor.userId, deps.now()), 200)
  })

  app.openapi(unreadyRoute, (c) => {
    const actor = requirePermission(c, "kitchen.view")
    const { id } = c.req.valid("param")
    return c.json(setTicketStatus(deps.db, id, "pending", actor.userId, deps.now()), 200)
  })

  app.openapi(reprintRoute, async (c) => {
    if (!canSee(actorOf(c).permissions)) throw forbidden("kitchen.view")
    const { id } = c.req.valid("param")
    queueReprint(deps.db, id)
    await printPending(deps.db, deps.now())
    return c.json(ticketById(deps.db, id), 200)
  })
}

/** Después de guardar un pedido: imprime sus comandas sin hacer esperar a quien pidió. */
export function printInBackground(deps: AppDeps): void {
  void printPending(deps.db, deps.now()).catch(() => undefined)
}
