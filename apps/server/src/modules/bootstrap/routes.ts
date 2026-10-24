import { createRoute } from "@hono/zod-openapi"
import { apiErrorSchema, type Bootstrap, bootstrapSchema } from "@millhiore/contracts"
import {
  account,
  business,
  currency,
  type Db,
  discountCode,
  paymentMethod,
  surcharge,
  tax,
  terminal,
} from "@millhiore/db"
import { asc, eq, sql } from "drizzle-orm"
import { actorOf } from "../../http/actor"
import type { App, AppDeps } from "../../http/context"
import { HttpError } from "../../http/errors"
import { priceListsForPos } from "../catalog/priceLists"
import { chargesForPos } from "../charges/routes"
import { features } from "../features/routes"
import { listLocations } from "../locations/routes"
import { printerSettings } from "../printing/service"
import {
  autoLockMinutes,
  businessProfile,
  creditEnabled,
  fiscalSettings,
} from "../settings/service"

const KIND_ORDER = { cash: 0, mobile: 1, bank: 2, wallet: 3 } as const

/** Todo lo que la caja necesita para arrancar: negocio, cajas, monedas, métodos, impuestos. */
export function bootstrap(db: Db): Bootstrap {
  const biz = db.select().from(business).get()
  if (!biz) throw new HttpError(409, "NOT_CONFIGURED", "El negocio aún no está configurado")
  const methods = db
    .select({
      id: paymentMethod.id,
      name: paymentMethod.name,
      accountId: account.id,
      currency: account.currency,
      kind: account.kind,
      requiresReference: paymentMethod.requiresReference,
      surchargeId: surcharge.id,
      surchargeName: surcharge.name,
      surchargeRateBp: surcharge.rateBp,
      surchargeActive: surcharge.active,
    })
    .from(paymentMethod)
    .innerJoin(account, eq(account.id, paymentMethod.accountId))
    .leftJoin(surcharge, eq(surcharge.id, paymentMethod.surchargeId))
    .where(eq(paymentMethod.active, true))
    .orderBy(asc(paymentMethod.id))
    .all()
  const profile = businessProfile(db)
  return {
    business: {
      name: biz.name,
      referenceCurrency: biz.referenceCurrency,
      legalCurrency: biz.legalCurrency,
      timezone: biz.timezone,
      taxId: profile.taxId,
      address: profile.address,
      phone: profile.phone,
      receiptFooter: profile.receiptFooter,
    },
    terminals: db
      .select({
        id: terminal.id,
        code: terminal.code,
        name: terminal.name,
        locationId: terminal.locationId,
      })
      .from(terminal)
      .where(eq(terminal.active, true))
      .orderBy(asc(terminal.code))
      .all(),
    locations: listLocations(db).map(({ id, name, kind }) => ({ id, name, kind })),
    discountCodes:
      db
        .select({ n: sql<number>`count(*)` })
        .from(discountCode)
        .where(eq(discountCode.active, true))
        .get()?.n ?? 0,
    currencies: db.select().from(currency).orderBy(asc(currency.code)).all(),
    // Orden estable para la caja: efectivo (Bs primero), pago móvil, punto de venta, billeteras.
    paymentMethods: methods
      .sort(
        (a, b) =>
          KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
          Number(b.currency === biz.legalCurrency) - Number(a.currency === biz.legalCurrency) ||
          a.name.localeCompare(b.name, "es"),
      )
      .map((m) => ({
        id: m.id,
        name: m.name,
        accountId: m.accountId,
        currency: m.currency,
        kind: m.kind,
        requiresReference: m.requiresReference,
        surcharge:
          m.surchargeId && m.surchargeActive && m.surchargeName !== null
            ? { id: m.surchargeId, name: m.surchargeName, rateBp: m.surchargeRateBp ?? 0 }
            : null,
      })),
    taxes: db.select().from(tax).orderBy(asc(tax.code)).all(),
    fiscal: fiscalSettings(db),
    credit: { enabled: creditEnabled(db) },
    features: features(db),
    priceLists: priceListsForPos(db),
    charges: chargesForPos(db),
    security: { autoLockMinutes: autoLockMinutes(db) },
    printer: (({ mode, paperWidth, autoPrint, openDrawer }) => ({
      mode,
      paperWidth,
      autoPrint,
      openDrawer,
    }))(printerSettings(db)),
  }
}

const route = createRoute({
  method: "get",
  path: "/api/bootstrap",
  tags: ["Caja"],
  summary: "Datos para arrancar la caja: negocio, cajas, monedas, métodos de cobro e impuestos",
  responses: {
    200: { description: "Datos", content: { "application/json": { schema: bootstrapSchema } } },
    409: {
      description: "Negocio sin configurar",
      content: { "application/json": { schema: apiErrorSchema } },
    },
  },
})

export function registerBootstrapRoutes(app: App, deps: AppDeps): void {
  app.openapi(route, (c) => {
    actorOf(c)
    return c.json(bootstrap(deps.db), 200)
  })
}
