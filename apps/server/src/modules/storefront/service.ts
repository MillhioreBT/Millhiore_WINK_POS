import type {
  PublicCatalog,
  PublicProduct,
  StorefrontSettings,
  UpdateStorefrontBody,
} from "@millhiore/contracts"
import {
  auditLog,
  branch,
  business,
  category,
  currency,
  type Db,
  location,
  paymentMethod,
  priceList,
  priceListPrice,
  product,
  productImage,
  stockBalance,
  tax,
  variant,
} from "@millhiore/db"
import {
  applyRate,
  compareCombos,
  convert,
  exchangeRate,
  money,
  priceInList,
  uuidv7,
  whatsappNumber,
} from "@millhiore/domain"
import { and, asc, eq, inArray } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { MAIN_BRANCH_ID } from "../branches/service"
import { features } from "../features/routes"
import { rateStatus } from "../rates/service"
import { businessProfile, fiscalSettings, readSetting, writeSetting } from "../settings/service"

const KEY = "storefront"

const DEFAULTS: StorefrontSettings = {
  message: null,
  whatsapp: null,
  priceListId: null,
  currencies: "both",
  soldOut: "mark",
  hiddenCategoryIds: [],
  branchId: MAIN_BRANCH_ID,
  orders: true,
  delivery: true,
}

export function storefrontSettings(db: Pick<Db, "select">): StorefrontSettings {
  return { ...DEFAULTS, ...(readSetting<Partial<StorefrontSettings>>(db, KEY) ?? {}) }
}

export function updateStorefrontSettings(
  db: Db,
  patch: UpdateStorefrontBody,
  actorId: string,
  now: number,
): StorefrontSettings {
  return db.transaction(
    (tx) => {
      const before = storefrontSettings(tx)
      const after: StorefrontSettings = {
        ...before,
        ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      }
      after.message = after.message?.trim() || null
      after.whatsapp = after.whatsapp?.trim() || null
      if (after.whatsapp && !whatsappNumber(after.whatsapp)) {
        throw new HttpError(
          422,
          "INVALID_PHONE",
          "Escribe el WhatsApp con su código, p. ej. 0414-1234567",
        )
      }
      if (patch.priceListId) {
        const list = tx
          .select({ id: priceList.id })
          .from(priceList)
          .where(and(eq(priceList.id, patch.priceListId), eq(priceList.active, true)))
          .get()
        if (!list) {
          throw new HttpError(422, "UNKNOWN_PRICE_LIST", "Lista de precios desconocida o inactiva")
        }
      }
      if (patch.branchId) {
        const b = tx
          .select({ id: branch.id })
          .from(branch)
          .where(and(eq(branch.id, patch.branchId), eq(branch.active, true)))
          .get()
        if (!b) throw new HttpError(422, "UNKNOWN_BRANCH", "Sucursal desconocida o inactiva")
      }
      after.hiddenCategoryIds = [...new Set(after.hiddenCategoryIds)]
      writeSetting(tx, KEY, after)
      tx.insert(auditLog)
        .values({
          id: uuidv7(now),
          at: now,
          actorId,
          action: "settings.storefront.updated",
          entityType: "settings",
          entityId: KEY,
          data: { before, after },
        })
        .run()
      return after
    },
    { behavior: "immediate" },
  )
}

/** El catálogo está encendido: si no, lo público responde que no existe. */
export function requireStorefront(db: Pick<Db, "select">): void {
  if (!features(db).catalog) {
    throw new HttpError(404, "CATALOG_OFF", "Este negocio no tiene el catálogo en línea encendido")
  }
}

interface Visible {
  products: (typeof product.$inferSelect)[]
  categories: { id: string; name: string }[]
}

/**
 * Lo que sale en el catálogo: los productos activos marcados para el catálogo cuya categoría
 * (si tienen) está activa y no se escondió.
 */
function visibleProducts(db: Pick<Db, "select">, settings: StorefrontSettings): Visible {
  const hidden = new Set(settings.hiddenCategoryIds)
  const categories = db
    .select({ id: category.id, name: category.name })
    .from(category)
    .where(eq(category.active, true))
    .orderBy(asc(category.position), asc(category.name))
    .all()
    .filter((c) => !hidden.has(c.id))
  const shown = new Set(categories.map((c) => c.id))
  const products = db
    .select()
    .from(product)
    .where(and(eq(product.active, true), eq(product.inCatalog, true)))
    .orderBy(asc(product.name), asc(product.id))
    .all()
    .filter((p) => p.categoryId === null || shown.has(p.categoryId))
  return { products, categories }
}

/** Una foto sale en público solo si su producto sale en el catálogo. */
export function publicImage(db: Pick<Db, "select">, productId: string) {
  requireStorefront(db)
  const { products } = visibleProducts(db, storefrontSettings(db))
  if (!products.some((p) => p.id === productId)) return undefined
  return db.select().from(productImage).where(eq(productImage.productId, productId)).get()
}

/** Cuántos productos salen en el catálogo y cuántos tienen foto (para la tarjeta de Ajustes). */
export function storefrontCounts(db: Pick<Db, "select">): { products: number; withImage: number } {
  const { products } = visibleProducts(db, storefrontSettings(db))
  const ids = new Set(products.map((p) => p.id))
  const images = db.select({ productId: productImage.productId }).from(productImage).all()
  return { products: ids.size, withImage: images.filter((i) => ids.has(i.productId)).length }
}

/**
 * El catálogo para cualquiera: nombre, descripción, foto y precio para el público (con el IVA,
 * en las dos monedas a la tasa del día) y si hay o no; nunca costos, códigos ni cantidades.
 */
export function publicCatalog(db: Db, now: number): PublicCatalog {
  requireStorefront(db)
  const settings = storefrontSettings(db)
  const profile = businessProfile(db)
  const biz = db.select().from(business).get()
  if (!biz) throw new HttpError(409, "NOT_CONFIGURED", "El negocio aún no está configurado")
  const fiscal = fiscalSettings(db)
  const { products, categories } = visibleProducts(db, settings)
  const productIds = products.map((p) => p.id)

  const variants = productIds.length
    ? db
        .select()
        .from(variant)
        .where(and(inArray(variant.productId, productIds), eq(variant.active, true)))
        .orderBy(asc(variant.createdAt), asc(variant.id))
        .all()
    : []
  const variantIds = variants.map((v) => v.id)

  // La lista del catálogo, si sigue activa; si no, el precio normal.
  const list = settings.priceListId
    ? db
        .select()
        .from(priceList)
        .where(and(eq(priceList.id, settings.priceListId), eq(priceList.active, true)))
        .get()
    : undefined
  const rule = list
    ? {
        adjustBp: list.adjustBp,
        prices: new Map(
          db
            .select()
            .from(priceListPrice)
            .where(eq(priceListPrice.priceListId, list.id))
            .all()
            .map((p) => [
              p.variantId,
              { priceMinor: p.priceMinor, priceCurrency: p.priceCurrency },
            ]),
        ),
      }
    : null

  // Lo que hay en las ubicaciones de la sucursal del catálogo (o en todas, sin sucursales).
  const stock = new Map<string, number>()
  if (settings.soldOut !== "ignore" && variantIds.length) {
    const branchLocations = features(db).branches
      ? db
          .select({ id: location.id })
          .from(location)
          .where(eq(location.branchId, settings.branchId))
          .all()
          .map((l) => l.id)
      : null
    const balances = db
      .select()
      .from(stockBalance)
      .where(
        and(
          inArray(stockBalance.variantId, variantIds),
          branchLocations ? inArray(stockBalance.locationId, branchLocations) : undefined,
        ),
      )
      .all()
    for (const b of balances) stock.set(b.variantId, (stock.get(b.variantId) ?? 0) + b.qtyMilli)
  }

  const taxes = new Map(
    db
      .select()
      .from(tax)
      .all()
      .map((t) => [t.id, t]),
  )
  const decimals = new Map(
    db
      .select()
      .from(currency)
      .all()
      .map((c) => [c.code, c.decimals]),
  )
  const pair = {
    base: { code: biz.referenceCurrency, decimals: decimals.get(biz.referenceCurrency) ?? 2 },
    quote: { code: biz.legalCurrency, decimals: decimals.get(biz.legalCurrency) ?? 2 },
  }
  const current = rateStatus(db, now).current
  const rate = current ? exchangeRate(current.base, current.quote, current.value) : null
  const inCurrency = (amountMinor: number, from: string, to: string): number | null => {
    if (from === to) return amountMinor
    if (!rate) return null
    return convert(money(amountMinor, from), rate, pair).amountMinor
  }

  const images = new Map(
    (productIds.length
      ? db
          .select({ productId: productImage.productId, v: productImage.updatedAt })
          .from(productImage)
          .where(inArray(productImage.productId, productIds))
          .all()
      : []
    ).map((i) => [i.productId, i.v]),
  )

  const byProduct = new Map<string, typeof variants>()
  for (const v of variants) {
    const own = byProduct.get(v.productId)
    if (own) own.push(v)
    else byProduct.set(v.productId, [v])
  }

  const result: PublicProduct[] = []
  for (const p of products) {
    const own = byProduct.get(p.id) ?? []
    if (p.options)
      own.sort((a, b) => compareCombos(p.options ?? [], a.optionValues, b.optionValues))
    const taxRow = taxes.get(p.taxId ?? fiscal.defaultTaxId)
    const out = own
      .map((v) => {
        const listed = priceInList(
          v.id,
          { priceMinor: v.priceMinor, priceCurrency: v.priceCurrency },
          rule,
        )
        // Lo que paga el cliente: si los precios van sin IVA, se le suma.
        const gross =
          fiscal.pricesIncludeTax || taxRow?.kind !== "taxed"
            ? listed.priceMinor
            : listed.priceMinor + applyRate(listed.priceMinor, taxRow.rateBp)
        const available =
          settings.soldOut === "ignore" || !p.tracksStock || (stock.get(v.id) ?? 0) > 0
        return {
          id: v.id,
          optionValues: p.options ? v.optionValues : null,
          referenceMinor: inCurrency(gross, listed.priceCurrency, biz.referenceCurrency),
          legalMinor: inCurrency(gross, listed.priceCurrency, biz.legalCurrency),
          available,
        }
      })
      .filter((v) => settings.soldOut !== "hide" || v.available)
    if (out.length === 0) continue
    const version = images.get(p.id)
    result.push({
      id: p.id,
      name: p.name,
      description: p.description,
      categoryId: p.categoryId,
      unit: p.unit,
      imageUrl: version ? `/api/public/catalog/images/${p.id}?v=${version}` : null,
      options: p.options,
      variants: out,
    })
  }

  const used = new Set(result.map((p) => p.categoryId))
  return {
    business: { name: profile.name, address: profile.address, phone: profile.phone },
    message: settings.message,
    whatsapp: whatsappNumber(settings.whatsapp ?? profile.phone),
    currencies: settings.currencies,
    referenceCurrency: biz.referenceCurrency,
    legalCurrency: biz.legalCurrency,
    rate: current ? { value: current.value, effectiveAt: current.effectiveAt } : null,
    categories: categories.filter((c) => used.has(c.id)),
    products: result,
    orders: settings.orders
      ? {
          delivery: settings.delivery,
          payments: db
            .select({ name: paymentMethod.name })
            .from(paymentMethod)
            .where(eq(paymentMethod.active, true))
            .orderBy(asc(paymentMethod.name))
            .all()
            .map((m) => m.name),
        }
      : null,
  }
}
