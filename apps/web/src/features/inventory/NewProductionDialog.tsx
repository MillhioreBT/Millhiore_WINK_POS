import type { Bootstrap, ProductDetail } from "@millhiore/contracts"
import { ingredientQty, rateConverter, recipeCost, uuidv7 } from "@millhiore/domain"
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
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatMoney, formatQty, parseAmount } from "../../lib/format"
import { stockAt, useLocations } from "../../lib/locations"
import { productDetailQuery, productsQuery, queryClient, rateStatusQuery } from "../../lib/queries"
import { makeContext } from "../pos/compute"

/** Lo que se gasta de cada ingrediente para producir `qtyMilli`, y lo que hay de él. */
export function ingredientNeeds(
  recipe: ProductDetail["recipe"],
  qtyMilli: number,
  stockOf: (ingredientId: string) => number,
): { ingredientId: string; name: string; needMilli: number; haveMilli: number }[] {
  return recipe.map((r) => ({
    ingredientId: r.ingredientId,
    name: r.name,
    needMilli: qtyMilli > 0 ? ingredientQty(qtyMilli, r) : 0,
    haveMilli: stockOf(r.ingredientId),
  }))
}

/**
 * Producir una tanda (salsa, pan, torta): se gastan los ingredientes de la receta con su merma y
 * lo producido entra a la existencia con el costo que sale de ellos. Se anula con un reverso que
 * devuelve los ingredientes.
 */
export function NewProductionDialog({
  boot,
  terminalId,
  defaultLocationId,
  initialVariantId,
  onClose,
}: {
  boot: Bootstrap
  terminalId: string
  defaultLocationId: string
  initialVariantId?: string | undefined
  onClose: () => void
}) {
  const products = useQuery(productsQuery())
  const rate = useQuery(rateStatusQuery)
  const locations = useLocations()
  const [variantId, setVariantId] = useState(initialVariantId ?? "")
  const [qty, setQty] = useState("1")
  const [locationId, setLocationId] = useState(defaultLocationId)
  const [expiresOn, setExpiresOn] = useState("")
  const [lotCode, setLotCode] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [productionId] = useState(uuidv7)

  const all = products.data ?? []
  // Se produce lo que lleva existencia y tiene receta; un plato gasta la suya al venderse.
  const producible = all.filter((p) => p.tracksStock && p.hasRecipe)
  const item = producible.find((p) => p.variantId === variantId)
  const detail = useQuery({ ...productDetailQuery(item?.productId ?? ""), enabled: !!item })
  const recipe = item ? (detail.data?.recipe ?? null) : null
  const qtyMilli = parseAmount(qty, 3)
  const byId = new Map(all.map((p) => [p.variantId, p]))
  const needs = recipe
    ? ingredientNeeds(recipe, qtyMilli ?? 0, (id) => {
        const ing = byId.get(id)
        if (!ing) return 0
        return locations ? stockAt(ing, locationId) : ing.stockMilli
      })
    : []
  const short = needs.filter((n) => n.needMilli > n.haveMilli)
  const ctx = makeContext(boot, rate.data?.current?.value ?? null)
  // Sin ver costos, la receta llega sin ellos y no se calcula.
  const unitCost = recipe?.length ? recipeCost(recipe, rateConverter(ctx.rate, ctx.book)) : null
  const withLots = boot.features.lots && (item?.tracksLots ?? false)
  const here = locations?.find((l) => l.id === locationId)
  const valid = !!item && !!recipe && qtyMilli !== null && qtyMilli > 0

  const submit = async () => {
    if (!(valid && item && qtyMilli)) return
    setBusy(true)
    try {
      const posted = await api<{ number: string }>("/api/documents", {
        body: {
          id: productionId,
          type: "PRODUCTION",
          terminalId,
          currency: boot.business.legalCurrency,
          rate: ctx.rate,
          ...(locations ? { locationId } : {}),
          lines: [
            {
              variantId: item.variantId,
              qtyMilli,
              unitPriceMinor: 0,
              ...(withLots && expiresOn
                ? { lot: { code: lotCode.trim() || null, expiresOn } }
                : {}),
            },
          ],
          payments: [],
          note: note.trim() || null,
        },
      })
      await Promise.all(
        ["products", "documents", "production", "reports", "locations", "lots"].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      )
      toast.success(
        `Producción ${posted.number}: ${formatQty(qtyMilli)} de ${item.name}${here ? ` en ${here.name}` : ""}`,
      )
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nueva producción</DialogTitle>
          <DialogDescription>
            Se gastan los ingredientes de la receta, con su merma, y lo producido entra a la
            existencia.
          </DialogDescription>
        </DialogHeader>

        {products.data && producible.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-muted-foreground text-sm">
            Ningún producto con existencia tiene receta todavía. Anota sus ingredientes en la ficha
            del producto (Productos → Editar → Receta).
          </p>
        ) : (
          <>
            <Field label="Qué se produce" htmlFor="pr-item">
              <NativeSelect
                id="pr-item"
                value={variantId}
                onChange={(e) => setVariantId(e.target.value)}
              >
                <option value="">Elegir…</option>
                {producible.map((p) => (
                  <option key={p.variantId} value={p.variantId}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cantidad" htmlFor="pr-qty">
                <Input
                  id="pr-qty"
                  value={qty}
                  inputMode="decimal"
                  className="tabular"
                  onChange={(e) => setQty(e.target.value)}
                />
              </Field>
              {locations ? (
                <Field label="Ubicación" htmlFor="pr-location">
                  <NativeSelect
                    id="pr-location"
                    value={locationId}
                    onChange={(e) => setLocationId(e.target.value)}
                  >
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              ) : null}
            </div>
            {withLots ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Vence" htmlFor="pr-expires" hint="Vacío: queda sin lote">
                  <Input
                    id="pr-expires"
                    type="date"
                    value={expiresOn}
                    onChange={(e) => setExpiresOn(e.target.value)}
                  />
                </Field>
                <Field label="Código del lote" htmlFor="pr-lot-code">
                  <Input
                    id="pr-lot-code"
                    value={lotCode}
                    onChange={(e) => setLotCode(e.target.value)}
                    placeholder="Opcional"
                    maxLength={40}
                  />
                </Field>
              </div>
            ) : null}

            {item ? (
              <div className="grid gap-1.5">
                <p className="font-medium text-sm">Se gasta</p>
                <ul className="divide-y rounded-lg border text-sm">
                  {recipe === null ? (
                    <li className="px-3 py-3 text-muted-foreground">Cargando la receta…</li>
                  ) : null}
                  {needs.map((n) => (
                    <li
                      key={n.ingredientId}
                      className="flex items-baseline justify-between gap-3 px-3 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block">{n.name}</span>
                        <span
                          className={`block text-xs ${n.needMilli > n.haveMilli ? "text-destructive" : "text-muted-foreground"}`}
                        >
                          Hay {formatQty(n.haveMilli)}
                          {here ? ` en ${here.name}` : ""}
                        </span>
                      </span>
                      <span className="tabular shrink-0 font-medium">{formatQty(n.needMilli)}</span>
                    </li>
                  ))}
                </ul>
                {unitCost && qtyMilli ? (
                  <p className="text-muted-foreground text-xs">
                    Cuesta {formatMoney(unitCost.costMinor, unitCost.costCurrency)} cada uno ·{" "}
                    {formatMoney(
                      Math.round((unitCost.costMinor * qtyMilli) / 1000),
                      unitCost.costCurrency,
                    )}{" "}
                    la tanda
                  </p>
                ) : null}
                {short.length ? (
                  <p className="text-destructive text-sm">
                    No alcanza la existencia de{" "}
                    {short.length === 1 ? short[0]?.name : `${short.length} ingredientes`}.
                  </p>
                ) : null}
              </div>
            ) : null}

            <Field label="Nota (opcional)" htmlFor="pr-note">
              <Input
                id="pr-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Tanda de la mañana, pedido especial…"
                maxLength={500}
              />
            </Field>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={busy || !valid}>
            {busy ? "Produciendo…" : "Producir"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
