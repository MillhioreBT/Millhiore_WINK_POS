import { createRoute, z } from "@hono/zod-openapi"
import { apiErrorSchema, printBillSchema, printerSettingsSchema } from "@millhiore/contracts"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { forbidden, HttpError } from "../../http/errors"
import { canView } from "../documents/routes"
import { getDocument } from "../documents/service"
import {
  kickDrawer,
  printBill,
  printDocument,
  printerSettings,
  printTestPage,
  savePrinterSettings,
  withPatch,
} from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })
const okSchema = z.object({ ok: z.literal(true), drawerOpened: z.boolean() })
const printerErrors = {
  409: { description: "La impresora se maneja desde el navegador", ...err },
  422: { description: "Falta la IP, el recurso compartido o el dispositivo", ...err },
  502: { description: "La impresora no respondió", ...err },
}

const getRoute = createRoute({
  method: "get",
  path: "/api/settings/printer",
  tags: ["Impresión"],
  summary: "Impresora de recibos",
  responses: { 200: { description: "Configuración", content: json(printerSettingsSchema) } },
})

const putRoute = createRoute({
  method: "put",
  path: "/api/settings/printer",
  tags: ["Impresión"],
  summary: "Cambia la impresora de recibos",
  request: { body: { content: json(printerSettingsSchema.partial()), required: true } },
  responses: {
    200: { description: "Guardada", content: json(printerSettingsSchema) },
    403: { description: "Falta settings.manage", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const printDocRoute = createRoute({
  method: "post",
  path: "/api/print/documents/{id}",
  tags: ["Impresión"],
  summary: "Imprime el recibo de un documento en la impresora térmica",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: {
      content: json(z.object({ openDrawer: z.boolean().default(false) })),
      required: false,
    },
  },
  responses: {
    200: { description: "Impreso", content: json(okSchema) },
    403: { description: "No puede ver el documento", ...err },
    404: { description: "No existe", ...err },
    ...printerErrors,
  },
})

const testRoute = createRoute({
  method: "post",
  path: "/api/print/test",
  tags: ["Impresión"],
  summary: "Imprime una página de prueba (con la configuración enviada, sin guardarla)",
  request: { body: { content: json(printerSettingsSchema.partial()), required: false } },
  responses: {
    200: { description: "Impreso", content: json(okSchema) },
    403: { description: "Falta settings.manage", ...err },
    ...printerErrors,
  },
})

const billRoute = createRoute({
  method: "post",
  path: "/api/print/bill",
  tags: ["Impresión"],
  summary: "Imprime la precuenta de una mesa en la impresora térmica",
  request: { body: { content: json(printBillSchema), required: true } },
  responses: {
    200: { description: "Impreso", content: json(okSchema) },
    403: { description: "Falta table.serve o sale.create", ...err },
    ...printerErrors,
  },
})

const drawerRoute = createRoute({
  method: "post",
  path: "/api/print/drawer",
  tags: ["Impresión"],
  summary: "Abre la gaveta de dinero",
  responses: {
    200: { description: "Abierta", content: json(okSchema) },
    403: { description: "Falta shift.manage", ...err },
    ...printerErrors,
  },
})

export function registerPrintingRoutes(app: App, deps: AppDeps): void {
  app.openapi(getRoute, (c) => {
    actorOf(c)
    return c.json(printerSettings(deps.db), 200)
  })

  app.openapi(putRoute, (c) => {
    requirePermission(c, "settings.manage")
    return c.json(savePrinterSettings(deps.db, c.req.valid("json")), 200)
  })

  app.openapi(printDocRoute, async (c) => {
    const actor = actorOf(c)
    const { id } = c.req.valid("param")
    const doc = getDocument(deps.db, id)
    if (!canView(actor.permissions, doc.type)) {
      throw new HttpError(403, "FORBIDDEN", "No puedes ver este documento")
    }
    const body = (await c.req.json().catch(() => ({}))) as { openDrawer?: unknown }
    const result = await printDocument(deps.db, id, { openDrawer: body.openDrawer === true })
    return c.json({ ok: true as const, ...result }, 200)
  })

  app.openapi(testRoute, async (c) => {
    requirePermission(c, "settings.manage")
    const raw = await c.req.json().catch(() => ({}))
    const parsed = printerSettingsSchema.partial().safeParse(raw)
    if (!parsed.success) throw new HttpError(422, "VALIDATION", "Datos de impresora inválidos")
    await printTestPage(deps.db, withPatch(printerSettings(deps.db), parsed.data), deps.now())
    return c.json({ ok: true as const, drawerOpened: false }, 200)
  })

  app.openapi(billRoute, async (c) => {
    const actor = actorOf(c)
    if (!actor.permissions.has("table.serve") && !actor.permissions.has("sale.create")) {
      throw forbidden("table.serve")
    }
    await printBill(deps.db, c.req.valid("json"))
    return c.json({ ok: true as const, drawerOpened: false }, 200)
  })

  app.openapi(drawerRoute, async (c) => {
    requirePermission(c, "shift.manage")
    await kickDrawer(deps.db)
    return c.json({ ok: true as const, drawerOpened: true }, 200)
  })
}
