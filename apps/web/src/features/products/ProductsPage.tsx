import type { CatalogItem } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  Input,
  NativeSelect,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  BoxesIcon,
  ChevronRightIcon,
  CookingPotIcon,
  EllipsisIcon,
  ListIcon,
  ListPlusIcon,
  PencilIcon,
  PercentIcon,
  PlusIcon,
  PrinterIcon,
  SearchIcon,
  TagsIcon,
  TicketPercentIcon,
  UploadIcon,
} from "lucide-react"
import { Fragment, useMemo, useState } from "react"
import { ScanButton } from "../../components/CameraScanner"
import { CentralNotice } from "../../components/CentralNotice"
import { ImportDialog } from "../../components/ImportDialog"
import {
  formatDate,
  formatMoney,
  formatPercent,
  formatQty,
  formatQtyUnit,
  perUnit,
} from "../../lib/format"
import { productImport } from "../../lib/importConfigs"
import { stockAt, useLocations } from "../../lib/locations"
import { bootstrapQuery, categoriesQuery, productsQuery, rateStatusQuery } from "../../lib/queries"
import { can, useFeatures, useMe } from "../../lib/session"
import { useTerminal } from "../../lib/terminal"
import { NewProductionDialog } from "../inventory/NewProductionDialog"
import { LabelsDialog } from "../labels/LabelsDialog"
import { convertMinor, makeContext } from "../pos/compute"
import { BulkPriceDialog } from "./BulkPriceDialog"
import { CategoriesDialog } from "./CategoriesDialog"
import { DiscountCodesDialog } from "./DiscountCodesDialog"
import { ModifierGroupsDialog } from "./ModifierGroupsDialog"
import { PriceListsDialog } from "./PriceListsDialog"
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
  const [producing, setProducing] = useState<CatalogItem | null>(null)
  const terminal = useTerminal()
  const [categoryFilter, setCategoryFilter] = useState("")
  const [managingCategories, setManagingCategories] = useState(false)
  const [repricing, setRepricing] = useState(false)
  const [managingLists, setManagingLists] = useState(false)
  const [managingModifiers, setManagingModifiers] = useState(false)
  const [importing, setImporting] = useState(false)
  const [managingCodes, setManagingCodes] = useState(false)
  const [labeling, setLabeling] = useState(false)
  // Productos con tallas y colores abiertos para ver cada combinación.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const categories = useQuery(categoriesQuery({ all: true }))
  const categoryName = (id: string | null) => categories.data?.find((c) => c.id === id)?.name
  const canManage = can(me, "catalog.manage")
  const features = useFeatures()
  const locations = useLocations()
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

  // Las tallas y colores de un producto van juntas, debajo de él.
  const groups: CatalogItem[][] = []
  const byProduct = new Map<string, CatalogItem[]>()
  for (const p of rows) {
    const group = byProduct.get(p.productId)
    if (group) group.push(p)
    else {
      const created = [p]
      byProduct.set(p.productId, created)
      groups.push(created)
    }
  }
  const toggle = (productId: string) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(productId)) next.delete(productId)
      else next.add(productId)
      return next
    })

  const stockCell = (p: CatalogItem) =>
    !p.tracksStock ? (
      "—"
    ) : p.stockMilli > 0 && p.minStockMilli !== null && p.stockMilli <= p.minStockMilli ? (
      <Badge
        variant="warning"
        className="tabular"
        title={`Mínimo ${formatQtyUnit(p.minStockMilli, p.unit)}`}
      >
        {formatQtyUnit(p.stockMilli, p.unit)}
      </Badge>
    ) : (
      <span className={p.stockMilli <= 0 ? "text-destructive" : ""}>
        {formatQtyUnit(p.stockMilli, p.unit)}
      </span>
    )

  /** Un producto con tallas y colores: su nombre, el rango de precios y la existencia de todas. */
  const groupRow = (g: CatalogItem[], open: boolean) => {
    const first = g[0] as CatalogItem
    const prices = g.map((p) => p.priceMinor)
    const min = Math.min(...prices)
    const max = Math.max(...prices)
    const total = g.reduce((acc, p) => acc + p.stockMilli, 0)
    const low = g.some(
      (p) => p.tracksStock && p.minStockMilli !== null && p.stockMilli <= p.minStockMilli,
    )
    const inDoc = ctx && convertMinor(ctx, min, first.priceCurrency, ctx.docCurrency)
    const active = g.some((p) => p.active)
    return (
      <TableRow key={`g-${first.productId}`} className={active ? "" : "opacity-60"}>
        <TableCell className="whitespace-normal font-medium">
          <button
            type="button"
            className="flex cursor-pointer items-start gap-1 text-left"
            onClick={() => toggle(first.productId)}
            aria-expanded={open}
          >
            <ChevronRightIcon
              className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
            />
            <span>
              {first.productName}
              <span className="block font-normal text-muted-foreground text-xs">
                {g.length === 1 ? "1 combinación" : `${g.length} combinaciones`}
                {categoryName(first.categoryId) ? ` · ${categoryName(first.categoryId)}` : ""}
              </span>
            </span>
          </button>
        </TableCell>
        <TableCell className="hidden text-muted-foreground text-xs md:table-cell">
          {first.options?.map((o) => o.name).join(" · ")}
        </TableCell>
        <TableCell className="tabular text-right">
          {min === max
            ? formatMoney(min, first.priceCurrency)
            : `desde ${formatMoney(min, first.priceCurrency)}`}
        </TableCell>
        <TableCell className="tabular hidden text-right text-muted-foreground md:table-cell">
          {inDoc === null || !ctx ? "—" : formatMoney(inDoc, ctx.docCurrency)}
        </TableCell>
        <TableCell className="hidden lg:table-cell">{taxLabel(first.taxId)}</TableCell>
        <TableCell className="tabular text-right">
          {!first.tracksStock ? (
            "—"
          ) : low ? (
            <Badge variant="warning" className="tabular" title="Alguna combinación por reponer">
              {formatQty(total)}
            </Badge>
          ) : (
            formatQty(total)
          )}
        </TableCell>
        <TableCell>
          <div className="flex justify-end gap-0.5 sm:gap-1">
            {canManage ? (
              <Button
                variant="ghost"
                size="sm"
                className="px-2 sm:px-3"
                aria-label={`Editar ${first.productName}`}
                title="Editar"
                onClick={() => setEditing(first)}
              >
                <PencilIcon /> <span className="hidden sm:inline">Editar</span>
              </Button>
            ) : null}
          </div>
        </TableCell>
      </TableRow>
    )
  }

  const itemRow = (p: CatalogItem, nested: boolean) => {
    const inDoc = ctx && convertMinor(ctx, p.priceMinor, p.priceCurrency, ctx.docCurrency)
    return (
      <TableRow
        key={p.variantId}
        className={`${p.active ? "" : "opacity-60"} ${nested ? "bg-muted/30" : ""}`}
      >
        <TableCell className={`whitespace-normal font-medium ${nested ? "pl-8" : ""}`}>
          {nested ? (p.optionValues?.join(", ") ?? p.name) : p.name}
          <span className="block font-normal text-muted-foreground text-xs md:hidden">
            {p.barcode ?? p.sku}
          </span>
          {p.kind === "service" ? (
            <Badge variant="secondary" className="ml-2">
              Servicio
            </Badge>
          ) : null}
          {!nested && categoryName(p.categoryId) ? (
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
          {p.unit !== "unit" ? (
            <span className="text-muted-foreground text-xs">{perUnit(p.unit)}</span>
          ) : null}
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
          {stockCell(p)}
          {p.expiry && features.lots ? <ExpiryNote expiry={p.expiry} /> : null}
          {locations && p.tracksStock ? (
            <span className="block whitespace-normal text-muted-foreground text-xs">
              {locations
                .filter((l) => stockAt(p, l.id) !== 0)
                .map((l) => `${l.name} ${formatQty(stockAt(p, l.id))}`)
                .join(" · ")}
            </span>
          ) : null}
        </TableCell>
        <TableCell>
          <div className="flex justify-end gap-0.5 sm:gap-1">
            {features.recipes && canAdjust && p.tracksStock && p.hasRecipe ? (
              <Button
                variant="ghost"
                size="sm"
                className="px-2 sm:px-3"
                aria-label={`Producir ${p.name}`}
                title="Producir una tanda"
                onClick={() => setProducing(p)}
              >
                <CookingPotIcon /> <span className="hidden sm:inline">Producir</span>
              </Button>
            ) : null}
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
            {canManage && !nested ? (
              <Button
                variant="ghost"
                size="sm"
                className="px-2 sm:px-3"
                aria-label={`Editar ${p.name}`}
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
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <CentralNotice what="el catálogo (productos, precios, categorías y descuentos)" />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-xl">Productos</h1>
        <div className="relative ml-auto w-full sm:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o código"
            className="pr-11 pl-9"
            aria-label="Buscar productos"
          />
          <ScanButton
            className="absolute top-1/2 right-0.5 size-9 -translate-y-1/2 border-0 shadow-none"
            label="Buscar con la cámara"
            onCode={setSearch}
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
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Ver inactivos
        </label>
        {/* Lo que se usa de vez en cuando va en un menú, para que la barra quepa en una fila. */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" aria-label="Más opciones" title="Más opciones">
              <EllipsisIcon /> Más
            </Button>
          </PopoverTrigger>
          <PopoverContent className="grid w-60 gap-1 p-1.5">
            <PopoverClose asChild>
              <Button
                variant="ghost"
                className="justify-start"
                onClick={() => setManagingCategories(true)}
              >
                <TagsIcon /> Categorías
              </Button>
            </PopoverClose>
            <PopoverClose asChild>
              <Button
                variant="ghost"
                className="justify-start"
                disabled={rows.length === 0}
                onClick={() => setLabeling(true)}
              >
                <PrinterIcon /> Imprimir etiquetas
              </Button>
            </PopoverClose>
            {canManage ? (
              <>
                <PopoverClose asChild>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    onClick={() => setRepricing(true)}
                  >
                    <PercentIcon /> Cambiar precios
                  </Button>
                </PopoverClose>
                {features.priceLists ? (
                  <PopoverClose asChild>
                    <Button
                      variant="ghost"
                      className="justify-start"
                      onClick={() => setManagingLists(true)}
                    >
                      <ListIcon /> Listas de precios
                    </Button>
                  </PopoverClose>
                ) : null}
                {features.modifiers ? (
                  <PopoverClose asChild>
                    <Button
                      variant="ghost"
                      className="justify-start"
                      onClick={() => setManagingModifiers(true)}
                    >
                      <ListPlusIcon /> Opciones y extras
                    </Button>
                  </PopoverClose>
                ) : null}
                {can(me, "sale.discount") ? (
                  <PopoverClose asChild>
                    <Button
                      variant="ghost"
                      className="justify-start"
                      onClick={() => setManagingCodes(true)}
                    >
                      <TicketPercentIcon /> Códigos de descuento
                    </Button>
                  </PopoverClose>
                ) : null}
                <PopoverClose asChild>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    onClick={() => setImporting(true)}
                  >
                    <UploadIcon /> Importar desde Excel
                  </Button>
                </PopoverClose>
              </>
            ) : null}
          </PopoverContent>
        </Popover>
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
            {groups.map((g) => {
              const first = g[0]
              if (!first?.options) return g.map((p) => itemRow(p, false))
              const open = expanded.has(first.productId) || search.trim() !== ""
              return (
                <Fragment key={first.productId}>
                  {groupRow(g, open)}
                  {open ? g.map((p) => itemRow(p, true)) : null}
                </Fragment>
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
      {producing && boot && terminal ? (
        <NewProductionDialog
          boot={boot}
          terminalId={terminal.id}
          defaultLocationId={terminal.locationId}
          initialVariantId={producing.variantId}
          onClose={() => setProducing(null)}
        />
      ) : null}
      {repricing ? (
        <BulkPriceDialog
          filteredIds={
            search.trim() || categoryFilter || showInactive ? rows.map((r) => r.variantId) : null
          }
          canUseCost={can(me, "cost.view")}
          onClose={() => setRepricing(false)}
        />
      ) : null}
      {importing ? (
        <ImportDialog config={productImport} onClose={() => setImporting(false)} />
      ) : null}
      {managingCodes ? <DiscountCodesDialog onClose={() => setManagingCodes(false)} /> : null}
      {labeling ? (
        // Las de lo que se está viendo (con la búsqueda o la categoría elegida), una de cada.
        <LabelsDialog
          initial={rows
            .filter((r) => r.active && r.kind === "good")
            .map((r) => ({ variantId: r.variantId, qty: 1 }))}
          onClose={() => setLabeling(false)}
        />
      ) : null}
      {managingModifiers ? (
        <ModifierGroupsDialog onClose={() => setManagingModifiers(false)} />
      ) : null}
      {managingLists ? (
        <PriceListsDialog canManage={canManage} onClose={() => setManagingLists(false)} />
      ) : null}
      {managingCategories ? (
        <CategoriesDialog canManage={canManage} onClose={() => setManagingCategories(false)} />
      ) : null}
    </div>
  )
}

/** Bajo la existencia de un producto con lotes: lo vencido o el próximo vencimiento. */
function ExpiryNote({ expiry }: { expiry: NonNullable<CatalogItem["expiry"]> }) {
  const expired = Object.values(expiry.expiredByLocation).reduce((acc, q) => acc + q, 0)
  return (
    <Link
      to="/vencimientos"
      className={`block text-xs underline-offset-4 hover:underline ${expired ? "text-destructive" : "text-muted-foreground"}`}
    >
      {expired
        ? `${formatQty(expired)} vencido${expired === 1000 ? "" : "s"}`
        : expiry.nextExpiresOn
          ? `vence ${formatDate(expiry.nextExpiresOn)}`
          : "sin fecha"}
    </Link>
  )
}
