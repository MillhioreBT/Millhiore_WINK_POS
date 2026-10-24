import { createRoute, type z } from "@hono/zod-openapi"
import { apiErrorSchema, importBodySchema, importResultSchema } from "@millhiore/contracts"
import { requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { importContacts } from "./contacts"
import { importProducts } from "./products"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const productsRoute = createRoute({
  method: "post",
  path: "/api/import/products",
  tags: ["Importación"],
  summary: "Importa productos desde las filas de una hoja de cálculo",
  description:
    "Campos por fila: name, price, currency, sku, barcode, category, tax, cost, minStock, stock, " +
    "kind. Con apply: false solo revisa; con apply: true guarda las filas válidas. La existencia " +
    "se suma con un ajuste de inventario (exige inventory.adjust); el costo exige cost.view.",
  request: { body: { content: json(importBodySchema), required: true } },
  responses: {
    200: { description: "Resultado fila por fila", content: json(importResultSchema) },
    403: { description: "Falta catalog.manage", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const contactsRoute = createRoute({
  method: "post",
  path: "/api/import/contacts",
  tags: ["Importación"],
  summary: "Importa clientes y proveedores desde las filas de una hoja de cálculo",
  description:
    "Campos por fila: name, kind, taxId, phone, email, address, creditDays, creditLimit, notes. " +
    "Se reconocen por la cédula o el RIF.",
  request: { body: { content: json(importBodySchema), required: true } },
  responses: {
    200: { description: "Resultado fila por fila", content: json(importResultSchema) },
    403: { description: "Falta contact.manage", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

export function registerImportRoutes(app: App, deps: AppDeps): void {
  app.openapi(productsRoute, (c) => {
    const actor = requirePermission(c, "catalog.manage")
    const result = importProducts(
      deps.db,
      c.req.valid("json"),
      {
        userId: actor.userId,
        canAdjustStock: actor.permissions.has("inventory.adjust"),
        canSeeCost: actor.permissions.has("cost.view"),
      },
      deps.now(),
    )
    return c.json(result, 200)
  })

  app.openapi(contactsRoute, (c) => {
    const actor = requirePermission(c, "contact.manage")
    const may = {
      receivable: actor.permissions.has("finance.manage"),
      payable: actor.permissions.has("payable.manage"),
    }
    return c.json(importContacts(deps.db, c.req.valid("json"), actor.userId, deps.now(), may), 200)
  })
}
