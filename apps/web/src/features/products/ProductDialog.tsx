import type { CatalogItem, ProductDetail } from "@millhiore/contracts"
import { priceInList } from "@millhiore/domain"
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
import { CheckIcon, PlusIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { ScanButton } from "../../components/CameraScanner"
import { ApiError, api, errorMessage } from "../../lib/api"
import {
  formatMoney,
  formatPercent,
  parseAmount,
  toInputAmount,
  toInputQty,
} from "../../lib/format"
import {
  bootstrapQuery,
  categoriesQuery,
  productDetailQuery,
  productsQuery,
  queryClient,
  rateStatusQuery,
} from "../../lib/queries"
import { useFeatures } from "../../lib/session"
import { makeContext } from "../pos/compute"
import { adjustLabel } from "./PriceListsDialog"
import { RecipeEditor, type RecipeRow, recipePayload, recipeRows } from "./RecipeEditor"
import { VariantsEditor } from "./VariantsEditor"
import {
  type Assigned,
  addOption,
  combosOf,
  draftFromDetail,
  emptyDraft,
  type VariantsDraft,
  variantsPayload,
} from "./variantsForm"

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
  // Al editar hacen falta todas sus variantes (tallas y colores, también las desactivadas).
  const detail = useQuery({ ...productDetailQuery(item?.productId ?? ""), enabled: !!item })
  const [wide, setWide] = useState(!!item?.options)
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={wide ? "max-w-2xl" : undefined}>
        <DialogHeader>
          <DialogTitle>{item ? "Editar producto" : "Nuevo producto"}</DialogTitle>
          <DialogDescription>
            El precio se guarda en la moneda que elijas; en caja se muestra en Bs con la tasa del
            día.
          </DialogDescription>
        </DialogHeader>
        {item && !detail.data ? (
          <p className="py-6 text-center text-muted-foreground text-sm">
            {detail.isError ? errorMessage(detail.error) : "Cargando…"}
          </p>
        ) : (
          <ProductForm
            item={item}
            detail={detail.data ?? null}
            onClose={onClose}
            onVariantsShown={setWide}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ProductForm({
  item,
  detail,
  onClose,
  onVariantsShown,
}: {
  item: CatalogItem | null
  detail: ProductDetail | null
  onClose: () => void
  onVariantsShown: (shown: boolean) => void
}) {
  const { data: boot } = useQuery(bootstrapQuery)
  const features = useFeatures()
  const reference = boot?.business.referenceCurrency ?? "USD"
  const legal = boot?.business.legalCurrency ?? "VES"
  const defaultTax = boot?.taxes.find((t) => t.id === boot.fiscal.defaultTaxId)
  const categories = useQuery(categoriesQuery({ all: true }))
  const [form, setForm] = useState(() => ({
    name: detail?.name ?? item?.productName ?? "",
    kind: item?.kind ?? "good",
    price: item ? toInputAmount(item.priceMinor) : "",
    currency: item?.priceCurrency ?? reference,
    taxId: item?.taxId ?? "",
    categoryId: item?.categoryId ?? "",
    sku: item?.sku ?? "",
    barcode: item?.barcode ?? "",
    minStock: item?.minStockMilli == null ? "" : toInputQty(item.minStockMilli),
    active: detail?.active ?? item?.active ?? true,
    tracksLots: item?.tracksLots ?? false,
  }))
  // Opciones y extras que se ofrecen al venderlo (término, queso extra), en su orden.
  const [groupIds, setGroupIds] = useState<string[]>(() => item?.modifierGroupIds ?? [])
  const modifierGroups = features.modifiers ? (boot?.modifierGroups ?? []) : []
  // Receta: sus ingredientes son productos con existencia (no el propio).
  const [recipe, setRecipe] = useState<RecipeRow[]>(() => recipeRows(detail))
  const products = useQuery({ ...productsQuery(), enabled: features.recipes })
  const ingredients = (products.data ?? []).filter(
    (p) => p.tracksStock && p.active && p.productId !== item?.productId,
  )
  const rate = useQuery(rateStatusQuery)
  const ctx = boot ? makeContext(boot, rate.data?.current?.value ?? null) : null
  const hadOptions = !!detail?.options
  const [hasVariants, setHasVariants] = useState(hadOptions)
  const [draft, setDraft] = useState<VariantsDraft>(() => {
    if (!detail?.options) return emptyDraft()
    // Las que valen lo mismo que el producto siguen su precio.
    const d = draftFromDetail(detail)
    const base = item ? toInputAmount(item.priceMinor) : null
    return {
      ...d,
      combos: Object.fromEntries(
        Object.entries(d.combos).map(([k, c]) => [k, c.price === base ? { ...c, price: null } : c]),
      ),
    }
  })
  // Un producto sencillo que pasa a tener tallas: en qué combinación queda lo que ya tiene.
  const [assignKey, setAssignKey] = useState<string | null>(null)
  const combos = combosOf(draft.options)
  const assigned: Assigned | null =
    item && !hadOptions && combos.length
      ? {
          key: combos.some((c) => c.key === assignKey) ? (assignKey ?? "") : (combos[0]?.key ?? ""),
          variantId: item.variantId,
          sku: item.sku,
          barcode: item.barcode,
          priceMinor: item.priceMinor,
          stockMilli: item.stockMilli,
        }
      : null
  // Uno con tallas que deja de tenerlas: cuál se sigue vendiendo.
  const sellable = detail?.variants.filter((v) => v.variantActive) ?? []
  const [keepId, setKeepId] = useState(() => item?.variantId ?? "")
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const lotsOn = boot?.features.lots ?? false
  const priceLists = boot?.features.priceLists ? boot.priceLists : []
  // Precio propio en cada lista activa; vacío = el normal con el ajuste de la lista.
  const [listPrices, setListPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      priceLists.map((l) => {
        const own = item && l.prices.find((p) => p.variantId === item.variantId)
        return [l.id, own ? toInputAmount(own.priceMinor) : ""]
      }),
    ),
  )
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
  const toggleVariants = (on: boolean) => {
    setHasVariants(on)
    onVariantsShown(on)
    // La primera vez se arranca con «Talla» lista para escribir.
    if (on && draft.options.length === 0) setDraft(addOption(draft))
  }

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
    const listErrors: Record<string, string> = {}
    const listBody = priceLists.map((l) => {
      const text = listPrices[l.id]?.trim() ?? ""
      const minor = text ? parseAmount(text) : null
      if (text && minor === null) listErrors[`list-${l.id}`] = "Escribe un precio válido"
      return { priceListId: l.id, priceMinor: minor }
    })
    if (Object.keys(listErrors).length) {
      setErrors(listErrors)
      return
    }
    const recipeBody = features.recipes ? recipePayload(recipe) : null
    if (recipeBody && !recipeBody.ok) {
      toast.error(recipeBody.error)
      return
    }
    const common = {
      name: form.name.trim(),
      priceCurrency: form.currency,
      taxId: form.taxId || null,
      categoryId: form.categoryId || null,
      ...(tracksStock ? { minStockMilli } : {}),
      ...(tracksStock && lotsOn ? { tracksLots: form.tracksLots } : {}),
      ...(listBody.length ? { listPrices: listBody } : {}),
      ...(features.modifiers ? { modifierGroupIds: groupIds } : {}),
      ...(recipeBody?.ok ? { recipe: recipeBody.items } : {}),
    }
    let body: Record<string, unknown>
    if (hasVariants) {
      const result = variantsPayload(draft, priceMinor, assigned)
      if (!result.ok) {
        setErrors({ variants: result.error })
        setErrorKey(result.comboKey ?? null)
        return
      }
      body = { ...common, options: result.options, variants: result.variants }
    } else if (hadOptions) {
      // Deja de tener tallas: se sigue vendiendo una sola, con el precio del producto.
      body = { ...common, options: null, variants: [{ id: keepId, values: [], priceMinor }] }
    } else {
      body = {
        ...common,
        priceMinor,
        barcode: form.barcode.trim() || null,
        ...(form.sku.trim() ? { sku: form.sku.trim() } : {}),
      }
    }
    setBusy(true)
    setErrors({})
    setErrorKey(null)
    try {
      if (item) {
        await api(`/api/products/${item.productId}`, {
          method: "PATCH",
          body: { ...body, active: form.active },
        })
        toast.success("Producto guardado")
      } else {
        await api("/api/products", { body: { ...body, priceMinor, kind: form.kind } })
        toast.success(`${common.name} creado`)
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["products"] }),
        // La caja toma los precios de cada lista del arranque.
        ...(listBody.length ? [queryClient.invalidateQueries({ queryKey: ["bootstrap"] })] : []),
      ])
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

  const showVariants = features.variants || hadOptions
  const variantIssue = Object.entries(errors).find(([k]) => k.startsWith("variants"))?.[1]

  return (
    <>
      <form id="product-form" onSubmit={submit} className="grid min-w-0 grid-cols-1 gap-4">
        <Field label="Nombre" htmlFor="p-name" error={errors.name}>
          <Input id="p-name" value={form.name} onChange={set("name")} required autoFocus />
        </Field>
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field
            label="Precio de venta"
            htmlFor="p-price"
            hint={hasVariants ? "El de las combinaciones sin precio propio" : undefined}
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
        {priceLists.length ? (
          <fieldset className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border p-3 sm:grid-cols-2">
            <legend className="px-1 text-muted-foreground text-sm">
              Precios por lista{hasVariants ? " (para todas las combinaciones)" : ""}
            </legend>
            {priceLists.map((l) => {
              const base = parseAmount(form.price)
              const fallback =
                base === null
                  ? null
                  : priceInList(
                      "",
                      { priceMinor: base, priceCurrency: form.currency },
                      { adjustBp: l.adjustBp, prices: new Map() },
                    )
              return (
                <Field
                  key={l.id}
                  label={l.name}
                  htmlFor={`p-list-${l.id}`}
                  hint={
                    fallback
                      ? `Vacío: ${formatMoney(fallback.priceMinor, fallback.priceCurrency)} (${adjustLabel(l.adjustBp)})`
                      : `Vacío: el precio normal (${adjustLabel(l.adjustBp)})`
                  }
                  error={errors[`list-${l.id}`]}
                >
                  <Input
                    id={`p-list-${l.id}`}
                    inputMode="decimal"
                    value={listPrices[l.id] ?? ""}
                    onChange={(e) => setListPrices((s) => ({ ...s, [l.id]: e.target.value }))}
                    placeholder="Opcional"
                    className="tabular"
                  />
                </Field>
              )
            })}
          </fieldset>
        ) : null}
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
            <Field
              label="Tipo"
              htmlFor="p-kind"
              hint={
                features.recipes
                  ? "Un plato no lleva existencia: si tiene receta, se gastan sus ingredientes"
                  : "Los servicios no llevan existencia"
              }
            >
              <NativeSelect id="p-kind" value={form.kind} onChange={set("kind")}>
                <option value="good">Producto (lleva existencia)</option>
                <option value="service">
                  {features.recipes ? "Plato o servicio" : "Servicio"}
                </option>
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

        {features.recipes ? (
          <RecipeEditor
            rows={recipe}
            setRows={setRecipe}
            ingredients={ingredients}
            ctx={ctx}
            price={
              parseAmount(form.price) !== null
                ? { priceMinor: parseAmount(form.price) ?? 0, priceCurrency: form.currency }
                : null
            }
            tracksStock={tracksStock}
          />
        ) : null}

        {modifierGroups.length ? (
          <fieldset className="grid min-w-0 grid-cols-1 gap-2">
            <legend className="mb-1.5 font-medium text-sm">Opciones y extras</legend>
            <div className="flex flex-wrap gap-1.5">
              {modifierGroups.map((g) => {
                const on = groupIds.includes(g.id)
                return (
                  <Button
                    key={g.id}
                    type="button"
                    variant={on ? "default" : "outline"}
                    size="sm"
                    className="h-8 rounded-full"
                    aria-pressed={on}
                    onClick={() =>
                      setGroupIds((ids) => (on ? ids.filter((x) => x !== g.id) : [...ids, g.id]))
                    }
                  >
                    {on ? <CheckIcon /> : <PlusIcon />} {g.name}
                  </Button>
                )
              })}
            </div>
            <p className="text-muted-foreground text-xs">
              Se eligen al venderlo, en este orden. Se arman en Productos → Más → Opciones y extras.
            </p>
          </fieldset>
        ) : null}

        {showVariants ? (
          <div className="flex items-start gap-3">
            <input
              id="p-variants"
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--primary)]"
              checked={hasVariants}
              onChange={(e) => toggleVariants(e.target.checked)}
            />
            <div className="grid gap-1">
              <Label htmlFor="p-variants">Tiene tallas, colores u otras características</Label>
              <p className="text-muted-foreground text-xs">
                Cada combinación (M azul, L negra) lleva su código, su precio y su existencia.
              </p>
            </div>
          </div>
        ) : null}
        {hasVariants ? (
          <div className="grid min-w-0 gap-2">
            {variantIssue ? <p className="text-destructive text-sm">{variantIssue}</p> : null}
            <VariantsEditor
              draft={draft}
              onChange={(d) => {
                setDraft(d)
                setErrorKey(null)
              }}
              basePrice={form.price}
              tracksStock={tracksStock}
              assigned={assigned}
              onAssign={(key) => {
                setAssignKey(key)
                // Lo escrito en la combinación anterior era de esa variante: vuelve a quedar vacía.
                setDraft((d) => ({
                  ...d,
                  combos: Object.fromEntries(
                    Object.entries(d.combos).filter(([, c]) => c.id !== item?.variantId),
                  ),
                }))
              }}
              errorKey={errorKey}
            />
          </div>
        ) : hadOptions ? (
          <Field
            label="Se sigue vendiendo como"
            htmlFor="p-keep"
            hint="Las demás combinaciones dejan de venderse, con lo que tengan en existencia."
          >
            <NativeSelect id="p-keep" value={keepId} onChange={(e) => setKeepId(e.target.value)}>
              {sellable.map((v) => (
                <option key={v.variantId} value={v.variantId}>
                  {v.optionValues?.join(", ") ?? v.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Código de barras" htmlFor="p-barcode" error={errors.barcode}>
              <div className="flex gap-2">
                <Input
                  id="p-barcode"
                  value={form.barcode}
                  onChange={set("barcode")}
                  placeholder="Opcional"
                />
                <ScanButton
                  label="Leer el código con la cámara"
                  onCode={(code) => setForm((f) => ({ ...f, barcode: code }))}
                />
              </div>
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
        )}
        {tracksStock ? (
          <Field
            label="Existencia mínima"
            htmlFor="p-min"
            hint={
              hasVariants
                ? "De cada combinación: al llegar a esta cantidad aparece en «Por reponer»"
                : "Al llegar a esta cantidad aparece en «Por reponer» del inicio"
            }
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
        {tracksStock && lotsOn ? (
          <div className="flex items-start gap-3">
            <input
              id="p-lots"
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--primary)]"
              checked={form.tracksLots}
              onChange={set("tracksLots")}
            />
            <div className="grid gap-1">
              <Label htmlFor="p-lots">Lleva lotes con vencimiento</Label>
              <p className="text-muted-foreground text-xs">
                Al comprarlo se anota la fecha de vencimiento; se vende primero lo que vence antes.
              </p>
            </div>
          </div>
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
    </>
  )
}
