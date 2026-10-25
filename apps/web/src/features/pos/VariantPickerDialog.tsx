import type { CatalogItem } from "@millhiore/contracts"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@millhiore/ui"
import { VariantGrid } from "../../components/VariantGrid"
import { formatMoney, formatQty } from "../../lib/format"
import { stockAt } from "../../lib/locations"
import { type PosContext, priceWithList, unitPriceInDoc } from "./compute"

/**
 * Elegir la talla y el color al vender: cada celda muestra lo que hay en la ubicación de la caja
 * y, si cambia, su precio. Las combinaciones agotadas se pueden vender igual (quedan en
 * negativo, como cualquier producto).
 */
export function VariantPickerDialog({
  items,
  ctx,
  priceListId,
  locationId,
  onPick,
  onClose,
}: {
  items: CatalogItem[]
  ctx: PosContext
  priceListId: string | null
  locationId: string
  onPick: (item: CatalogItem) => void
  onClose: () => void
}) {
  const first = items[0]
  const unit = (item: CatalogItem) => {
    const price = priceWithList(ctx, priceListId, item.variantId, item)
    return unitPriceInDoc(ctx, price.priceMinor, price.priceCurrency)
  }
  const prices = items.map(unit).filter((p) => p !== null)
  const common = prices.length && prices.every((p) => p === prices[0]) ? prices[0] : null
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{first?.productName}</DialogTitle>
          <DialogDescription>
            {common !== null && common !== undefined
              ? `${formatMoney(common, ctx.docCurrency)} · `
              : ""}
            Elige {first?.options?.map((o) => o.name.toLocaleLowerCase("es")).join(" y ")}. El
            número es lo que hay en esta caja.
          </DialogDescription>
        </DialogHeader>
        <VariantGrid
          items={items}
          cell={(item, label) => {
            if (!item) {
              return (
                <span className="grid h-14 place-items-center rounded-lg border border-dashed text-muted-foreground text-xs">
                  —
                </span>
              )
            }
            const stock = stockAt(item, locationId)
            const price = unit(item)
            return (
              <button
                type="button"
                onClick={() => onPick(item)}
                aria-label={`${label}: ${formatQty(stock)} en existencia`}
                className={`grid h-14 w-full min-w-14 cursor-pointer place-items-center rounded-lg border px-1 text-center transition-colors hover:border-primary hover:bg-accent/50 active:scale-[0.98] ${
                  item.tracksStock && stock <= 0 ? "border-dashed text-muted-foreground" : "bg-card"
                }`}
              >
                <span className="tabular font-semibold">
                  {item.tracksStock ? formatQty(stock) : "✓"}
                </span>
                {common === null && price !== null ? (
                  <span className="tabular text-[11px] text-muted-foreground leading-none">
                    {formatMoney(price, ctx.docCurrency)}
                  </span>
                ) : null}
              </button>
            )
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
