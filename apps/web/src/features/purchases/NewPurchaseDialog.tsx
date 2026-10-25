import type { Bootstrap, CatalogItem, Contact } from "@millhiore/contracts"
import { computeTaxes, lineTotal, uuidv7 } from "@millhiore/domain"
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
import { Trash2Icon } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { ScanButton } from "../../components/CameraScanner"
import { groupByProduct } from "../../components/VariantGrid"
import { api, errorMessage } from "../../lib/api"
import { endOfDay } from "../../lib/days"
import { formatMoney, formatPercent, parseAmount, toInputAmount } from "../../lib/format"
import { useLocations } from "../../lib/locations"
import { productsQuery, queryClient, rateStatusQuery } from "../../lib/queries"
import { findByCode } from "../../lib/scanner"
import { useFeatures } from "../../lib/session"
import { ContactPicker } from "../contacts/ContactPicker"
import { convertMinor, makeContext, methodUsable, paymentRate } from "../pos/compute"
import { VariantQtyDialog } from "./VariantQtyDialog"

interface Line {
  item: CatalogItem
  qty: string
  cost: string
  /** Producto con lotes: su vencimiento (obligatorio) y el código del lote (opcional). */
  expiresOn: string
  lotCode: string
}

/**
 * Registrar una compra: entra la mercancía, sale el dinero y queda el último costo de cada
 * producto. Por defecto los costos van sin IVA, como en la factura del proveedor.
 */
export function NewPurchaseDialog({
  boot,
  terminalId,
  onClose,
}: {
  boot: Bootstrap
  terminalId: string
  onClose: () => void
}) {
  const rate = useQuery(rateStatusQuery)
  const products = useQuery(productsQuery())
  const [supplier, setSupplier] = useState<Contact | null>(null)
  const [invoice, setInvoice] = useState("")
  const [currency, setCurrency] = useState(boot.business.referenceCurrency)
  const [includesTax, setIncludesTax] = useState(false)
  const [lines, setLines] = useState<Line[]>([])
  const [search, setSearch] = useState("")
  // Producto con tallas y colores: sus cantidades se escriben en cuadrícula.
  const [grid, setGrid] = useState<CatalogItem[] | null>(null)
  const [methodId, setMethodId] = useState("")
  const [reference, setReference] = useState("")
  // Lo que se le debe al proveedor en vez de pagarlo ya, y hasta cuándo hay para pagar.
  const [onCredit, setOnCredit] = useState(false)
  // Sin «Por pagar» no se deja nada a deber.
  const { payables: payablesOn, lots: lotsOn } = useFeatures()
  const needsLot = (l: Line) => lotsOn && l.item.tracksLots
  const [dueDay, setDueDay] = useState("")
  const [busy, setBusy] = useState(false)
  const [purchaseId] = useState(uuidv7)
  // Con varias ubicaciones se elige dónde entra la mercancía (la de la caja, si no).
  const locations = useLocations()
  const [locationId, setLocationId] = useState(
    () => boot.terminals.find((t) => t.id === terminalId)?.locationId ?? "",
  )

  // Contexto de conversión con la tasa vigente (misma lógica que la caja).
  const ctx = useMemo(() => makeContext(boot, rate.data?.current?.value ?? null), [boot, rate.data])
  const methods = boot.paymentMethods.filter((m) => methodUsable(ctx, m))
  const method = methods.find((m) => m.id === methodId) ?? methods[0]
  const taxes = new Map(boot.taxes.map((t) => [t.id, t]))
  const taxOf = (taxId: string | null) => taxes.get(taxId ?? boot.fiscal.defaultTaxId)

  const parsed = lines.map((l) => ({
    qtyMilli: parseAmount(l.qty, 3),
    cost: parseAmount(l.cost),
  }))
  const valid =
    lines.length > 0 && parsed.every((p) => p.qtyMilli && p.qtyMilli > 0 && p.cost !== null)
  // Lo perecedero entra con su fecha de vencimiento.
  const missingExpiry = lines.filter((l) => needsLot(l) && !l.expiresOn)
  // Cálculo barato (unas pocas líneas): se rehace en cada render, sin memorizar.
  const totals = (() => {
    if (!valid) return null
    const groups = computeTaxes(
      lines.map((l, i) => {
        const t = taxOf(l.item.taxId)
        return {
          lineTotalMinor: lineTotal(parsed[i]?.qtyMilli ?? 0, parsed[i]?.cost ?? 0),
          tax: t ? { taxId: t.id, kind: t.kind, rateBp: t.rateBp } : null,
        }
      }),
      includesTax,
      (n) => n,
    )
    return {
      groups,
      total: groups.reduce((acc, g) => acc + g.baseMinor + g.taxMinor, 0),
    }
  })()
  const payAmount =
    totals && method ? convertMinor(ctx, totals.total, currency, method.currency) : null

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (q.length < 2) return []
    const all = (products.data ?? []).filter((p) => p.tracksStock)
    // De un producto con tallas y colores sale una sola opción, con todas sus combinaciones.
    return groupByProduct(
      all.filter(
        (p) => p.name.toLowerCase().includes(q) || p.barcode === q || p.sku.toLowerCase() === q,
      ),
    )
      .map((g) => (g[0]?.options ? all.filter((p) => p.productId === g[0]?.productId) : g))
      .slice(0, 8)
  }, [products.data, search])

  const lastCost = (item: CatalogItem) =>
    item.costMinor !== null && item.costCurrency === currency ? toInputAmount(item.costMinor) : ""
  const addLine = (item: CatalogItem) => {
    setLines((ls) =>
      ls.some((l) => l.item.variantId === item.variantId)
        ? ls
        : [...ls, { item, qty: "1", cost: lastCost(item), expiresOn: "", lotCode: "" }],
    )
    setSearch("")
  }
  // Las de la cuadrícula: si ya estaban, se cambia su cantidad y su costo.
  const addLines = (added: { item: CatalogItem; qty: string; cost: string }[]) => {
    setLines((ls) => {
      const next = ls.map((l) => {
        const same = added.find((a) => a.item.variantId === l.item.variantId)
        return same ? { ...l, qty: same.qty, cost: same.cost } : l
      })
      for (const a of added) {
        if (!ls.some((l) => l.item.variantId === a.item.variantId)) {
          next.push({ item: a.item, qty: a.qty, cost: a.cost, expiresOn: "", lotCode: "" })
        }
      }
      return next
    })
    setGrid(null)
    setSearch("")
  }

  const submit = async () => {
    if (!totals) return
    if (missingExpiry.length) {
      toast.error(`Indica cuándo vence ${missingExpiry[0]?.item.name}`)
      return
    }
    if (onCredit) {
      if (!supplier) {
        toast.error("Elige el proveedor al que le debes")
        return
      }
    } else if (!method || payAmount === null) {
      return
    }
    if (!onCredit && method?.requiresReference && !reference.trim()) {
      toast.error(` necesita la referencia del pago`)
      return
    }
    setBusy(true)
    try {
      await api("/api/documents", {
        body: {
          id: purchaseId,
          type: "PURCHASE",
          terminalId,
          currency,
          rate: ctx.rate,
          pricesIncludeTax: includesTax,
          contactId: supplier?.id ?? null,
          externalRef: invoice.trim() || null,
          ...(locations && locationId ? { locationId } : {}),
          lines: lines.map((l, i) => ({
            variantId: l.item.variantId,
            qtyMilli: parsed[i]?.qtyMilli ?? 0,
            unitPriceMinor: parsed[i]?.cost ?? 0,
            ...(needsLot(l)
              ? { lot: { code: l.lotCode.trim() || null, expiresOn: l.expiresOn } }
              : {}),
          })),
          payments:
            onCredit || !method || payAmount === null
              ? []
              : [
                  {
                    id: uuidv7(),
                    paymentMethodId: method.id,
                    currency: method.currency,
                    amountMinor: payAmount,
                    reference: reference.trim() || null,
                    rate: paymentRate({ ...ctx, docCurrency: currency }, method.currency),
                  },
                ],
          ...(onCredit
            ? {
                creditMinor: totals.total,
                creditCurrency: currency,
                dueAt: dueDay ? endOfDay(dueDay) : null,
              }
            : {}),
        },
      })
      await Promise.all(
        ["products", "documents", "shifts", "payables", "lots"].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      )
      toast.success(
        onCredit
          ? "Compra registrada a deber: ya está en Por pagar"
          : "Compra registrada: existencias y costos actualizados",
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
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Nueva compra</DialogTitle>
          <DialogDescription>
            Registra la factura del proveedor: suma existencias, descuenta el pago y guarda el
            último costo de cada producto.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px_120px]">
          <Field label="Proveedor" htmlFor="supplier">
            <ContactPicker
              kind="supplier"
              value={supplier}
              onChange={setSupplier}
              placeholder="Buscar proveedor por nombre o RIF"
            />
          </Field>
          <Field label="N.º de factura" htmlFor="invoice">
            <Input id="invoice" value={invoice} onChange={(e) => setInvoice(e.target.value)} />
          </Field>
          <Field label="Moneda" htmlFor="p-currency">
            <NativeSelect
              id="p-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option value={boot.business.referenceCurrency}>
                {boot.business.referenceCurrency}
              </option>
              <option value={boot.business.legalCurrency}>
                {boot.business.legalCurrency === "VES" ? "Bs" : boot.business.legalCurrency}
              </option>
            </NativeSelect>
          </Field>
        </div>

        <div className="relative">
          <div className="flex gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Agregar producto: nombre o código"
              aria-label="Buscar producto para la compra"
            />
            <ScanButton
              continuous
              onCode={(code) => {
                const item = findByCode(
                  (products.data ?? []).filter((p) => p.tracksStock),
                  code,
                )
                if (!item) {
                  toast.error(`No hay ningún producto con el código ${code}`)
                  return
                }
                addLine(item)
                toast.success(`${item.name} en el compra`)
              }}
            />
          </div>
          {filtered.length ? (
            <ul className="absolute top-11 z-10 w-full divide-y rounded-md border bg-popover shadow-lg">
              {filtered.map((g) => {
                const p = g[0]
                if (!p) return null
                return (
                  <li key={p.options ? p.productId : p.variantId}>
                    <button
                      type="button"
                      className="w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-accent"
                      onClick={() => (p.options ? setGrid(g) : addLine(p))}
                    >
                      {p.options ? p.productName : p.name}{" "}
                      <span className="text-muted-foreground">
                        {p.options
                          ? `${g.length} combinaciones (${p.options.map((o) => o.name.toLocaleLowerCase("es")).join(", ")})`
                          : p.sku}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>

        {/* Tabla en pantallas anchas; en el celular cada línea se apila en dos columnas. */}
        <div className="rounded-lg border text-sm">
          <div className="hidden grid-cols-[minmax(0,1fr)_6rem_8rem_4.5rem_7rem] gap-3 rounded-t-lg bg-muted/50 px-3 py-2 font-medium text-muted-foreground sm:grid">
            <span>Producto</span>
            <span className="text-right">Cantidad</span>
            <span className="text-right">
              Costo unit. {includesTax ? "(con IVA)" : "(sin IVA)"}
            </span>
            <span>IVA</span>
            <span className="text-right">Subtotal</span>
          </div>
          <ul className="divide-y">
            {lines.length === 0 ? (
              <li className="px-3 py-6 text-center text-muted-foreground">
                Busca y agrega los productos de la factura.
              </li>
            ) : null}
            {lines.map((l, i) => {
              const t = taxOf(l.item.taxId)
              const p = parsed[i]
              return (
                <li
                  key={l.item.variantId}
                  className="grid grid-cols-2 items-center gap-x-3 gap-y-1.5 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_6rem_8rem_4.5rem_7rem]"
                >
                  <span className="col-span-2 flex min-w-0 items-center gap-1 sm:col-span-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="-ml-2 text-muted-foreground"
                      onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                      aria-label={`Quitar ${l.item.name}`}
                    >
                      <Trash2Icon />
                    </Button>
                    <span className="min-w-0 font-medium sm:font-normal">{l.item.name}</span>
                  </span>
                  <div className="grid gap-0.5 text-muted-foreground text-xs">
                    <span className="sm:hidden">Cantidad</span>
                    <Input
                      value={l.qty}
                      inputMode="decimal"
                      className="tabular h-9 text-right text-foreground text-sm sm:h-8"
                      aria-label={`Cantidad de ${l.item.name}`}
                      onChange={(e) =>
                        setLines((ls) =>
                          ls.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)),
                        )
                      }
                    />
                  </div>
                  <div className="grid gap-0.5 text-muted-foreground text-xs">
                    <span className="sm:hidden">
                      Costo unit. {includesTax ? "(con IVA)" : "(sin IVA)"}
                    </span>
                    <Input
                      value={l.cost}
                      inputMode="decimal"
                      placeholder="0,00"
                      className="tabular h-9 text-right text-foreground text-sm sm:h-8"
                      aria-label={`Costo de ${l.item.name}`}
                      onChange={(e) =>
                        setLines((ls) =>
                          ls.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x)),
                        )
                      }
                    />
                  </div>
                  <span className="text-muted-foreground">
                    <span className="sm:hidden">IVA </span>
                    {t ? (t.kind === "taxed" ? formatPercent(t.rateBp) : "Exento") : "—"}
                  </span>
                  <span className="tabular text-right font-medium sm:font-normal">
                    {p?.qtyMilli && p.cost !== null
                      ? formatMoney(lineTotal(p.qtyMilli, p.cost), currency)
                      : "—"}
                  </span>
                  {needsLot(l) ? (
                    <div className="col-span-2 grid grid-cols-2 gap-3 sm:col-span-5 sm:grid-cols-[10rem_10rem]">
                      <div className="grid gap-0.5 text-muted-foreground text-xs">
                        <span>Vence</span>
                        <Input
                          type="date"
                          value={l.expiresOn}
                          className="h-9 text-foreground text-sm sm:h-8"
                          aria-label={`Vencimiento de ${l.item.name}`}
                          aria-invalid={!l.expiresOn}
                          onChange={(e) =>
                            setLines((ls) =>
                              ls.map((x, j) => (j === i ? { ...x, expiresOn: e.target.value } : x)),
                            )
                          }
                        />
                      </div>
                      <div className="grid gap-0.5 text-muted-foreground text-xs">
                        <span>Lote (opcional)</span>
                        <Input
                          value={l.lotCode}
                          maxLength={40}
                          className="h-9 text-foreground text-sm sm:h-8"
                          aria-label={`Lote de ${l.item.name}`}
                          onChange={(e) =>
                            setLines((ls) =>
                              ls.map((x, j) => (j === i ? { ...x, lotCode: e.target.value } : x)),
                            )
                          }
                        />
                      </div>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="grid content-start gap-3">
            {locations ? (
              <Field label="Recibir en" htmlFor="p-location">
                <NativeSelect
                  id="p-location"
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
            <div className="flex items-center gap-3">
              <input
                id="p-incl"
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={includesTax}
                onChange={(e) => setIncludesTax(e.target.checked)}
              />
              <Label htmlFor="p-incl">Los costos ya incluyen el IVA</Label>
            </div>
            {payablesOn ? (
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={onCredit ? "outline" : "default"}
                  onClick={() => setOnCredit(false)}
                >
                  Pagada ahora
                </Button>
                <Button
                  type="button"
                  variant={onCredit ? "default" : "outline"}
                  onClick={() => setOnCredit(true)}
                >
                  A deber
                </Button>
              </div>
            ) : null}
            {onCredit ? (
              <Field
                label="Pagar antes del (opcional)"
                htmlFor="p-due"
                hint={
                  supplier
                    ? "Si lo dejas vacío se usan los días de crédito del proveedor."
                    : "Elige el proveedor al que le debes."
                }
              >
                <Input
                  id="p-due"
                  type="date"
                  value={dueDay}
                  onChange={(e) => setDueDay(e.target.value)}
                />
              </Field>
            ) : (
              <Field label="Pagado con" htmlFor="p-method">
                <NativeSelect
                  id="p-method"
                  value={method?.id ?? ""}
                  onChange={(e) => setMethodId(e.target.value)}
                >
                  {methods.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
            {!onCredit && method?.requiresReference ? (
              <Field label="Referencia del pago" htmlFor="p-reference">
                <Input
                  id="p-reference"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="Número de confirmación"
                />
              </Field>
            ) : null}
          </div>
          <div className="grid content-start gap-1 rounded-lg bg-muted/60 p-3 text-sm">
            {totals?.groups
              .filter((g) => g.taxMinor !== 0)
              .map((g) => (
                <div
                  key={`${g.taxId}-${g.rateBp}`}
                  className="flex justify-between text-muted-foreground"
                >
                  <span>
                    Base {formatPercent(g.rateBp)} {formatMoney(g.baseMinor, currency)} · IVA
                  </span>
                  <span className="tabular">{formatMoney(g.taxMinor, currency)}</span>
                </div>
              ))}
            <div className="flex items-baseline justify-between">
              <span className="font-medium">Total factura</span>
              <span className="tabular font-bold text-xl">
                {totals ? formatMoney(totals.total, currency) : "—"}
              </span>
            </div>
            {!onCredit && method && payAmount !== null && method.currency !== currency ? (
              <div className="tabular text-right text-muted-foreground">
                Se paga {formatMoney(payAmount, method.currency)}
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            onClick={submit}
            disabled={
              busy ||
              !totals ||
              missingExpiry.length > 0 ||
              (onCredit ? !supplier : payAmount === null)
            }
          >
            {busy ? "Registrando…" : onCredit ? "Registrar compra a deber" : "Registrar compra"}
          </Button>
        </DialogFooter>
        {grid ? (
          <VariantQtyDialog
            items={grid}
            initialCost={grid[0] ? lastCost(grid[0]) : ""}
            costLabel={`Costo unit. ${includesTax ? "(con IVA)" : "(sin IVA)"}`}
            onAdd={addLines}
            onClose={() => setGrid(null)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
