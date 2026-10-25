import { type Db, product, recipeItem, variant } from "@millhiore/db"
import type { RecipeItem } from "@millhiore/domain"
import { and, asc, eq, inArray } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"

type Reader = Pick<Db, "select">

export interface Ingredient extends RecipeItem {
  name: string
  tracksLots: boolean
  costMinor: number | null
  costCurrency: string | null
}

const ingredient = alias(variant, "ingredient")
const ingredientProduct = alias(product, "ingredient_product")

/**
 * Las recetas de las variantes, por variante. Los platos (productos sin existencia) gastan la suya
 * al venderse; los que llevan existencia la gastan al producirse por tandas y se venden de lo
 * producido: `tracksStock` dice cuáles se buscan.
 */
export function recipesOf(
  db: Reader,
  variantIds: readonly string[],
  tracksStock: boolean,
): Map<string, Ingredient[]> {
  if (variantIds.length === 0) return new Map()
  const rows = db
    .select({
      variantId: variant.id,
      ingredientId: recipeItem.ingredientId,
      qtyMilli: recipeItem.qtyMilli,
      wasteBp: recipeItem.wasteBp,
      name: ingredient.name,
      tracksLots: ingredientProduct.tracksLots,
      costMinor: ingredient.costMinor,
      costCurrency: ingredient.costCurrency,
    })
    .from(variant)
    .innerJoin(product, eq(product.id, variant.productId))
    .innerJoin(recipeItem, eq(recipeItem.productId, product.id))
    .innerJoin(ingredient, eq(ingredient.id, recipeItem.ingredientId))
    .innerJoin(ingredientProduct, eq(ingredientProduct.id, ingredient.productId))
    .where(and(inArray(variant.id, [...variantIds]), eq(product.tracksStock, tracksStock)))
    .orderBy(asc(recipeItem.position))
    .all()
  const out = new Map<string, Ingredient[]>()
  for (const { variantId, ...r } of rows) {
    const list = out.get(variantId)
    if (list) list.push(r)
    else out.set(variantId, [r])
  }
  return out
}
