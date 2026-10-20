import type { CatalogItem } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  Input,
  NativeSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { BoxesIcon, PencilIcon, PlusIcon, SearchIcon, TagsIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { formatMoney, formatPercent, formatQty } from "../../lib/format"
import { bootstrapQuery, categoriesQuery, productsQuery, rateStatusQuery } from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { convertMinor, makeContext } from "../pos/compute"
import { CategoriesDialog } from "./CategoriesDialog"
import { ProductDialog } from "./ProductDialog"
import { StockDialog } from "./StockDialog"

export function ProductsPage() {
  const me = useMe()
  const { data: boot } = useQuery(bootstrapQuery)
  const rate = useQuery(rateStatusQuery)
  const [showInactive, setShowInactive] = useState(false)
  const products = useQuery(productsQuery({ all: showInactive }))
  const [search, setSearch] = useState("")
  const [editing, setEditing] = useState<CatalogItem | null | undefined>(undefined)
  const [adjusting, setAdjusting] = useState<CatalogItem | null>(null)
  const [categoryFilter, setCategoryFilter] = useState("")
  const [managingCategories, setManagingCategories] = useState(false)
  const categories = useQuery(categoriesQuery({ all: true }))
  const categoryName = (id: string | null) => categories.data?.find((c) => c.id === id)?.name
  const canManage = can(me, "catalog.manage")
  const canAdjust = can(me, "inventory.adjust")

  const ctx = useMemo(
    () => (boot ? makeContext(boot, rate.data?.current?.value ?? null) : null),
    [boot, rate.data],
  )
  const taxLabel = (taxId: string | null) => {
    const id = taxId ?? boot?.fiscal.defaultTaxId
    const t = boot?.taxes.find((x) => x.id === id)
    if (!t) return "—"
    return t.kind === "taxed" ? `${t.code} ${formatPercent(t.rateBp)}` : `${t.code} exento`
  }

  const rows = (products.data ?? []).filter((p) => {
    if (categoryFilter === "none" && p.categoryId !== null) return false
    if (categoryFilter && categoryFilter !== "none" && p.categoryId !== categoryFilter) return false
    const q = search.trim().toLowerCase()
    return !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase() === q || p.barcode === q
  })

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-xl">Productos</h1>
        <div className="relative ml-auto w-full sm:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o código"
            className="pl-9"
            aria-label="Buscar productos"
          />
        </div>
        <NativeSelect
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="w-44"
          aria-label="Filtrar por categoría"
        >
          <option value="">Todas las categorías</option>
          {(categories.data ?? [])
            .filter((c) => c.active)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          <option value="none">Sin categoría</option>
        </NativeSelect>
        <Button variant="outline" onClick={() => setManagingCategories(true)}>
          <TagsIcon /> Categorías
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Ver inactivos
        </label>
        {canManage ? (
          <Button onClick={() => setEditing(null)}>
            <PlusIcon /> Nuevo producto
          </Button>
        ) : null}
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Producto</TableHead>
              <TableHead className="hidden md:table-cell">Código</TableHead>
              <TableHead className="text-right">Precio</TableHead>
              <TableHead className="hidden text-right md:table-cell">En Bs hoy</TableHead>
              <TableHead className="hidden lg:table-cell">IVA</TableHead>
              <TableHead className="text-right">
                <span className="hidden sm:inline">Existencia</span>
                <span className="sm:hidden">Exist.</span>
              </TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  {products.isLoading ? "Cargando…" : "No hay productos que mostrar."}
                </TableCell>
              </TableRow>
            ) : null}
            {rows.map((p) => {
              const inDoc = ctx && convertMinor(ctx, p.priceMinor, p.priceCurrency, ctx.docCurrency)
              return (
                <TableRow key={p.variantId} className={p.active ? "" : "opacity-60"}>
                  <TableCell className="whitespace-normal font-medium">
                    {p.name}
                    <span className="block font-normal text-muted-foreground text-xs md:hidden">
                      {p.barcode ?? p.sku}
                    </span>
                    {p.kind === "service" ? (
                      <Badge variant="secondary" className="ml-2">
                        Servicio
                      </Badge>
                    ) : null}
                    {categoryName(p.categoryId) ? (
                      <span className="block font-normal text-muted-foreground text-xs">
                        {categoryName(p.categoryId)}
                      </span>
                    ) : null}
                    {p.active ? null : (
                      <Badge variant="outline" className="ml-2">
                        Inactivo
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground text-xs md:table-cell">
                    {p.sku}
                    {p.barcode ? <div>{p.barcode}</div> : null}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {formatMoney(p.priceMinor, p.priceCurrency)}
                    {inDoc !== null && ctx && p.priceCurrency !== ctx.docCurrency ? (
                      <span className="block text-muted-foreground text-xs md:hidden">
                        {formatMoney(inDoc, ctx.docCurrency)}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="tabular hidden text-right text-muted-foreground md:table-cell">
                    {inDoc === null || !ctx ? "—" : formatMoney(inDoc, ctx.docCurrency)}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">{taxLabel(p.taxId)}</TableCell>
                  <TableCell className="tabular text-right">
                    {!p.tracksStock ? (
                      "—"
                    ) : p.stockMilli > 0 &&
                      p.minStockMilli !== null &&
                      p.stockMilli <= p.minStockMilli ? (
                      <Badge
                        variant="warning"
                        className="tabular"
                        title={`Mínimo ${formatQty(p.minStockMilli)}`}
                      >
                        {formatQty(p.stockMilli)}
                      </Badge>
                    ) : (
                      <span className={p.stockMilli <= 0 ? "text-destructive" : ""}>
                        {formatQty(p.stockMilli)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-0.5 sm:gap-1">
                      {canAdjust && p.tracksStock ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="px-2 sm:px-3"
                          aria-label="Existencia"
                          title="Ajustar existencia"
                          onClick={() => setAdjusting(p)}
                        >
                          <BoxesIcon /> <span className="hidden sm:inline">Existencia</span>
                        </Button>
                      ) : null}
                      {canManage ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="px-2 sm:px-3"
                          aria-label="Editar"
                          title="Editar"
                          onClick={() => setEditing(p)}
                        >
                          <PencilIcon /> <span className="hidden sm:inline">Editar</span>
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>

      {editing !== undefined ? (
        <ProductDialog
          key={editing?.productId ?? "new"}
          item={editing}
          open
          onClose={() => setEditing(undefined)}
        />
      ) : null}
      {adjusting ? <StockDialog item={adjusting} onClose={() => setAdjusting(null)} /> : null}
      {managingCategories ? (
        <CategoriesDialog canManage={canManage} onClose={() => setManagingCategories(false)} />
      ) : null}
    </div>
  )
}
