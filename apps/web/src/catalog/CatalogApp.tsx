import type { PublicCatalog, PublicProduct } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from "@millhiore/ui"
import { MapPinIcon, MessageCircleIcon, PhoneIcon, SearchIcon, ShoppingBagIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { formatDay, formatMoney, formatRate } from "../lib/format"
import { addLine, type CartLine, itemCount, loadCart, parseQty, priced, saveCart } from "./cart"
import { OrderDialog, QuantityInput } from "./OrderDialog"
import {
  cheapest,
  chooseValue,
  initialValues,
  matches,
  priceText,
  soldOut,
  valueExists,
  variantFor,
} from "./view"

type Load =
  | { state: "loading" }
  | { state: "ready"; catalog: PublicCatalog }
  | { state: "error"; message: string }

async function fetchCatalog(): Promise<PublicCatalog> {
  let res: Response
  try {
    res = await fetch("/api/public/catalog")
  } catch {
    throw new Error("No se pudo cargar el catálogo. Revisa tu conexión y vuelve a intentar.")
  }
  if (res.ok) return (await res.json()) as PublicCatalog
  const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
  if (body?.error?.code === "CATALOG_OFF")
    throw new Error("Este catálogo no está disponible por ahora.")
  if (res.status === 429)
    throw new Error("Demasiadas consultas: espera un momento y vuelve a intentar.")
  throw new Error("No se pudo cargar el catálogo. Vuelve a intentar en un rato.")
}

const waLink = (number: string, text?: string) =>
  `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ""}`

/** El catálogo en línea: lo que vende el negocio, con fotos y precios, para cualquiera. */
export function CatalogApp() {
  const [load, setLoad] = useState<Load>({ state: "loading" })
  const reload = useCallback(() => {
    setLoad({ state: "loading" })
    fetchCatalog()
      .then((catalog) => {
        setLoad({ state: "ready", catalog })
        document.title = `${catalog.business.name} · Catálogo`
      })
      .catch((e: Error) => setLoad({ state: "error", message: e.message }))
  }, [])
  useEffect(reload, [reload])

  if (load.state === "loading") {
    return <p className="p-8 text-center text-muted-foreground text-sm">Cargando el catálogo…</p>
  }
  if (load.state === "error") {
    return (
      <div className="mx-auto grid max-w-sm gap-3 p-8 text-center">
        <p className="text-sm">{load.message}</p>
        <Button variant="outline" className="justify-self-center" onClick={reload}>
          Volver a intentar
        </Button>
      </div>
    )
  }
  return <Catalog catalog={load.catalog} />
}

function Catalog({ catalog }: { catalog: PublicCatalog }) {
  const [term, setTerm] = useState("")
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [open, setOpen] = useState<PublicProduct | null>(null)
  // El pedido vive en el equipo del cliente; lo que ya no está en el catálogo se cae al abrir.
  const [cart, setCart] = useState<CartLine[]>(() =>
    catalog.orders ? priced(loadCart(), catalog).lines.map(toLine) : [],
  )
  const [ordering, setOrdering] = useState(false)
  useEffect(() => saveCart(cart), [cart])
  const total = priced(cart, catalog)
  const totalText =
    total.reference !== null && catalog.currencies !== "legal"
      ? formatMoney(total.reference, catalog.referenceCurrency)
      : total.legal !== null
        ? formatMoney(total.legal, catalog.legalCurrency)
        : ""
  const shown = useMemo(
    () =>
      catalog.products.filter(
        (p) => (categoryId === null || p.categoryId === categoryId) && matches(p, term),
      ),
    [catalog, categoryId, term],
  )
  const { business } = catalog

  return (
    <div className="mx-auto grid min-h-dvh max-w-5xl grid-cols-1 content-start gap-4 px-4 pt-4 pb-24">
      <header className="grid gap-1">
        <h1 className="font-semibold text-xl leading-tight">{business.name}</h1>
        {business.address || business.phone ? (
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground text-xs">
            {business.address ? (
              <span className="inline-flex items-center gap-1">
                <MapPinIcon className="size-3" /> {business.address}
              </span>
            ) : null}
            {business.phone ? (
              <a
                href={`tel:${business.phone}`}
                className="inline-flex items-center gap-1 underline"
              >
                <PhoneIcon className="size-3" /> {business.phone}
              </a>
            ) : null}
          </p>
        ) : null}
        {catalog.message ? (
          <p className="mt-2 whitespace-pre-line rounded-lg bg-accent px-3 py-2 text-accent-foreground text-sm">
            {catalog.message}
          </p>
        ) : null}
      </header>

      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label="Buscar en el catálogo"
          placeholder="Buscar"
          className="pl-9"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </div>

      {catalog.categories.length ? (
        <nav aria-label="Categorías" className="flex flex-wrap gap-1.5">
          {[{ id: null, name: "Todo" }, ...catalog.categories].map((c) => (
            <Button
              key={c.id ?? "all"}
              size="sm"
              variant={categoryId === c.id ? "default" : "outline"}
              className="h-8 rounded-full"
              aria-pressed={categoryId === c.id}
              onClick={() => setCategoryId(c.id)}
            >
              {c.name}
            </Button>
          ))}
        </nav>
      ) : null}

      {shown.length === 0 ? (
        <p className="py-10 text-center text-muted-foreground text-sm">
          {catalog.products.length ? "No hay nada con esa búsqueda." : "Todavía no hay productos."}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((p) => (
            <li key={p.id} className="min-w-0">
              <ProductCard product={p} catalog={catalog} onOpen={() => setOpen(p)} />
            </li>
          ))}
        </ul>
      )}

      <footer className="grid gap-1 pt-4 text-center text-muted-foreground text-xs">
        <p>
          Precios con IVA incluido
          {catalog.rate && catalog.currencies !== "reference"
            ? `. Bolívares a la tasa del ${formatDay(catalog.rate.effectiveAt)}: ${formatRate(catalog.rate.value)}`
            : ""}
          .
        </p>
        <p>Hecho con Millhiore WINK POS</p>
      </footer>

      {cart.length ? (
        <Button
          className="fixed inset-x-4 bottom-4 h-12 rounded-full shadow-lg sm:right-4 sm:left-auto sm:px-6"
          onClick={() => setOrdering(true)}
        >
          <ShoppingBagIcon /> Ver mi pedido ({itemCount(cart).toLocaleString("es-VE")}) ·{" "}
          {totalText}
        </Button>
      ) : catalog.whatsapp ? (
        <a
          href={waLink(catalog.whatsapp)}
          target="_blank"
          rel="noreferrer"
          className="fixed right-4 bottom-4 inline-flex h-12 items-center gap-2 rounded-full bg-[#25d366] px-5 font-medium text-sm text-white shadow-lg"
        >
          <MessageCircleIcon className="size-5" /> Escríbenos
        </a>
      ) : null}

      {open ? (
        <ProductDialog
          product={open}
          catalog={catalog}
          onClose={() => setOpen(null)}
          {...(catalog.orders
            ? { onAdd: (line: CartLine) => setCart((c) => addLine(c, line)) }
            : {})}
        />
      ) : null}
      {ordering ? (
        <OrderDialog
          catalog={catalog}
          lines={cart}
          onChange={setCart}
          onClose={() => setOrdering(false)}
          onPlaced={() => setCart([])}
        />
      ) : null}
    </div>
  )
}

function Photo({ product, className }: { product: PublicProduct; className?: string }) {
  if (product.imageUrl) {
    return (
      <img
        src={product.imageUrl}
        alt={product.name}
        loading="lazy"
        decoding="async"
        className={`aspect-square w-full bg-muted object-cover ${className ?? ""}`}
      />
    )
  }
  return (
    <div
      aria-hidden
      className={`grid aspect-square w-full place-items-center bg-muted font-semibold text-3xl text-muted-foreground ${className ?? ""}`}
    >
      {product.name.slice(0, 1).toUpperCase()}
    </div>
  )
}

function ProductCard({
  product,
  catalog,
  onOpen,
}: {
  product: PublicProduct
  catalog: PublicCatalog
  onOpen: () => void
}) {
  const { variant, from } = cheapest(product)
  const price = priceText(variant, catalog, product.unit)
  const out = soldOut(product)
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={product.name}
      className="grid w-full cursor-pointer overflow-hidden rounded-xl border bg-card text-left text-card-foreground transition hover:shadow-md focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="relative">
        <Photo product={product} className={out ? "opacity-50" : ""} />
        {out ? (
          <Badge variant="secondary" className="absolute top-2 left-2">
            Agotado
          </Badge>
        ) : null}
      </div>
      <div className="grid gap-0.5 p-2.5">
        <span className="line-clamp-2 font-medium text-sm leading-snug">{product.name}</span>
        <span className="font-semibold text-sm tabular">
          {from ? <span className="font-normal text-muted-foreground text-xs">desde </span> : null}
          {price.main}
        </span>
        {price.other ? (
          <span className="text-muted-foreground text-xs tabular">{price.other}</span>
        ) : null}
      </div>
    </button>
  )
}

/** Lo que guarda el pedido (sin los precios, que se toman del catálogo al mostrarlo). */
const toLine = ({ variantId, name, unit, qtyMilli, note }: CartLine): CartLine => ({
  variantId,
  name,
  unit,
  qtyMilli,
  note,
})

function ProductDialog({
  product,
  catalog,
  onClose,
  onAdd,
}: {
  product: PublicProduct
  catalog: PublicCatalog
  onClose: () => void
  /** Si la tienda recibe pedidos: agregar al pedido. */
  onAdd?: (line: CartLine) => void
}) {
  const [values, setValues] = useState(() => initialValues(product))
  const [qty, setQty] = useState("1")
  const [note, setNote] = useState("")
  const chosen = variantFor(product, values)
  const price = chosen ? priceText(chosen, catalog, product.unit) : null
  const label = product.options ? `${product.name} (${values.join(", ")})` : product.name
  const qtyMilli = parseQty(qty)
  const add = () => {
    if (!onAdd || !chosen || qtyMilli === null) return
    onAdd({
      variantId: chosen.id,
      name: label,
      unit: product.unit,
      qtyMilli:
        product.unit === "unit" ? Math.max(1, Math.round(qtyMilli / 1000)) * 1000 : qtyMilli,
      note: note.trim() || null,
    })
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md gap-3 p-0">
        <Photo product={product} className="rounded-t-xl" />
        <div className="grid gap-3 px-5 pb-5">
          <DialogHeader>
            <DialogTitle>{product.name}</DialogTitle>
            <DialogDescription className={product.description ? "whitespace-pre-line" : "sr-only"}>
              {product.description ?? `Precio de ${product.name}`}
            </DialogDescription>
          </DialogHeader>
          {product.options?.map((o, i) => (
            <fieldset key={o.name} className="grid min-w-0 gap-1.5">
              <legend className="mb-1 font-medium text-sm">{o.name}</legend>
              <div className="flex flex-wrap gap-1.5">
                {o.values.map((value) => {
                  if (!product.variants.some((v) => v.optionValues?.[i] === value)) return null
                  const on = values[i] === value
                  return (
                    <Button
                      key={value}
                      size="sm"
                      variant={on ? "default" : "outline"}
                      className={`h-8 rounded-full ${valueExists(product, i, value, values) ? "" : "opacity-60"}`}
                      aria-pressed={on}
                      onClick={() => setValues(chooseValue(product, values, i, value))}
                    >
                      {value}
                    </Button>
                  )
                })}
              </div>
            </fieldset>
          ))}
          {price ? (
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold text-xl tabular">{price.main}</span>
              {price.other ? (
                <span className="text-muted-foreground text-sm tabular">{price.other}</span>
              ) : null}
              {chosen && !chosen.available ? <Badge variant="secondary">Agotado</Badge> : null}
            </div>
          ) : null}
          {onAdd && chosen?.available ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium text-sm">Cantidad</span>
                <QuantityInput unit={product.unit} value={qty} onChange={setQty} />
              </div>
              <Input
                aria-label="Indicaciones"
                placeholder="Indicaciones (opcional): sin cebolla, bien frío…"
                maxLength={140}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <Button onClick={add} disabled={qtyMilli === null}>
                <ShoppingBagIcon /> Agregar al pedido
              </Button>
            </>
          ) : null}
          {catalog.whatsapp && chosen && !onAdd ? (
            <Button asChild className="bg-[#25d366] text-white hover:bg-[#1ebe5a]">
              <a
                href={waLink(
                  catalog.whatsapp,
                  `Hola, me interesa: ${label}${price ? ` (${price.main})` : ""}`,
                )}
                target="_blank"
                rel="noreferrer"
              >
                <MessageCircleIcon /> Preguntar por WhatsApp
              </a>
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
