import type { CatalogItem } from "@millhiore/contracts"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from "@millhiore/ui"
import { useState } from "react"
import { VariantGrid } from "../../components/VariantGrid"
import { formatQty, parseAmount } from "../../lib/format"

/**
 * Las cantidades de cada talla y color de una compra, en cuadrícula, con un mismo costo para
 * todas (después se puede cambiar línea por línea).
 */
export function VariantQtyDialog({
  items,
  initialCost,
  costLabel,
  onAdd,
  onClose,
}: {
  items: CatalogItem[]
  initialCost: string
  costLabel: string
  onAdd: (lines: { item: CatalogItem; qty: string; cost: string }[]) => void
  onClose: () => void
}) {
  const [qty, setQty] = useState<Record<string, string>>({})
  const [cost, setCost] = useState(initialCost)
  const chosen = items.filter((i) => {
    const q = parseAmount(qty[i.variantId] ?? "", 3)
    return q !== null && q > 0
  })
  const total = chosen.reduce((acc, i) => acc + (parseAmount(qty[i.variantId] ?? "", 3) ?? 0), 0)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{items[0]?.productName}</DialogTitle>
          <DialogDescription>
            Escribe cuántas llegaron de cada combinación; las vacías no se agregan.
          </DialogDescription>
        </DialogHeader>
        <VariantGrid
          items={items}
          cell={(item, label) =>
            item ? (
              <Input
                inputMode="decimal"
                className="tabular h-10 min-w-14 text-center"
                placeholder="0"
                value={qty[item.variantId] ?? ""}
                onChange={(e) => setQty((q) => ({ ...q, [item.variantId]: e.target.value }))}
                aria-label={`Cantidad de ${label}`}
              />
            ) : (
              <span className="grid h-10 place-items-center rounded-md border border-dashed text-muted-foreground text-xs">
                —
              </span>
            )
          }
        />
        <Field label={costLabel} htmlFor="vq-cost" hint="El mismo para todas las combinaciones">
          <Input
            id="vq-cost"
            inputMode="decimal"
            className="tabular sm:w-40"
            placeholder="0,00"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={chosen.length === 0}
            onClick={() =>
              onAdd(chosen.map((item) => ({ item, qty: qty[item.variantId] ?? "", cost })))
            }
          >
            Agregar{total ? ` ${formatQty(total)} ${total === 1000 ? "unidad" : "unidades"}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
