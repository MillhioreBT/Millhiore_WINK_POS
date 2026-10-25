import type { CatalogItem } from "@millhiore/contracts"
import { Badge, Button, Input } from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { SearchIcon } from "lucide-react"
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { ScanButton } from "../../components/CameraScanner"
import { groupByProduct } from "../../components/VariantGrid"
import { formatMoney, formatQty, perUnit } from "../../lib/format"
import { stockAt } from "../../lib/locations"
import { bootstrapQuery, categoriesQuery } from "../../lib/queries"
import { type CodeMatch, matchCode } from "../../lib/scanner"
import { can, useMe } from "../../lib/session"
import { type PosContext, priceWithList, qtyForMoney, unitPriceInDoc } from "./compute"
import { VariantPickerDialog } from "./VariantPickerDialog"

/**
 * Con mouse (o lector de códigos) la búsqueda vuelve a tener el foco tras cada producto; en una
 * pantalla táctil eso abriría el teclado en cada toque.
 */
export const finePointer =
  typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
}

/**
 * El catálogo para vender o pedir: búsqueda (también con la cámara o un lector USB), categorías y
 * una tarjeta por producto. Los que tienen tallas y colores abren la cuadrícula para elegir.
 */
export function CatalogPanel({
  ctx,
  products,
  priceListId,
  locationId,
  onAdd,
  paused,
  searchRef: externalRef,
  banner,
}: {
  ctx: PosContext
  products: CatalogItem[] | undefined
  priceListId: string | null
  /** De dónde se vende: la existencia que muestran las tarjetas. */
  locationId: string
  /** Con `qtyMilli` ya se sabe cuánto (la etiqueta de la balanza trae el peso o el precio). */
  onAdd: (item: CatalogItem, qtyMilli?: number) => void
  /** Hay un diálogo abierto: el lector USB no agrega nada. */
  paused: boolean
  searchRef?: RefObject<HTMLInputElement | null>
  /** Avisos sobre la búsqueda (falta la tasa…). */
  banner?: ReactNode
}) {
  const me = useMe()
  const ownRef = useRef<HTMLInputElement>(null)
  const searchRef = externalRef ?? ownRef
  const [search, setSearch] = useState("")
  // Producto con tallas y colores: se elige la combinación antes de agregarlo.
  const [picking, setPicking] = useState<CatalogItem[] | null>(null)
  const doc = ctx.docCurrency

  const categories = useQuery(categoriesQuery())
  const [category, setCategory] = useState("")
  // Solo se ofrecen las categorías que tienen productos a la venta (y «Sin categoría» si hay).
  const chips = useMemo(() => {
    const items = products ?? []
    const used = new Set(items.map((p) => p.categoryId))
    return {
      list: (categories.data ?? []).filter((c) => used.has(c.id)),
      hasNone: used.has(null) && used.size > 1,
    }
  }, [products, categories.data])
  // Si la categoría elegida deja de existir (se desactivó o ya no tiene productos), vuelve «Todas».
  const activeCategory =
    category === "none"
      ? chips.hasNone
        ? "none"
        : ""
      : chips.list.some((c) => c.id === category)
        ? category
        : ""

  const filtered = useMemo(() => {
    const all = products ?? []
    const q = normalize(search.trim())
    // Buscar escribiendo recorre todo el catálogo; las categorías solo filtran sin búsqueda.
    if (!q) {
      return activeCategory === "none"
        ? all.filter((p) => p.categoryId === null)
        : activeCategory
          ? all.filter((p) => p.categoryId === activeCategory)
          : all
    }
    return all.filter(
      (p) =>
        normalize(p.name).includes(q) || p.sku.toLowerCase() === q || p.barcode === search.trim(),
    )
  }, [products, search, activeCategory])

  // Lo que se muestra: cada producto sencillo y, de los que tienen tallas y colores, una tarjeta
  // con todas sus combinaciones (aunque la búsqueda solo haya encontrado algunas).
  const cards = useMemo(() => {
    const all = new Map<string, CatalogItem[]>()
    for (const p of products ?? []) {
      if (!p.options) continue
      const group = all.get(p.productId)
      if (group) group.push(p)
      else all.set(p.productId, [p])
    }
    return groupByProduct(filtered).map((g) => (g[0]?.options ? (all.get(g[0].productId) ?? g) : g))
  }, [products, filtered])

  const add = (item: CatalogItem, qtyMilli?: number) => {
    onAdd(item, qtyMilli)
    setSearch("")
    if (finePointer) searchRef.current?.focus()
  }

  // Las etiquetas de la balanza traen el producto con su peso o su precio.
  const boot = useQuery(bootstrapQuery)
  const scale = boot.data?.features.scale ? boot.data.scale : null
  const byCode = (code: string): CodeMatch | undefined => matchCode(products ?? [], code, scale)
  /** Agrega lo leído; false si no hay producto con ese código. */
  const addCode = (code: string): boolean => {
    const m = byCode(code)
    if (!m) return false
    if (m.priceMinor !== undefined && scale) {
      const price = priceWithList(ctx, priceListId, m.item.variantId, m.item)
      const qty = qtyForMoney(
        ctx,
        { minor: m.priceMinor, currency: scale.priceCurrency },
        unitPriceInDoc(ctx, price.priceMinor, price.priceCurrency),
      )
      if (qty === null) {
        toast.error(`No se pudo calcular cuánto lleva la etiqueta de ${m.item.name}`)
        return true
      }
      add(m.item, qty)
    } else add(m.item, m.weightMilli)
    return true
  }

  // F2 busca.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F2") return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [searchRef])

  // Lector de códigos USB sin foco: teclea como un teclado, pero en ráfaga (pocos ms entre
  // teclas) y termina con Enter. Así se escanea aunque el cursor no esté en el buscador.
  const scan = useRef({ code: "", last: 0 })
  const busy = paused || picking !== null
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return
      const target = e.target as HTMLElement | null
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return
      const now = performance.now()
      const s = scan.current
      if (e.key === "Enter") {
        if (s.code.length >= 4 && now - s.last < 100) {
          e.preventDefault()
          const code = s.code
          if (!addCode(code)) toast.error(`No hay ningún producto con el código ${code}`)
        }
        s.code = ""
        return
      }
      if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return
      if (now - s.last > 50) s.code = ""
      s.code += e.key
      s.last = now
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  // Enter en la búsqueda: código de barras/SKU exacto, o el único resultado.
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") setSearch("")
    if (e.key !== "Enter") return
    const term = search.trim()
    if (!term) return
    if (addCode(term)) return
    const only = cards.length === 1 ? cards[0] : undefined
    if (only?.[0]?.options) setPicking(only)
    else if (only?.[0]) add(only[0])
  }

  return (
    <section className="flex min-h-0 flex-col gap-3">
      {banner}
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchRef}
          autoFocus={finePointer}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder={
            finePointer ? "Buscar producto o escanear código (F2)" : "Buscar producto o código"
          }
          className="h-12 pr-12 pl-10 text-base"
          aria-label="Buscar producto"
        />
        {/* Escanear con la cámara del celular o la PC; sigue leyendo hasta cerrarlo. */}
        <ScanButton
          continuous
          className="absolute top-1/2 right-1.5 size-9 -translate-y-1/2 border-0 shadow-none"
          onCode={(code) => {
            const m = byCode(code)
            if (!m || !addCode(code)) {
              toast.error(`No hay ningún producto con el código ${code}`)
              return
            }
            toast.success(`${m.item.name} agregado`)
          }}
        />
      </div>
      {chips.list.length ? (
        <div
          className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
          role="tablist"
          aria-label="Categorías"
        >
          {[
            { id: "", name: "Todas" },
            ...chips.list,
            ...(chips.hasNone ? [{ id: "none", name: "Sin categoría" }] : []),
          ].map((c) => (
            <Button
              key={c.id || "all"}
              role="tab"
              aria-selected={activeCategory === c.id}
              variant={activeCategory === c.id ? "default" : "outline"}
              size="sm"
              className="shrink-0 rounded-full"
              onClick={() => setCategory(c.id)}
            >
              {c.name}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {products?.length === 0 ? (
          <div className="grid place-items-center gap-2 rounded-xl border border-dashed p-10 text-center text-muted-foreground">
            <p>Aún no hay productos.</p>
            {can(me, "catalog.manage") ? (
              <Button asChild variant="outline">
                <Link to="/productos">Crear productos</Link>
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          {cards.map((group) => {
            const p = group[0]
            if (!p) return null
            const isGroup = p.options !== null
            const units = group.map((v) => {
              const own = priceWithList(ctx, priceListId, v.variantId, v)
              return {
                price: own,
                unit: unitPriceInDoc(ctx, own.priceMinor, own.priceCurrency),
              }
            })
            // De un producto con tallas, el menor precio («desde») y lo que hay de todas.
            const cheapest = units.reduce((a, b) =>
              (b.unit ?? Number.POSITIVE_INFINITY) < (a.unit ?? Number.POSITIVE_INFINITY) ? b : a,
            )
            const price = cheapest.price
            const unit = cheapest.unit
            const varies = units.some((u) => u.unit !== unit)
            const stock = group.reduce((acc, v) => acc + stockAt(v, locationId), 0)
            return (
              <button
                key={isGroup ? p.productId : p.variantId}
                type="button"
                onClick={() => (isGroup ? setPicking(group) : add(p))}
                className="flex min-h-24 cursor-pointer flex-col justify-between gap-2 rounded-xl border bg-card p-3 text-left shadow-xs transition-colors hover:border-primary hover:bg-accent/50 active:scale-[0.99]"
              >
                <span className="line-clamp-2 font-medium leading-tight">
                  {isGroup ? p.productName : p.name}
                  {isGroup ? (
                    <span className="block font-normal text-muted-foreground text-xs">
                      {p.options?.map((o) => o.name).join(" · ")}
                    </span>
                  ) : null}
                </span>
                <span className="flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
                  <span className="grid">
                    <span className="tabular whitespace-nowrap font-semibold">
                      {varies ? <span className="font-normal text-xs">desde </span> : null}
                      {unit === null ? "—" : formatMoney(unit, doc)}
                      {unit === null ? null : (
                        <span className="font-normal text-muted-foreground text-xs">
                          {perUnit(p.unit)}
                        </span>
                      )}
                    </span>
                    {price.priceCurrency !== doc ? (
                      <span className="tabular text-muted-foreground text-xs">
                        {formatMoney(price.priceMinor, price.priceCurrency)}
                        {perUnit(p.unit)}
                      </span>
                    ) : null}
                  </span>
                  {p.tracksStock ? (
                    // La caja vende de su ubicación: muestra lo que hay ahí.
                    <Badge variant={stock > 0 ? "secondary" : "warning"} className="tabular">
                      {/* Corto en la tarjeta: «12,35 kg», sin los ceros de los gramos. */}
                      {p.unit === "unit" ? formatQty(stock) : `${formatQty(stock)} ${p.unit}`}
                    </Badge>
                  ) : null}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      {picking ? (
        <VariantPickerDialog
          items={picking}
          ctx={ctx}
          priceListId={priceListId}
          locationId={locationId}
          onPick={(item) => {
            setPicking(null)
            add(item)
            toast.success(`${item.name} agregado`)
          }}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </section>
  )
}
