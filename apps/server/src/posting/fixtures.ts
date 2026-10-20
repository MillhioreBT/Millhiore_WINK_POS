import {
  account,
  business,
  createDb,
  type Db,
  IGTF_SURCHARGE,
  location,
  migrateDb,
  paymentMethod,
  product,
  seedCurrencies,
  seedTaxes,
  terminal,
  variant,
} from "@millhiore/db"
import { exchangeRate } from "@millhiore/domain"
import type { PostContext } from "./post"

export const RATE = exchangeRate("USD", "VES", "36.5")

export const ids = {
  location: "loc-1",
  terminal: "term-1",
  cashUsd: "acc-cash-usd",
  cashVes: "acc-cash-ves",
  mobileVes: "acc-mobile-ves",
  zelle: "acc-zelle",
  methodUsd: "pm-usd",
  methodVes: "pm-ves",
  methodMobile: "pm-mobile",
  /** Zelle (USD) con IGTF. */
  methodZelle: "pm-zelle",
  /** Pan: exento de IVA. */
  bread: "var-bread",
  /** Agua: IVA general (impuesto por defecto). */
  water: "var-water",
  /** Delivery: servicio con IVA general. */
  delivery: "var-delivery",
} as const

export const ctx = (
  over: Partial<Omit<PostContext, "fiscal">> & { fiscal?: Partial<PostContext["fiscal"]> } = {},
): PostContext => ({
  now: 1_760_000_000_000,
  actorId: null,
  allowNegativeStock: true,
  requireShift: false,
  creditEnabled: true,
  ...over,
  fiscal: {
    taxpayer: "special",
    pricesIncludeTax: true,
    defaultTaxId: "iva-general",
    ...over.fiscal,
  },
})

/** Base en memoria con migraciones, monedas y un negocio mínimo (bodega con una caja). */
export function createTestDb(): Db {
  const db = createDb(":memory:")
  migrateDb(db)
  seedCurrencies(db)
  seedTaxes(db)
  const now = 1_760_000_000_000

  db.insert(business)
    .values({
      id: "biz",
      name: "Bodega de prueba",
      referenceCurrency: "USD",
      legalCurrency: "VES",
      createdAt: now,
    })
    .run()
  db.insert(location)
    .values({ id: ids.location, businessId: "biz", name: "Tienda", kind: "store" })
    .run()
  db.insert(terminal)
    .values({ id: ids.terminal, locationId: ids.location, code: "C1", name: "Caja 1" })
    .run()

  db.insert(account)
    .values([
      { id: ids.cashUsd, name: "Caja USD", kind: "cash", currency: "USD" },
      { id: ids.cashVes, name: "Caja Bs", kind: "cash", currency: "VES" },
      { id: ids.mobileVes, name: "Pago móvil", kind: "mobile", currency: "VES" },
      { id: ids.zelle, name: "Zelle", kind: "wallet", currency: "USD" },
    ])
    .run()
  db.insert(paymentMethod)
    .values([
      { id: ids.methodUsd, name: "Efectivo USD", accountId: ids.cashUsd },
      { id: ids.methodVes, name: "Efectivo Bs", accountId: ids.cashVes },
      {
        id: ids.methodMobile,
        name: "Pago móvil",
        accountId: ids.mobileVes,
        requiresReference: true,
      },
      {
        id: ids.methodZelle,
        name: "Zelle",
        accountId: ids.zelle,
        surchargeId: IGTF_SURCHARGE.id,
      },
    ])
    .run()

  db.insert(product)
    .values([
      {
        id: "p-bread",
        name: "Pan",
        kind: "good",
        tracksStock: true,
        taxId: "exento",
        createdAt: now,
      },
      { id: "p-water", name: "Agua", kind: "good", tracksStock: true, createdAt: now },
      { id: "p-delivery", name: "Delivery", kind: "service", tracksStock: false, createdAt: now },
    ])
    .run()
  db.insert(variant)
    .values([
      {
        id: ids.bread,
        productId: "p-bread",
        sku: "PAN",
        name: "Pan",
        priceMinor: 150,
        priceCurrency: "USD",
        createdAt: now,
      },
      {
        id: ids.water,
        productId: "p-water",
        sku: "AGUA",
        name: "Agua",
        priceMinor: 100,
        priceCurrency: "USD",
        createdAt: now,
      },
      {
        id: ids.delivery,
        productId: "p-delivery",
        sku: "DLV",
        name: "Delivery",
        priceMinor: 300,
        priceCurrency: "USD",
        createdAt: now,
      },
    ])
    .run()
  return db
}
