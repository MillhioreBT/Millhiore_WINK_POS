import type { ProductDetail, RecipeInput } from "@millhiore/contracts"
import { type Db, product, recipeItem, variant } from "@millhiore/db"
import { asc, eq, inArray } from "drizzle-orm"
import { HttpError } from "../../http/errors"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Pick<Db, "select">

/** Los productos que tienen receta. */
export function productsWithRecipe(db: Pick<Db, "selectDistinct">): Set<string> {
  return new Set(
    db
      .selectDistinct({ productId: recipeItem.productId })
      .from(recipeItem)
      .all()
      .map((r) => r.productId),
  )
}

/** La receta de un producto, en su orden, con el nombre y el costo de hoy de cada ingrediente. */
export function recipeOf(db: Reader, productId: string): ProductDetail["recipe"] {
  return db
    .select({
      ingredientId: recipeItem.ingredientId,
      name: variant.name,
      qtyMilli: recipeItem.qtyMilli,
      wasteBp: recipeItem.wasteBp,
      costMinor: variant.costMinor,
      costCurrency: variant.costCurrency,
    })
    .from(recipeItem)
    .innerJoin(variant, eq(variant.id, recipeItem.ingredientId))
    .where(eq(recipeItem.productId, productId))
    .orderBy(asc(recipeItem.position))
    .all()
}

/**
 * Deja la receta como viene (vacía = sin receta). Cada ingrediente es un producto activo que lleva
 * existencia, distinto del propio producto y sin repetirse.
 */
export function setRecipe(tx: Tx, productId: string, items: readonly RecipeInput[]): void {
  const ids = items.map((i) => i.ingredientId)
  if (new Set(ids).size !== ids.length) {
    throw new HttpError(422, "DUPLICATE_INGREDIENT", "Un ingrediente está repetido en la receta")
  }
  if (ids.length) {
    const found = new Map(
      tx
        .select({
          id: variant.id,
          name: variant.name,
          productId: variant.productId,
          active: variant.active,
          tracksStock: product.tracksStock,
        })
        .from(variant)
        .innerJoin(product, eq(product.id, variant.productId))
        .where(inArray(variant.id, ids))
        .all()
        .map((v) => [v.id, v]),
    )
    for (const id of ids) {
      const v = found.get(id)
      if (!v?.active) {
        throw new HttpError(422, "UNKNOWN_INGREDIENT", "Ingrediente desconocido o inactivo")
      }
      if (v.productId === productId) {
        throw new HttpError(
          422,
          "INVALID_INGREDIENT",
          "Un producto no puede ser su propio ingrediente",
        )
      }
      if (!v.tracksStock) {
        throw new HttpError(
          422,
          "INVALID_INGREDIENT",
          `«${v.name}» no lleva existencia: un ingrediente debe ser un producto que se compra o se produce`,
        )
      }
    }
  }
  tx.delete(recipeItem).where(eq(recipeItem.productId, productId)).run()
  items.forEach((i, position) => {
    tx.insert(recipeItem)
      .values({
        productId,
        ingredientId: i.ingredientId,
        qtyMilli: i.qtyMilli,
        wasteBp: i.wasteBp,
        position,
      })
      .run()
  })
}
