import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  dateSchema,
  daySummarySchema,
  inventoryReportSchema,
  reportRangeQuerySchema,
  resultsReportSchema,
  salesReportSchema,
  taxBookQuerySchema,
  taxBookSchema,
} from "@millhiore/contracts"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { inventoryReport, resultsReport, salesReport } from "./period"
import { daySummary } from "./service"
import { taxBook } from "./taxBook"

const err = { content: { "application/json": { schema: apiErrorSchema } } }

const dayRoute = createRoute({
  method: "get",
  path: "/api/reports/day",
  tags: ["Informes"],
  summary: "Resumen del día",
  description:
    "Ventas netas, cobrado por método, ventas por hora, lo más vendido, compras, turnos abiertos y productos por reponer. El día se cuenta en la zona horaria del negocio.",
  request: { query: z.object({ date: dateSchema.optional() }) },
  responses: {
    200: { description: "Resumen", content: { "application/json": { schema: daySummarySchema } } },
    403: { description: "Falta report.view", ...err },
    422: { description: "Fecha inválida", ...err },
  },
})

const rangeResponses = {
  403: { description: "Falta report.view", ...err },
  422: { description: "Rango inválido", ...err },
}

const resultsRoute = createRoute({
  method: "get",
  path: "/api/reports/results",
  tags: ["Informes"],
  summary: "Estado de resultados de un período",
  description:
    "Ventas sin IVA, costo de lo vendido, utilidad bruta, gastos, pérdidas de inventario y comisiones, en moneda legal (cada documento a su tasa). `from`/`to` son milisegundos Unix, `to` excluido. Sin `cost.view`, el costo y las utilidades van vacíos.",
  request: { query: reportRangeQuerySchema },
  responses: {
    200: {
      description: "Resultados",
      content: { "application/json": { schema: resultsReportSchema } },
    },
    ...rangeResponses,
  },
})

const salesRoute = createRoute({
  method: "get",
  path: "/api/reports/sales",
  tags: ["Informes"],
  summary: "Ventas de un período",
  description:
    "Totales, ventas por día, por producto (con utilidad si se ven costos), cobrado por método con su comisión y ventas por vendedor.",
  request: { query: reportRangeQuerySchema },
  responses: {
    200: { description: "Ventas", content: { "application/json": { schema: salesReportSchema } } },
    ...rangeResponses,
  },
})

const taxBookRoute = createRoute({
  method: "get",
  path: "/api/reports/tax-book",
  tags: ["Informes"],
  summary: "Libro de ventas o de compras con el IVA",
  description:
    "Documento por documento (`kind=sales`: ventas, devoluciones y anulaciones; `kind=purchases`: compras y anulaciones), con la base y el IVA de cada alícuota y el IGTF, en moneda legal. Informativo para el contador: las notas de venta no son facturas fiscales y los gastos no entran (se guardan sin separar el IVA).",
  request: { query: taxBookQuerySchema },
  responses: {
    200: { description: "Libro", content: { "application/json": { schema: taxBookSchema } } },
    ...rangeResponses,
  },
})

const inventoryRoute = createRoute({
  method: "get",
  path: "/api/reports/inventory",
  tags: ["Informes"],
  summary: "Inventario valorado",
  description:
    "Existencia, costo y valor de cada producto que lleva inventario, a costo y a precio de venta, en moneda legal a la tasa vigente. Con `locationId`, solo lo que hay en esa ubicación.",
  request: { query: z.object({ locationId: z.string().min(1).optional() }) },
  responses: {
    200: {
      description: "Inventario",
      content: { "application/json": { schema: inventoryReportSchema } },
    },
    403: { description: "Falta report.view e inventory.view", ...err },
  },
})

const checkRange = (from: number, to: number) => {
  if (to <= from) throw new HttpError(422, "INVALID_RANGE", "El período termina antes de empezar")
  // Un rango enorme no aporta y recorre toda la base: dos años como máximo.
  if (to - from > 800 * 86_400_000) {
    throw new HttpError(422, "INVALID_RANGE", "El período no puede pasar de dos años")
  }
}

export function registerReportRoutes(app: App, deps: AppDeps): void {
  app.openapi(resultsRoute, (c) => {
    const actor = requirePermission(c, "report.view")
    const { from, to } = c.req.valid("query")
    checkRange(from, to)
    return c.json(
      resultsReport(deps.db, { from, to, seeCost: actor.permissions.has("cost.view") }),
      200,
    )
  })

  app.openapi(salesRoute, (c) => {
    const actor = requirePermission(c, "report.view")
    const { from, to } = c.req.valid("query")
    checkRange(from, to)
    return c.json(
      salesReport(deps.db, { from, to, seeCost: actor.permissions.has("cost.view") }),
      200,
    )
  })

  app.openapi(taxBookRoute, (c) => {
    requirePermission(c, "report.view")
    const { from, to, kind } = c.req.valid("query")
    checkRange(from, to)
    return c.json(taxBook(deps.db, { kind, from, to }), 200)
  })

  app.openapi(inventoryRoute, (c) => {
    const actor = actorOf(c)
    if (!(actor.permissions.has("report.view") || actor.permissions.has("inventory.view"))) {
      throw new HttpError(403, "FORBIDDEN", "Falta el permiso report.view")
    }
    return c.json(
      inventoryReport(deps.db, {
        now: deps.now(),
        seeCost: actor.permissions.has("cost.view"),
        locationId: c.req.valid("query").locationId,
      }),
      200,
    )
  })

  app.openapi(dayRoute, (c) => {
    const actor = requirePermission(c, "report.view")
    return c.json(
      daySummary(deps.db, {
        date: c.req.valid("query").date,
        now: deps.now(),
        includeStock: actor.permissions.has("inventory.view"),
        seeCost: actor.permissions.has("cost.view"),
      }),
      200,
    )
  })
}
