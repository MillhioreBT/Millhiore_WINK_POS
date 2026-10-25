import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  bulkPriceBodySchema,
  bulkPriceResultSchema,
  type CatalogItem,
  catalogItemSchema,
  createProductSchema,
  productDetailSchema,
  updateProductSchema,
} from "@millhiore/contracts"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { forbidden } from "../../http/errors"
import { registerCategoryRoutes } from "./categories"
import { registerModifierRoutes } from "./modifiers"
import { registerPriceListRoutes } from "./priceLists"
import { bulkReprice } from "./pricing"
import { createProduct, listItems, productDetail, updateProduct } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const listRoute = createRoute({
  method: "get",
  path: "/api/products",
  tags: ["Catálogo"],
  summary: "Productos con su precio, IVA y existencia",
  request: {
    query: z.object({
      search: z.string().max(80).optional(),
      /** "true" incluye los desactivados. */
      all: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: { 200: { description: "Productos", content: json(z.array(catalogItemSchema)) } },
})

const detailRoute = createRoute({
  method: "get",
  path: "/api/products/{id}",
  tags: ["Catálogo"],
  summary: "Un producto con todas sus variantes (tallas, colores…), también las desactivadas",
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: {
    200: { description: "Producto", content: json(productDetailSchema) },
    404: { description: "No existe", ...err },
  },
})

const createRouteDef = createRoute({
  method: "post",
  path: "/api/products",
  tags: ["Catálogo"],
  summary: "Crea un producto: una variante, o una por cada combinación de tallas, colores…",
  request: { body: { content: json(createProductSchema), required: true } },
  responses: {
    201: { description: "Creado", content: json(catalogItemSchema) },
    403: { description: "Falta catalog.manage", ...err },
    409: { description: "SKU o código de barras repetido", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const updateRoute = createRoute({
  method: "patch",
  path: "/api/products/{id}",
  tags: ["Catálogo"],
  summary: "Edita un producto; los cambios de precio quedan auditados",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: { content: json(updateProductSchema), required: true },
  },
  responses: {
    200: { description: "Guardado", content: json(catalogItemSchema) },
    403: { description: "Falta catalog.manage", ...err },
    404: { description: "No existe", ...err },
    409: { description: "SKU o código de barras repetido", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const bulkPriceRoute = createRoute({
  method: "post",
  path: "/api/products/bulk-price",
  tags: ["Catálogo"],
  summary: "Cambia muchos precios a la vez (o solo calcula los cambios)",
  description:
    "Sube o baja un porcentaje, o pone una ganancia sobre el costo (exige también cost.view). " +
    "Con apply: false no guarda nada; con apply: true guarda y deja una entrada en la bitácora.",
  request: { body: { content: json(bulkPriceBodySchema), required: true } },
  responses: {
    200: { description: "Cambios", content: json(bulkPriceResultSchema) },
    403: { description: "Falta catalog.manage (o cost.view para la ganancia)", ...err },
    404: { description: "No existe la categoría", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

/** El costo solo lo ve quien tiene cost.view (el cajero no debe ver el margen). */
function withCost<T extends CatalogItem>(item: T, permissions: ReadonlySet<string>): T {
  return permissions.has("cost.view") ? item : { ...item, costMinor: null, costCurrency: null }
}

export function registerCatalogRoutes(app: App, deps: AppDeps): void {
  registerCategoryRoutes(app, deps)
  registerPriceListRoutes(app, deps)
  registerModifierRoutes(app, deps)

  app.openapi(listRoute, (c) => {
    const actor = actorOf(c)
    const q = c.req.valid("query")
    const items = listItems(deps.db, {
      search: q.search,
      includeInactive: q.all === "true",
      now: deps.now(),
    })
    return c.json(
      items.map((i) => withCost(i, actor.permissions)),
      200,
    )
  })

  app.openapi(detailRoute, (c) => {
    const actor = actorOf(c)
    const detail = productDetail(deps.db, c.req.valid("param").id, deps.now())
    const costs = actor.permissions.has("cost.view")
    return c.json(
      {
        ...detail,
        variants: detail.variants.map((v) => withCost(v, actor.permissions)),
        recipe: costs
          ? detail.recipe
          : detail.recipe.map((r) => ({ ...r, costMinor: null, costCurrency: null })),
      },
      200,
    )
  })

  app.openapi(createRouteDef, (c) => {
    const actor = requirePermission(c, "catalog.manage")
    const item = createProduct(deps.db, c.req.valid("json"), actor.userId, deps.now())
    return c.json(withCost(item, actor.permissions), 201)
  })

  app.openapi(bulkPriceRoute, (c) => {
    const actor = requirePermission(c, "catalog.manage")
    const body = c.req.valid("json")
    // El precio sacado del costo deja ver el costo: también hace falta poder verlo.
    if (body.mode === "markup" && !actor.permissions.has("cost.view")) throw forbidden("cost.view")
    return c.json(bulkReprice(deps.db, body, actor.userId, deps.now()), 200)
  })

  app.openapi(updateRoute, (c) => {
    const actor = requirePermission(c, "catalog.manage")
    const { id } = c.req.valid("param")
    const item = updateProduct(deps.db, id, c.req.valid("json"), actor.userId, deps.now())
    return c.json(withCost(item, actor.permissions), 200)
  })
}
