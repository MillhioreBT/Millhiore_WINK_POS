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
  Label,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { ApiError, api, errorMessage } from "../../lib/api"
import { formatPercent, parseAmount, toInputAmount, toInputQty } from "../../lib/format"
import { bootstrapQuery, categoriesQuery, queryClient } from "../../lib/queries"

/** Crear (item = null) o editar un producto. */
export function ProductDialog({
  item,
  open,
  onClose,
}: {
  item: CatalogItem | null
  open: boolean
  onClose: () => void
}) {
  const { data: boot } = useQuery(bootstrapQuery)
  const reference = boot?.business.referenceCurrency ?? "USD"
  const legal = boot?.business.legalCurrency ?? "VES"
  const defaultTax = boot?.taxes.find((t) => t.id === boot.fiscal.defaultTaxId)
  const categories = useQuery(categoriesQuery({ all: true }))
  const [form, setForm] = useState(() => ({
    name: item?.name ?? "",
    kind: item?.kind ?? "good",
    price: item ? toInputAmount(item.priceMinor) : "",
    currency: item?.priceCurrency ?? reference,
    taxId: item?.taxId ?? "",
    categoryId: item?.categoryId ?? "",
    sku: item?.sku ?? "",
    barcode: item?.barcode ?? "",
    minStock: item?.minStockMilli == null ? "" : toInputQty(item.minStockMilli),
    active: item?.active ?? true,
  }))
  const tracksStock = item ? item.tracksStock : form.kind === "good"
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({
        ...f,
        [k]:
          e.target instanceof HTMLInputElement && e.target.type === "checkbox"
            ? e.target.checked
            : e.target.value,
      }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const priceMinor = parseAmount(form.price)
    if (priceMinor === null) {
      setErrors({ price: "Escribe un precio válido, p. ej. 1,50" })
      return
    }
    const minStockMilli = form.minStock.trim() ? parseAmount(form.minStock, 3) : null
    if (tracksStock && form.minStock.trim() && minStockMilli === null) {
      setErrors({ minStock: "Escribe una cantidad, p. ej. 5" })
      return
    }
    setBusy(true)
    setErrors({})
    const body = {
      name: form.name.trim(),
      priceMinor,
      priceCurrency: form.currency,
      taxId: form.taxId || null,
      categoryId: form.categoryId || null,
      barcode: form.barcode.trim() || null,
      ...(form.sku.trim() ? { sku: form.sku.trim() } : {}),
      ...(tracksStock ? { minStockMilli } : {}),
    }
    try {
      if (item) {
        await api(`/api/products/${item.productId}`, {
          method: "PATCH",
          body: { ...body, active: form.active },
        })
        toast.success("Producto guardado")
      } else {
        await api("/api/products", { body: { ...body, kind: form.kind } })
        toast.success(`${body.name} creado`)
      }
      await queryClient.invalidateQueries({ queryKey: ["products"] })
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.issues.length) {
        setErrors(Object.fromEntries(err.issues.map((i) => [i.path, i.message])))
      } else {
        toast.error(errorMessage(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{item ? "Editar producto" : "Nuevo producto"}</DialogTitle>
          <DialogDescription>
            El precio se guarda en la moneda que elijas; en caja se muestra en Bs con la tasa del
            día.
          </DialogDescription>
        </DialogHeader>
        <form id="product-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <Field label="Nombre" htmlFor="p-name" error={errors.name}>
            <Input id="p-name" value={form.name} onChange={set("name")} required autoFocus />
          </Field>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field
              label="Precio de venta"
              htmlFor="p-price"
              error={errors.price ?? errors.priceMinor}
            >
              <Input
                id="p-price"
                inputMode="decimal"
                value={form.price}
                onChange={set("price")}
                placeholder="0,00"
                className="tabular"
                required
              />
            </Field>
            <Field label="Moneda" htmlFor="p-currency">
              <NativeSelect id="p-currency" value={form.currency} onChange={set("currency")}>
                <option value={reference}>{reference}</option>
                <option value={legal}>{legal === "VES" ? "Bs" : legal}</option>
              </NativeSelect>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="IVA"
              htmlFor="p-tax"
              hint={
                boot?.fiscal.pricesIncludeTax
                  ? "El precio ya incluye el IVA"
                  : "El IVA se suma al precio"
              }
            >
              <NativeSelect id="p-tax" value={form.taxId} onChange={set("taxId")}>
                <option value="">
                  Por defecto
                  {defaultTax ? ` (${defaultTax.name} ${formatPercent(defaultTax.rateBp)})` : ""}
                </option>
                {boot?.taxes
                  .filter((t) => t.active)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} {t.kind === "taxed" ? formatPercent(t.rateBp) : ""}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
            {item ? null : (
              <Field label="Tipo" htmlFor="p-kind" hint="Los servicios no llevan existencia">
                <NativeSelect id="p-kind" value={form.kind} onChange={set("kind")}>
                  <option value="good">Producto</option>
                  <option value="service">Servicio</option>
                </NativeSelect>
              </Field>
            )}
          </div>
          <Field
            label="Categoría"
            htmlFor="p-category"
            hint="Para encontrarlo rápido en la caja"
            error={errors.categoryId}
          >
            <NativeSelect id="p-category" value={form.categoryId} onChange={set("categoryId")}>
              <option value="">Sin categoría</option>
              {(categories.data ?? [])
                // Las desactivadas solo se muestran si es la que ya tiene el producto.
                .filter((c) => c.active || c.id === item?.categoryId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.active ? "" : " (inactiva)"}
                  </option>
                ))}
            </NativeSelect>
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Código de barras" htmlFor="p-barcode" error={errors.barcode}>
              <Input
                id="p-barcode"
                value={form.barcode}
                onChange={set("barcode")}
                placeholder="Opcional"
              />
            </Field>
            <Field
              label="SKU"
              htmlFor="p-sku"
              hint={item ? undefined : "Si lo dejas vacío se genera"}
              error={errors.sku}
            >
              <Input id="p-sku" value={form.sku} onChange={set("sku")} placeholder="Opcional" />
            </Field>
          </div>
          {tracksStock ? (
            <Field
              label="Existencia mínima"
              htmlFor="p-min"
              hint="Al llegar a esta cantidad aparece en «Por reponer» del inicio"
              error={errors.minStock ?? errors.minStockMilli}
            >
              <Input
                id="p-min"
                inputMode="decimal"
                value={form.minStock}
                onChange={set("minStock")}
                placeholder="Opcional"
                className="tabular sm:w-40"
              />
            </Field>
          ) : null}
          {item ? (
            <div className="flex items-center gap-3">
              <input
                id="p-active"
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={form.active}
                onChange={set("active")}
              />
              <Label htmlFor="p-active">Activo (se puede vender)</Label>
            </div>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="product-form" disabled={busy}>
            {busy ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
