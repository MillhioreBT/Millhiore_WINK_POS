import {
  type Db,
  modifier,
  modifierGroup,
  type PickedModifier,
  productModifierGroup,
  variant,
} from "@millhiore/db"
import { PostingError } from "@millhiore/domain"
import { and, eq, inArray } from "drizzle-orm"

type Reader = Pick<Db, "select">

/**
 * Las opciones y extras elegidos en cada línea, verificados contra los grupos del producto: que
 * estén activos, que no pasen del máximo de su grupo y que estén los obligatorios. Devuelve, por
 * línea, lo elegido con su nombre y su precio de hoy (null si no lleva).
 *
 * `asOrdered`: lo que se pidió antes en una cuenta abierta y ahora se cobra; ya se verificó al
 * pedirlo, así que vale aunque después cambiaran los grupos o se desactivara una opción.
 */
export function pickModifiers(
  db: Reader,
  lines: readonly { variantId: string; modifierIds?: readonly string[] | undefined }[],
  opts: { asOrdered?: boolean } = {},
): (PickedModifier[] | null)[] {
  const variantIds = [...new Set(lines.map((l) => l.variantId))]
  if (variantIds.length === 0) return []
  const products = new Map(
    db
      .select({ id: variant.id, productId: variant.productId, name: variant.name })
      .from(variant)
      .where(inArray(variant.id, variantIds))
      .all()
      .map((v) => [v.id, v]),
  )
  const productIds = [...new Set([...products.values()].map((v) => v.productId))]
  const groups = db
    .select({
      productId: productModifierGroup.productId,
      groupId: modifierGroup.id,
      name: modifierGroup.name,
      minSelect: modifierGroup.minSelect,
      maxSelect: modifierGroup.maxSelect,
    })
    .from(productModifierGroup)
    .innerJoin(modifierGroup, eq(modifierGroup.id, productModifierGroup.groupId))
    .where(and(inArray(productModifierGroup.productId, productIds), eq(modifierGroup.active, true)))
    .all()
  const wanted = [...new Set(lines.flatMap((l) => l.modifierIds ?? []))]
  const options = new Map(
    (wanted.length
      ? db
          .select()
          .from(modifier)
          .where(
            and(
              inArray(modifier.id, wanted),
              opts.asOrdered ? undefined : eq(modifier.active, true),
            ),
          )
          .all()
      : []
    ).map((m) => [m.id, m]),
  )
  return lines.map((l) => {
    const item = products.get(l.variantId)
    if (!item) return null
    const own = groups.filter((g) => g.productId === item.productId)
    const ids = l.modifierIds ?? []
    if (new Set(ids).size !== ids.length) {
      throw new PostingError("INVALID_LINE", `Una opción de ${item.name} está repetida`)
    }
    const picked = ids.map((id) => {
      const m = options.get(id)
      if (!m || (!opts.asOrdered && !own.some((g) => g.groupId === m.groupId))) {
        throw new PostingError(
          "INVALID_LINE",
          `Esa opción no se ofrece con ${item.name} (o ya no está activa)`,
        )
      }
      return m
    })
    for (const g of opts.asOrdered ? [] : own) {
      const count = picked.filter((m) => m.groupId === g.groupId).length
      if (count < g.minSelect) {
        throw new PostingError(
          "INVALID_LINE",
          g.minSelect === 1
            ? `Elige «${g.name}» de ${item.name}`
            : `Elige ${g.minSelect} de «${g.name}» en ${item.name}`,
        )
      }
      if (g.maxSelect !== null && count > g.maxSelect) {
        throw new PostingError(
          "INVALID_LINE",
          `De «${g.name}» se eligen hasta ${g.maxSelect} en ${item.name}`,
        )
      }
    }
    if (picked.length === 0) return null
    // En el orden en que se eligieron.
    return picked.map((m) => ({
      id: m.id,
      name: m.name,
      priceMinor: m.priceMinor,
      priceCurrency: m.priceMinor ? m.priceCurrency : null,
    }))
  })
}
