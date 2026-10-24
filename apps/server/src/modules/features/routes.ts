import { createRoute, z } from "@hono/zod-openapi"
import {
  apiErrorSchema,
  type Features,
  featuresSchema,
  type Onboarding,
  onboardingSchema,
  updateFeaturesSchema,
} from "@millhiore/contracts"
import { auditLog, type Db, document, product, user } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, eq, sql } from "drizzle-orm"
import { actorOf, requirePermission } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { rateStatus } from "../rates/service"
import { businessProfile, readSetting, writeSetting } from "../settings/service"

const err = { content: { "application/json": { schema: apiErrorSchema } } }
const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } })

const FEATURES_KEY = "features"
const DISMISSED_KEY = "onboarding.dismissed"

/**
 * Lo que ya existía, encendido mientras el comercio no diga otra cosa (así funcionaban antes de
 * poder apagarlas); varias ubicaciones y lotes, apagadas: la mayoría vende de un solo sitio y
 * no lleva vencimientos.
 */
const DEFAULT_FEATURES: Features = {
  quotes: true,
  priceLists: true,
  charges: true,
  recurring: true,
  payables: true,
  locations: false,
  lots: false,
}

export function features(db: Pick<Db, "select">): Features {
  return { ...DEFAULT_FEATURES, ...(readSetting<Partial<Features>>(db, FEATURES_KEY) ?? {}) }
}

export function updateFeatures(
  db: Db,
  patch: { [K in keyof Features]?: Features[K] | undefined },
  actorId: string,
  now: number,
): Features {
  return db.transaction(
    (tx) => {
      const before = features(tx)
      const after = {
        ...before,
        ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      }
      writeSetting(tx, FEATURES_KEY, after)
      tx.insert(auditLog)
        .values({
          id: uuidv7(now),
          at: now,
          actorId,
          action: "settings.features.updated",
          entityType: "settings",
          entityId: FEATURES_KEY,
          data: { before, after },
        })
        .run()
      return after
    },
    { behavior: "immediate" },
  )
}

/**
 * Los primeros pasos de un comercio recién instalado, cada uno con si ya está hecho. Se calcula
 * con lo que hay en la base: no hace falta marcarlos a mano.
 */
export function onboarding(db: Db, now: number): Onboarding {
  const count = (q: { n: number } | undefined) => q?.n ?? 0
  const products = count(db.select({ n: sql<number>`count(*)` }).from(product).get())
  const users = count(
    db.select({ n: sql<number>`count(*)` }).from(user).where(eq(user.active, true)).get(),
  )
  const sales = count(
    db
      .select({ n: sql<number>`count(*)` })
      .from(document)
      .where(and(eq(document.type, "SALE")))
      .get(),
  )
  const profile = businessProfile(db)
  return {
    dismissed: readSetting<boolean>(db, DISMISSED_KEY) ?? false,
    steps: [
      { id: "business", done: profile.taxId !== null && profile.address !== null },
      { id: "rate", done: !rateStatus(db, now).stale },
      { id: "products", done: products > 0 },
      { id: "users", done: users > 1 },
      { id: "printer", done: readSetting(db, "printer") !== undefined },
      { id: "features", done: readSetting(db, FEATURES_KEY) !== undefined },
      { id: "sale", done: sales > 0 },
    ],
  }
}

const getFeaturesRoute = createRoute({
  method: "get",
  path: "/api/settings/features",
  tags: ["Ajustes"],
  summary: "Funciones que usa el comercio (cotizaciones, listas de precios…)",
  responses: { 200: { description: "Funciones", content: json(featuresSchema) } },
})

const putFeaturesRoute = createRoute({
  method: "put",
  path: "/api/settings/features",
  tags: ["Ajustes"],
  summary: "Enciende o apaga funciones",
  description:
    "Apagar una función la esconde del menú y de la caja; no borra nada de lo ya registrado.",
  request: { body: { content: json(updateFeaturesSchema), required: true } },
  responses: {
    200: { description: "Guardadas", content: json(featuresSchema) },
    403: { description: "Falta settings.manage", ...err },
  },
})

const getOnboardingRoute = createRoute({
  method: "get",
  path: "/api/onboarding",
  tags: ["Ajustes"],
  summary: "Guía para arrancar: los primeros pasos y cuáles faltan",
  responses: {
    200: { description: "Pasos", content: json(onboardingSchema) },
    403: { description: "Falta settings.manage", ...err },
  },
})

const dismissOnboardingRoute = createRoute({
  method: "put",
  path: "/api/onboarding",
  tags: ["Ajustes"],
  summary: "Esconde (o vuelve a mostrar) la guía para arrancar",
  request: {
    body: { content: json(z.object({ dismissed: z.boolean() })), required: true },
  },
  responses: {
    200: { description: "Pasos", content: json(onboardingSchema) },
    403: { description: "Falta settings.manage", ...err },
  },
})

export function registerFeatureRoutes(app: App, deps: AppDeps): void {
  app.openapi(getFeaturesRoute, (c) => {
    actorOf(c)
    return c.json(features(deps.db), 200)
  })

  app.openapi(putFeaturesRoute, (c) => {
    const actor = requirePermission(c, "settings.manage")
    return c.json(updateFeatures(deps.db, c.req.valid("json"), actor.userId, deps.now()), 200)
  })

  app.openapi(getOnboardingRoute, (c) => {
    requirePermission(c, "settings.manage")
    return c.json(onboarding(deps.db, deps.now()), 200)
  })

  app.openapi(dismissOnboardingRoute, (c) => {
    requirePermission(c, "settings.manage")
    writeSetting(deps.db, DISMISSED_KEY, c.req.valid("json").dismissed)
    return c.json(onboarding(deps.db, deps.now()), 200)
  })
}
