import { createRoute, z } from "@hono/zod-openapi"
import { apiErrorSchema, currencyCodeSchema } from "@millhiore/contracts"
import { exchangeRate } from "@millhiore/db"
import { desc, eq } from "drizzle-orm"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { getBusinessPair, rateAt, rateStatus, recordRate, refreshRates } from "./service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const rateSchema = z.object({
  id: z.string(),
  base: z.string(),
  quote: z.string(),
  /** Decimal en texto con 8 cifras. 1 `base` = `value` `quote`. */
  value: z.string(),
  source: z.enum(["bcv", "dolarapi", "manual"]),
  effectiveAt: z.number().int(),
  createdAt: z.number().int(),
})

const lastCheckSchema = z.object({
  at: z.number().int(),
  ok: z.boolean(),
  source: z.string().nullable(),
  error: z.string().nullable(),
  failures: z.array(z.string()),
  rejected: z.array(z.string()),
})

const currentRoute = createRoute({
  method: "get",
  path: "/api/rates/current",
  tags: ["Tasas"],
  summary: "Tasa vigente ahora (por defecto, la del par del negocio)",
  request: {
    query: z.object({ base: currencyCodeSchema.optional(), quote: currencyCodeSchema.optional() }),
  },
  responses: {
    200: { description: "Tasa vigente", content: json(rateSchema) },
    404: { description: "No hay tasa vigente", ...err },
  },
})

const statusRoute = createRoute({
  method: "get",
  path: "/api/rates/status",
  tags: ["Tasas"],
  summary: "Estado de la tasa: vigente, última consulta y si está desactualizada",
  responses: {
    200: {
      description: "Estado",
      content: json(
        z.object({
          pair: z.object({ base: z.string(), quote: z.string() }).nullable(),
          current: rateSchema.nullable(),
          lastCheck: lastCheckSchema.nullable(),
          stale: z.boolean(),
        }),
      ),
    },
  },
})

const historyRoute = createRoute({
  method: "get",
  path: "/api/rates",
  tags: ["Tasas"],
  summary: "Historial de tasas, de la más reciente a la más antigua",
  request: { query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }) },
  responses: { 200: { description: "Historial", content: json(z.array(rateSchema)) } },
})

const manualRoute = createRoute({
  method: "post",
  path: "/api/rates",
  tags: ["Tasas"],
  summary: "Carga una tasa manual (rige desde ahora salvo que se indique otra vigencia)",
  request: {
    body: {
      content: json(
        z.object({
          value: z.string().regex(/^\d{1,12}(\.\d{1,8})?$/, "Tasa inválida"),
          base: currencyCodeSchema.optional(),
          quote: currencyCodeSchema.optional(),
          effectiveAt: z.number().int().positive().optional(),
        }),
      ),
      required: true,
    },
  },
  responses: {
    201: { description: "Guardada", content: json(rateSchema) },
    403: { description: "Falta rate.manage", ...err },
    409: { description: "Ya existe una tasa manual con esa vigencia", ...err },
    422: { description: "Datos inválidos", ...err },
  },
})

const refreshRoute = createRoute({
  method: "post",
  path: "/api/rates/refresh",
  tags: ["Tasas"],
  summary: "Consulta ahora las fuentes oficiales",
  responses: {
    200: {
      description: "Resultado de la consulta",
      content: json(
        z.object({
          ok: z.boolean(),
          source: z.string().nullable(),
          recorded: z.array(
            z.object({ currency: z.string(), value: z.string(), effectiveAt: z.number().int() }),
          ),
          rejected: z.array(z.string()),
          error: z.string().nullable(),
        }),
      ),
    },
    403: { description: "Falta rate.manage", ...err },
  },
})

export function registerRateRoutes(app: App, deps: AppDeps): void {
  app.openapi(currentRoute, (c) => {
    actorOf(c)
    const q = c.req.valid("query")
    const pair = getBusinessPair(deps.db)
    const base = q.base ?? pair?.base
    const quote = q.quote ?? pair?.quote
    const rate = base && quote ? rateAt(deps.db, base, quote, deps.now()) : undefined
    if (!rate) throw new HttpError(404, "NO_RATE", "No hay una tasa de cambio vigente")
    return c.json(rate, 200)
  })

  app.openapi(statusRoute, (c) => {
    actorOf(c)
    return c.json(rateStatus(deps.db, deps.now()), 200)
  })

  app.openapi(historyRoute, (c) => {
    actorOf(c)
    const { limit } = c.req.valid("query")
    const rows = deps.db
      .select()
      .from(exchangeRate)
      .orderBy(desc(exchangeRate.effectiveAt), desc(exchangeRate.createdAt))
      .limit(limit)
      .all()
    return c.json(rows, 200)
  })

  app.openapi(manualRoute, (c) => {
    const actor = requirePermission(c, "rate.manage")
    const body = c.req.valid("json")
    const pair = getBusinessPair(deps.db)
    const base = body.base ?? pair?.base
    const quote = body.quote ?? pair?.quote
    if (!base || !quote || base === quote)
      throw new HttpError(422, "INVALID_PAIR", "Indica un par de monedas válido")
    const now = deps.now()
    const result = recordRate(
      deps.db,
      {
        base,
        quote,
        value: body.value,
        source: "manual",
        effectiveAt: body.effectiveAt ?? now,
        createdBy: actor.userId,
      },
      now,
    )
    if (!result.inserted)
      throw new HttpError(409, "RATE_EXISTS", "Ya hay una tasa manual con esa vigencia")
    const row = deps.db.select().from(exchangeRate).where(eq(exchangeRate.id, result.id)).get()
    if (!row) throw new Error("La tasa recién guardada no se encontró")
    return c.json(row, 201)
  })

  app.openapi(refreshRoute, async (c) => {
    requirePermission(c, "rate.manage")
    const report = await refreshRates(deps.db, {
      now: deps.now(),
      ...(deps.rates?.fetcher ? { fetcher: deps.rates.fetcher } : {}),
      ...(deps.rates?.sources ? { sources: deps.rates.sources } : {}),
    })
    return c.json(report, 200)
  })
}
