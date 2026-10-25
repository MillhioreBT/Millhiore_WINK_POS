import type {
  CatalogItem,
  CreateProductBody,
  ProductDetail,
  UpdateProductBody,
  VariantInput,
} from "@millhiore/contracts"
import {
  auditLog,
  business,
  currency,
  type Db,
  lot,
  lotBalance,
  product,
  stockBalance,
  tax,
  variant,
} from "@millhiore/db"
import {
  combinations,
  comboKey,
  compareCombos,
  localDate,
  optionsProblem,
  type ProductOption,
  uuidv7,
  variantName,
} from "@millhiore/domain"
import { and, asc, eq, gt, inArray, like, or, type SQL, sql } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { requireActiveCategory } from "./categories"
import { modifierGroupIdsByProduct, setProductModifierGroups } from "./modifiers"
import { setListPrices } from "./priceLists"
import { productsWithRecipe, recipeOf, setRecipe } from "./recipes"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

const itemColumns = {
  productId: product.id,
  variantId: variant.id,
  name: variant.name,
  productName: product.name,
  optionValues: variant.optionValues,
  options: product.options,
  kind: product.kind,
  sku: variant.sku,
  barcode: variant.barcode,
  priceMinor: variant.priceMinor,
  priceCurrency: variant.priceCurrency,
  taxId: product.taxId,
  categoryId: product.categoryId,
  tracksStock: product.tracksStock,
  tracksLots: product.tracksLots,
  productActive: product.active,
  variantActive: variant.active,
  costMinor: variant.costMinor,
  costCurrency: variant.costCurrency,
  stockMilli: sql<number>`coalesce((select sum(${stockBalance.qtyMilli}) from ${stockBalance}
    where ${stockBalance.variantId} = ${variant.id}), 0)`,
  minStockMilli: variant.minStockMilli,
}

type Row = Omit<CatalogItem, "stockByLocation" | "expiry"> & { variantActive: boolean }

/**
 * Las variantes de cada producto, juntas y en el orden de la cuadrícula (S azul, S negro, M
 * azul…); los productos, en el orden en que vienen.
 */
function selectRows(db: Db | Tx, where: SQL | undefined): Row[] {
  const rows = db
    .select(itemColumns)
    .from(product)
    .innerJoin(variant, eq(variant.productId, product.id))
    .where(where)
    .orderBy(asc(product.name), asc(product.id), asc(variant.createdAt), asc(variant.id))
    .all()
  const modifierGroups = modifierGroupIdsByProduct(
    db,
    rows.length ? [...new Set(rows.map((r) => r.productId))] : [],
  )
  const withRecipe = productsWithRecipe(db)
  const groups = new Map<string, Row[]>()
  for (const { productActive, ...r } of rows) {
    const row = {
      ...r,
      active: productActive && r.variantActive,
      modifierGroupIds: modifierGroups.get(r.productId) ?? [],
      hasRecipe: withRecipe.has(r.productId),
    }
    const group = groups.get(r.productId)
    if (group) group.push(row)
    else groups.set(r.productId, [row])
  }
  return [...groups.values()].flatMap((group) => {
    const options = group[0]?.options
    // Sin tallas ni colores, primero la que se vende (las demás quedaron de cuando las tenía).
    return group.sort((a, b) =>
      options
        ? compareCombos(options, a.optionValues, b.optionValues)
        : Number(b.variantActive) - Number(a.variantActive),
    )
  })
}

/**
 * Agrega a cada producto lo que hay en cada ubicación (la caja vende de la suya) y, si lleva
 * lotes, su próximo vencimiento y lo vencido en cada ubicación.
 */
function withStock<T extends Row>(
  db: Db | Tx,
  rows: T[],
  now: number,
): (T & Pick<CatalogItem, "stockByLocation" | "expiry">)[] {
  const ids = rows.map((r) => r.variantId)
  const byVariant = new Map<string, Record<string, number>>()
  const balances =
    ids.length === 0
      ? []
      : db
          .select()
          .from(stockBalance)
          .where(ids.length > 500 ? undefined : inArray(stockBalance.variantId, ids))
          .all()
  for (const b of balances) {
    const entry = byVariant.get(b.variantId) ?? {}
    entry[b.locationId] = b.qtyMilli
    byVariant.set(b.variantId, entry)
  }
  const withLots = rows.filter((r) => r.tracksLots).map((r) => r.variantId)
  const lots =
    withLots.length === 0
      ? []
      : db
          .select({
            variantId: lot.variantId,
            expiresOn: lot.expiresOn,
            locationId: lotBalance.locationId,
            qtyMilli: lotBalance.qtyMilli,
          })
          .from(lotBalance)
          .innerJoin(lot, eq(lot.id, lotBalance.lotId))
          .where(
            and(
              gt(lotBalance.qtyMilli, 0),
              withLots.length > 500 ? undefined : inArray(lot.variantId, withLots),
            ),
          )
          .all()
  const tz = db.select({ tz: business.timezone }).from(business).get()?.tz ?? "America/Caracas"
  const today = localDate(now, tz)
  const expiryOf = (variantId: string): CatalogItem["expiry"] => {
    const own = lots.filter((l) => l.variantId === variantId)
    const expiredByLocation: Record<string, number> = {}
    let nextExpiresOn: string | null = null
    for (const l of own) {
      if (l.expiresOn === null) continue
      if (l.expiresOn < today) {
        expiredByLocation[l.locationId] = (expiredByLocation[l.locationId] ?? 0) + l.qtyMilli
      } else if (nextExpiresOn === null || l.expiresOn < nextExpiresOn) {
        nextExpiresOn = l.expiresOn
      }
    }
    return { nextExpiresOn, expiredByLocation }
  }
  return rows.map((r) => ({
    ...r,
    stockByLocation: byVariant.get(r.variantId) ?? {},
    expiry: r.tracksLots ? expiryOf(r.variantId) : null,
  }))
}

const toItem = ({
  variantActive: _,
  ...item
}: Row & Pick<CatalogItem, "stockByLocation" | "expiry">) => item

/**
 * Lo que se vende, una fila por variante (cada talla y color de un producto), ordenado por
 * nombre y, dentro de cada producto, como su cuadrícula.
 */
export function listItems(
  db: Db | Tx,
  opts: {
    search?: string | undefined
    /** También los productos y las variantes desactivados. */
    includeInactive?: boolean | undefined
    /** Para saber qué lotes ya vencieron. */
    now?: number | undefined
  } = {},
): CatalogItem[] {
  const term = opts.search?.trim()
  const filters = [
    opts.includeInactive ? undefined : and(eq(product.active, true), eq(variant.active, true)),
    term
      ? or(
          like(product.name, `%${term}%`),
          like(variant.name, `%${term}%`),
          eq(variant.sku, term),
          eq(variant.barcode, term),
        )
      : undefined,
  ].filter((f) => f !== undefined)
  return withStock(
    db,
    selectRows(db, filters.length ? and(...filters) : undefined),
    opts.now ?? Date.now(),
  ).map(toItem)
}

/** El producto con todas sus variantes (también las desactivadas), en orden. */
export function productDetail(db: Db | Tx, productId: string, now: number): ProductDetail {
  const p = db.select().from(product).where(eq(product.id, productId)).get()
  if (!p) throw new HttpError(404, "NOT_FOUND", `No existe el producto ${productId}`)
  return {
    productId: p.id,
    name: p.name,
    kind: p.kind,
    taxId: p.taxId,
    categoryId: p.categoryId,
    tracksStock: p.tracksStock,
    tracksLots: p.tracksLots,
    active: p.active,
    options: p.options,
    variants: withStock(db, selectRows(db, eq(product.id, productId)), now),
    recipe: recipeOf(db, productId),
  }
}

/** La variante que representa al producto: la primera que se vende (o la primera, si ninguna). */
function itemById(db: Db | Tx, productId: string, now = Date.now()): CatalogItem {
  const rows = selectRows(db, eq(product.id, productId))
  const row = rows.find((r) => r.variantActive) ?? rows[0]
  if (!row) throw new HttpError(404, "NOT_FOUND", `No existe el producto ${productId}`)
  const [item] = withStock(db, [row], now).map(toItem)
  return item ?? { ...row, stockByLocation: {}, expiry: null }
}

/** Lo que queda en la bitácora: el producto o, si tiene tallas y colores, con todas ellas. */
function snapshot(db: Db | Tx, productId: string, now: number): unknown {
  const detail = productDetail(db, productId, now)
  return detail.options ? detail : itemById(db, productId, now)
}

function checkReferences(
  tx: Tx,
  input: { taxId?: string | null; priceCurrency?: string; categoryId?: string | null },
) {
  if (input.categoryId) requireActiveCategory(tx, input.categoryId)
  if (input.taxId) {
    const t = tx.select().from(tax).where(eq(tax.id, input.taxId)).get()
    if (!t?.active) throw new HttpError(422, "UNKNOWN_TAX", `Impuesto desconocido: ${input.taxId}`)
  }
  if (input.priceCurrency) {
    const c = tx.select().from(currency).where(eq(currency.code, input.priceCurrency)).get()
    if (!c)
      throw new HttpError(422, "UNKNOWN_CURRENCY", `Moneda desconocida: ${input.priceCurrency}`)
  }
}

/** SKU legible cuando no se indica: P00001, P00002… */
function nextSku(tx: Tx): string {
  const n = tx.all<{ n: number }>(sql`select count(*) as n from variant`)[0]?.n ?? 0
  for (let i = n + 1; ; i++) {
    const sku = `P${String(i).padStart(5, "0")}`
    if (!tx.select({ id: variant.id }).from(variant).where(eq(variant.sku, sku)).get()) return sku
  }
}

/** SKU de una combinación sin código propio: el del producto con un número, P00012-1, P00012-2… */
function nextVariantSku(tx: Tx, base: string, taken: Set<string>): string {
  for (let i = 1; ; i++) {
    const sku = `${base}-${i}`
    if (taken.has(sku)) continue
    if (!tx.select({ id: variant.id }).from(variant).where(eq(variant.sku, sku)).get()) {
      taken.add(sku)
      return sku
    }
  }
}

/** SQLite rechaza SKU o código de barras repetidos con UNIQUE: se traduce a un 409 claro. */
function duplicateCode(e: unknown): never {
  const text = String((e as Error).cause ?? (e as Error).message)
  if (/UNIQUE/i.test(text)) {
    const field = /barcode/.test(text) ? "código de barras" : "SKU"
    throw new HttpError(409, "DUPLICATE_CODE", `Ya existe otro producto con ese ${field}`)
  }
  throw e
}

const invalidOptions = (message: string) => new HttpError(422, "INVALID_OPTIONS", message)

/** Valida las características y deja cada combinación con los valores tal como están escritos. */
function checkOptions(options: readonly ProductOption[]): void {
  const problem = optionsProblem(options)
  if (problem) throw invalidOptions(problem)
}

/**
 * Valida las combinaciones contra las características: un valor de cada una, de los que tiene, y
 * sin repetirse. Devuelve los valores escritos como en las características (mayúsculas incluidas).
 */
function checkCombos(options: readonly ProductOption[], variants: readonly VariantInput[]) {
  const seen = new Set<string>()
  return variants.map((v) => {
    if (v.values.length !== options.length) {
      throw invalidOptions(
        `Cada combinación lleva un valor de cada característica (${options.map((o) => o.name).join(", ")})`,
      )
    }
    const values = v.values.map((value, i) => {
      const match = options[i]?.values.find((x) => comboKey([x]) === comboKey([value]))
      if (match === undefined) {
        throw invalidOptions(`«${value}» no es un valor de «${options[i]?.name}»`)
      }
      return match
    })
    const key = comboKey(values)
    if (seen.has(key)) throw invalidOptions(`La combinación ${values.join(", ")} está repetida`)
    seen.add(key)
    return { ...v, values }
  })
}

function audit(tx: Tx, actorId: string, now: number, action: string, id: string, data: unknown) {
  tx.insert(auditLog)
    .values({
      id: uuidv7(now),
      at: now,
      actorId,
      action,
      entityType: "product",
      entityId: id,
      data,
    })
    .run()
}

export function createProduct(
  db: Db,
  input: CreateProductBody,
  actorId: string,
  now: number,
): CatalogItem {
  return db.transaction(
    (tx) => {
      checkReferences(tx, {
        ...(input.taxId ? { taxId: input.taxId } : {}),
        ...(input.categoryId ? { categoryId: input.categoryId } : {}),
        priceCurrency: input.priceCurrency,
      })
      if (input.tracksLots && input.kind !== "good") {
        throw new HttpError(422, "INVALID_LOTS", "Un servicio no lleva lotes")
      }
      const options = input.options?.length ? input.options : null
      if (options) {
        checkOptions(options)
        if (input.barcode) {
          throw invalidOptions("Cada combinación lleva su propio código de barras")
        }
      } else if (input.variants?.length) {
        throw invalidOptions("Para crear combinaciones, indica las tallas, colores…")
      }
      const variants = options
        ? checkCombos(
            options,
            input.variants ??
              combinations(options).map((values) => ({
                values,
                priceMinor: input.priceMinor,
                active: true,
              })),
          )
        : [
            {
              values: [] as string[],
              sku: input.sku,
              barcode: input.barcode,
              priceMinor: input.priceMinor,
              active: true,
              id: undefined,
            },
          ]
      if (variants.length === 0) throw invalidOptions("Deja al menos una combinación")
      if (variants.some((v) => v.id)) {
        throw invalidOptions("Un producto nuevo no tiene combinaciones que editar")
      }
      const productId = uuidv7(now)
      const variantIds: string[] = []
      try {
        tx.insert(product)
          .values({
            id: productId,
            name: input.name,
            kind: input.kind,
            tracksStock: input.kind === "good",
            tracksLots: input.kind === "good" && input.tracksLots,
            taxId: input.taxId ?? null,
            categoryId: input.categoryId ?? null,
            options,
            createdAt: now,
          })
          .run()
        const base = options ? (input.sku ?? nextSku(tx)) : null
        const taken = new Set<string>()
        for (const v of variants) {
          const variantId = uuidv7(now)
          variantIds.push(variantId)
          tx.insert(variant)
            .values({
              id: variantId,
              productId,
              sku: v.sku ?? (base ? nextVariantSku(tx, base, taken) : nextSku(tx)),
              barcode: v.barcode ?? null,
              name: variantName(input.name, options ? v.values : null),
              optionValues: options ? v.values : null,
              priceMinor: v.priceMinor,
              priceCurrency: input.priceCurrency,
              minStockMilli: input.kind === "good" ? (input.minStockMilli ?? null) : null,
              active: v.active,
              createdAt: now,
            })
            .run()
        }
      } catch (e) {
        duplicateCode(e)
      }
      if (input.modifierGroupIds?.length) {
        setProductModifierGroups(tx, productId, input.modifierGroupIds)
      }
      if (input.recipe?.length) setRecipe(tx, productId, input.recipe)
      let listPrices: Record<string, number | null> | undefined
      if (input.listPrices?.length) {
        for (const variantId of variantIds) {
          listPrices = setListPrices(tx, variantId, input.priceCurrency, input.listPrices).after
        }
      }
      const item = itemById(tx, productId, now)
      const data = options ? productDetail(tx, productId, now) : item
      audit(tx, actorId, now, "product.created", productId, { ...data, listPrices })
      return item
    },
    { behavior: "immediate" },
  )
}

/**
 * Edita el producto y sus variantes. Con tallas y colores, los datos del producto (nombre, IVA,
 * moneda, mínimo, precios por lista) valen para todas; el código y el precio, para cada una. Los
 * cambios quedan en la auditoría.
 */
export function updateProduct(
  db: Db,
  productId: string,
  patch: UpdateProductBody,
  actorId: string,
  now: number,
): CatalogItem {
  return db.transaction(
    (tx) => {
      const current = tx.select().from(product).where(eq(product.id, productId)).get()
      if (!current) throw new HttpError(404, "NOT_FOUND", `No existe el producto ${productId}`)
      const before = snapshot(tx, productId, now)
      checkReferences(tx, {
        ...(patch.taxId ? { taxId: patch.taxId } : {}),
        ...(patch.categoryId ? { categoryId: patch.categoryId } : {}),
        ...(patch.priceCurrency ? { priceCurrency: patch.priceCurrency } : {}),
      })
      if (patch.tracksLots && !current.tracksStock) {
        throw new HttpError(422, "INVALID_LOTS", "Un servicio no lleva lotes")
      }
      const replacing = patch.options !== undefined
      const options = replacing ? (patch.options?.length ? patch.options : null) : current.options
      if (replacing && patch.variants === undefined) {
        throw invalidOptions("Indica las combinaciones que se siguen vendiendo")
      }
      if (options) {
        checkOptions(options)
        if (patch.sku !== undefined || patch.barcode) {
          throw invalidOptions("Cada combinación lleva su propio código")
        }
      }
      const name = patch.name ?? current.name
      const existing = tx.select().from(variant).where(eq(variant.productId, productId)).all()
      const byId = new Map(existing.map((v) => [v.id, v]))

      const productSet = {
        ...(patch.tracksLots !== undefined ? { tracksLots: patch.tracksLots } : {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.taxId !== undefined ? { taxId: patch.taxId } : {}),
        ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        ...(replacing ? { options } : {}),
      }
      // Lo que vale para todas las variantes del producto.
      const shared = {
        ...(patch.priceCurrency !== undefined ? { priceCurrency: patch.priceCurrency } : {}),
        ...(patch.minStockMilli !== undefined && current.tracksStock
          ? { minStockMilli: patch.minStockMilli }
          : {}),
      }

      try {
        if (Object.keys(productSet).length) {
          tx.update(product).set(productSet).where(eq(product.id, productId)).run()
        }
        if (Object.keys(shared).length) {
          tx.update(variant).set(shared).where(eq(variant.productId, productId)).run()
        }
        if (options) {
          editVariants(tx, {
            productId,
            name,
            options,
            replacing,
            current: existing,
            byId,
            patch,
            now,
          })
        } else {
          editSingle(tx, { name, replacing, existing, byId, patch })
        }
        // El nombre de cada variante sigue al del producto (también el de las desactivadas).
        if (patch.name !== undefined) {
          const rows = tx
            .select({ id: variant.id, optionValues: variant.optionValues })
            .from(variant)
            .where(eq(variant.productId, productId))
            .all()
          for (const v of rows) {
            tx.update(variant)
              .set({ name: variantName(name, v.optionValues) })
              .where(eq(variant.id, v.id))
              .run()
          }
        }
      } catch (e) {
        duplicateCode(e)
      }

      // Los precios propios por lista van en la moneda del precio (la nueva, si cambió).
      let listPrices: ReturnType<typeof setListPrices> | undefined
      if (patch.listPrices?.length) {
        const targets = tx
          .select({ id: variant.id, priceCurrency: variant.priceCurrency })
          .from(variant)
          .where(and(eq(variant.productId, productId), eq(variant.active, true)))
          .all()
        for (const t of targets) {
          listPrices = setListPrices(tx, t.id, t.priceCurrency, patch.listPrices)
        }
      }
      if (patch.modifierGroupIds !== undefined) {
        setProductModifierGroups(tx, productId, patch.modifierGroupIds)
      }
      if (patch.recipe !== undefined) setRecipe(tx, productId, patch.recipe)
      const after = snapshot(tx, productId, now)
      audit(tx, actorId, now, "product.updated", productId, {
        before: listPrices ? { ...(before as object), listPrices: listPrices.before } : before,
        after: listPrices ? { ...(after as object), listPrices: listPrices.after } : after,
      })
      return itemById(tx, productId, now)
    },
    { behavior: "immediate" },
  )
}

type VariantRow = typeof variant.$inferSelect

/** Producto que se vende de una sola forma (o deja de tener tallas y colores). */
function editSingle(
  tx: Tx,
  ctx: {
    name: string
    replacing: boolean
    existing: VariantRow[]
    byId: Map<string, VariantRow>
    patch: UpdateProductBody
  },
) {
  const { patch, existing, byId } = ctx
  let target: VariantRow | undefined
  if (ctx.replacing) {
    // Sin tallas ni colores queda una sola variante: la indicada o la primera que se vendía.
    const [only, ...rest] = patch.variants ?? []
    if (!only || rest.length) {
      throw invalidOptions("Sin tallas ni colores, el producto se vende de una sola forma")
    }
    if (only.values.length) throw invalidOptions("Sin características, la combinación va vacía")
    target = only.id ? byId.get(only.id) : (existing.find((v) => v.active) ?? existing[0])
    if (!target) throw new HttpError(422, "UNKNOWN_VARIANT", "Esa combinación no es del producto")
    for (const v of existing) {
      if (v.id !== target.id && v.active) {
        tx.update(variant).set({ active: false }).where(eq(variant.id, v.id)).run()
      }
    }
    tx.update(variant)
      .set({
        optionValues: null,
        name: ctx.name,
        active: true,
        priceMinor: only.priceMinor,
        ...(only.sku !== undefined ? { sku: only.sku } : {}),
        ...(only.barcode !== undefined ? { barcode: only.barcode } : {}),
      })
      .where(eq(variant.id, target.id))
      .run()
  } else {
    if (patch.variants !== undefined) {
      throw invalidOptions("Este producto no tiene tallas ni colores")
    }
    target = existing.find((v) => v.active) ?? existing[0]
  }
  if (!target) return
  const set = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.sku !== undefined ? { sku: patch.sku } : {}),
    ...(patch.barcode !== undefined ? { barcode: patch.barcode } : {}),
    ...(patch.priceMinor !== undefined ? { priceMinor: patch.priceMinor } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
  }
  if (Object.keys(set).length) {
    tx.update(variant).set(set).where(eq(variant.id, target.id)).run()
  }
}

/**
 * Producto con tallas y colores. Las combinaciones con id se editan (conservan su existencia
 * aunque cambien sus valores); las nuevas reusan la variante desactivada con los mismos valores o
 * se crean. Al cambiar las características, las que no se mencionan se desactivan.
 */
function editVariants(
  tx: Tx,
  ctx: {
    productId: string
    name: string
    options: ProductOption[]
    replacing: boolean
    current: VariantRow[]
    byId: Map<string, VariantRow>
    patch: UpdateProductBody
    now: number
  },
) {
  const { patch, options, byId } = ctx
  if (patch.variants === undefined) {
    // Solo datos del producto: el precio, si viene, para todas las que se venden.
    if (patch.priceMinor !== undefined) {
      tx.update(variant)
        .set({ priceMinor: patch.priceMinor })
        .where(and(eq(variant.productId, ctx.productId), eq(variant.active, true)))
        .run()
    }
    return
  }
  const inputs = checkCombos(options, patch.variants)
  const ids = new Set<string>()
  for (const v of inputs) {
    if (!v.id) continue
    if (!byId.has(v.id)) {
      throw new HttpError(422, "UNKNOWN_VARIANT", "Esa combinación no es del producto")
    }
    if (ids.has(v.id)) throw invalidOptions("Una combinación aparece dos veces")
    ids.add(v.id)
  }
  // Las combinaciones nuevas recuperan la variante desactivada que ya tenía esos valores.
  const spare = new Map(
    ctx.current
      .filter((v) => !ids.has(v.id) && v.optionValues)
      .map((v) => [comboKey(v.optionValues ?? []), v]),
  )
  const resolved = inputs.map((v) => {
    const reuse = v.id ? undefined : spare.get(comboKey(v.values))
    if (reuse) {
      spare.delete(comboKey(v.values))
      ids.add(reuse.id)
    }
    return { ...v, id: v.id ?? reuse?.id }
  })
  // Las que quedan fuera: al cambiar las características se desactivan; si no, siguen como están.
  const untouched = ctx.current.filter((v) => !ids.has(v.id))
  if (ctx.replacing) {
    for (const v of untouched) {
      if (v.active) tx.update(variant).set({ active: false }).where(eq(variant.id, v.id)).run()
    }
  } else {
    const keys = new Set(resolved.filter((v) => v.active).map((v) => comboKey(v.values)))
    for (const v of untouched) {
      if (v.active && v.optionValues && keys.has(comboKey(v.optionValues))) {
        throw invalidOptions(`La combinación ${v.optionValues.join(", ")} ya existe`)
      }
    }
  }

  const first = ctx.current.find((v) => v.active) ?? ctx.current[0]
  const base = first?.sku.replace(/-\d+$/, "") ?? `P${ctx.productId.slice(-5)}`
  const taken = new Set<string>()
  const model = first
  for (const v of resolved) {
    const common = {
      name: variantName(ctx.name, v.values),
      optionValues: v.values,
      priceMinor: v.priceMinor,
      active: v.active,
      ...(v.barcode !== undefined ? { barcode: v.barcode } : {}),
    }
    if (v.id) {
      tx.update(variant)
        .set({ ...common, ...(v.sku !== undefined ? { sku: v.sku } : {}) })
        .where(eq(variant.id, v.id))
        .run()
    } else {
      tx.insert(variant)
        .values({
          ...common,
          id: uuidv7(ctx.now),
          productId: ctx.productId,
          sku: v.sku ?? nextVariantSku(tx, base, taken),
          barcode: v.barcode ?? null,
          priceCurrency: patch.priceCurrency ?? model?.priceCurrency ?? "USD",
          minStockMilli:
            patch.minStockMilli !== undefined
              ? patch.minStockMilli
              : (model?.minStockMilli ?? null),
          createdAt: ctx.now,
        })
        .run()
    }
  }
}
