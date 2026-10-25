import type { CatalogItem, ProductDetail, RecipeInput } from "@millhiore/contracts"
import { rateConverter, recipeCost } from "@millhiore/domain"
import { Button, Input, NativeSelect } from "@millhiore/ui"
import Big from "big.js"
import { PlusIcon, XIcon } from "lucide-react"
import {
  formatMoney,
  formatPercent,
  parseAmount,
  toInputAmount,
  toInputQty,
} from "../../lib/format"
import type { PosContext } from "../pos/compute"

export interface RecipeRow {
  key: string
  ingredientId: string
  /** Cantidad escrita (0,150). */
  qty: string
  /** Merma escrita, en % (10). */
  waste: string
}

let seq = 0
const rowKey = () => `r${++seq}`

export function recipeRows(detail: ProductDetail | null): RecipeRow[] {
  return (detail?.recipe ?? []).map((r) => ({
    key: rowKey(),
    ingredientId: r.ingredientId,
    qty: toInputQty(r.qtyMilli),
    waste: r.wasteBp ? toInputAmount(r.wasteBp).replace(/,00$/, "") : "",
  }))
}

export const emptyRecipeRow = (): RecipeRow => ({
  key: rowKey(),
  ingredientId: "",
  qty: "",
  waste: "",
})

/** La receta lista para guardar, o qué está mal (la primera fila con problema). */
export function recipePayload(
  rows: readonly RecipeRow[],
): { ok: true; items: RecipeInput[] } | { ok: false; error: string } {
  const items: RecipeInput[] = []
  for (const [i, r] of rows.entries()) {
    if (!r.ingredientId && !r.qty.trim()) continue
    if (!r.ingredientId) return { ok: false, error: `Elige el ingrediente de la fila ${i + 1}` }
    const qtyMilli = parseAmount(r.qty, 3)
    if (!qtyMilli) return { ok: false, error: `Escribe cuánto lleva en la fila ${i + 1}` }
    const wasteBp = r.waste.trim() ? parseAmount(r.waste, 2) : 0
    if (wasteBp === null || wasteBp > 10_000) {
      return { ok: false, error: `La merma de la fila ${i + 1} va de 0 a 100 %` }
    }
    if (items.some((x) => x.ingredientId === r.ingredientId)) {
      return { ok: false, error: "Un ingrediente está repetido" }
    }
    items.push({ ingredientId: r.ingredientId, qtyMilli, wasteBp })
  }
  return { ok: true, items }
}

/**
 * Los ingredientes de una unidad: cada uno es un producto que lleva existencia, con cuánto lleva
 * y cuánto se pierde al prepararlo. Si se ven los costos, dice cuánto cuesta y cuánto queda.
 */
export function RecipeEditor({
  rows,
  setRows,
  ingredients,
  ctx,
  price,
  tracksStock,
}: {
  rows: RecipeRow[]
  setRows: (rows: RecipeRow[]) => void
  /** Los productos que pueden ser ingredientes (con existencia). */
  ingredients: readonly CatalogItem[]
  ctx: PosContext | null
  /** El precio de venta, para el margen. */
  price: { priceMinor: number; priceCurrency: string } | null
  tracksStock: boolean
}) {
  const set = (key: string, patch: Partial<RecipeRow>) =>
    setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const parsed = recipePayload(rows)
  const byId = new Map(ingredients.map((i) => [i.variantId, i]))
  const cost =
    ctx && parsed.ok && parsed.items.length
      ? recipeCost(
          parsed.items.map((i) => ({
            ...i,
            costMinor: byId.get(i.ingredientId)?.costMinor ?? null,
            costCurrency: byId.get(i.ingredientId)?.costCurrency ?? null,
          })),
          rateConverter(ctx.rate, ctx.book),
        )
      : null
  // Lo que pesa el costo en el precio de venta (el «food cost» de la cocina).
  const priceInCost =
    cost && price && ctx
      ? rateConverter(ctx.rate, ctx.book)(
          new Big(price.priceMinor),
          price.priceCurrency,
          cost.costCurrency,
        )
      : null
  const share =
    cost && priceInCost?.gt(0)
      ? Math.round(new Big(cost.costMinor).div(priceInCost).times(10_000).toNumber())
      : null

  return (
    <fieldset className="grid min-w-0 grid-cols-1 gap-2">
      <legend className="mb-1 font-medium text-sm">Receta</legend>
      <p className="text-muted-foreground text-xs">
        {tracksStock
          ? "Lo que lleva una unidad. Como este producto lleva existencia, la receta se gasta al producirlo por tandas (Inventario → Producción) y se vende de lo producido."
          : "Lo que lleva una unidad: al venderlo se descuenta de la existencia de cada ingrediente, con su merma."}
      </p>
      {rows.map((r, i) => (
        <div
          key={r.key}
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5 sm:grid-cols-[minmax(0,1fr)_6rem_5rem_auto]"
        >
          <NativeSelect
            className="col-span-2 sm:col-span-1"
            value={r.ingredientId}
            aria-label={`Ingrediente ${i + 1}`}
            onChange={(e) => set(r.key, { ingredientId: e.target.value })}
          >
            <option value="">Elegir…</option>
            {ingredients.map((x) => (
              <option key={x.variantId} value={x.variantId}>
                {x.name}
              </option>
            ))}
          </NativeSelect>
          <div className="col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-1.5 sm:contents">
            <Input
              value={r.qty}
              inputMode="decimal"
              aria-label={`Cantidad del ingrediente ${i + 1}`}
              placeholder="Cantidad"
              onChange={(e) => set(r.key, { qty: e.target.value })}
            />
            <span className="relative">
              <Input
                className="pr-7"
                value={r.waste}
                inputMode="decimal"
                aria-label={`Merma del ingrediente ${i + 1} (%)`}
                placeholder="Merma"
                onChange={(e) => set(r.key, { waste: e.target.value })}
              />
              <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground text-sm">
                %
              </span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Quitar el ingrediente ${i + 1}`}
              onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
            >
              <XIcon />
            </Button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRows([...rows, emptyRecipeRow()])}
        >
          <PlusIcon /> Ingrediente
        </Button>
        {cost ? (
          <span className="text-muted-foreground text-xs">
            Cuesta {formatMoney(cost.costMinor, cost.costCurrency)}
            {share !== null ? ` · el ${formatPercent(share)} del precio` : ""}
          </span>
        ) : null}
      </div>
      {!parsed.ok ? <p className="text-destructive text-xs">{parsed.error}</p> : null}
    </fieldset>
  )
}
