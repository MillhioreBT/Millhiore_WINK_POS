import type { CatalogItem, LabelSettings } from "@millhiore/contracts"
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
import { PrinterIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { toast } from "sonner"
import { BarcodeSvg } from "../../components/BarcodeSvg"
import { api, errorMessage } from "../../lib/api"
import {
  bootstrapQuery,
  labelSettingsQuery,
  productsQuery,
  queryClient,
  rateStatusQuery,
} from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { makeContext } from "../pos/compute"
import { codeOf, expandLabels, labelSize, paginate, priceText, SHEETS } from "./labels"

/** Lo que se pide imprimir: cada variante con cuántas etiquetas. */
export interface LabelRequest {
  variantId: string
  qty: number
}

/**
 * Imprimir etiquetas con código de barras: en el rollo de una impresora de etiquetas (con su
 * controlador en el equipo) o en hojas adhesivas en cualquier impresora. El papel y lo que lleva
 * cada etiqueta se recuerdan para la próxima vez.
 */
export function LabelsDialog({
  initial,
  onClose,
}: {
  initial: LabelRequest[]
  onClose: () => void
}) {
  const settings = useQuery(labelSettingsQuery)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Etiquetas</DialogTitle>
          <DialogDescription>
            Con su código de barras, para leerlas en la caja con el lector o la cámara.
          </DialogDescription>
        </DialogHeader>
        {settings.data ? (
          <LabelsForm initial={initial} saved={settings.data} onClose={onClose} />
        ) : (
          <p className="py-6 text-center text-muted-foreground text-sm">
            {settings.isError ? errorMessage(settings.error) : "Cargando…"}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function LabelsForm({
  initial,
  saved,
  onClose,
}: {
  initial: LabelRequest[]
  saved: LabelSettings
  onClose: () => void
}) {
  const me = useMe()
  const { data: boot } = useQuery(bootstrapQuery)
  const rate = useQuery(rateStatusQuery)
  const products = useQuery(productsQuery({ all: true }))
  const [settings, setSettings] = useState(saved)
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(initial.map((r) => [r.variantId, String(r.qty)])),
  )
  const [order, setOrder] = useState(() => initial.map((r) => r.variantId))
  const [skip, setSkip] = useState("1")
  const ctx = useMemo(
    () => (boot ? makeContext(boot, rate.data?.current?.value ?? null) : null),
    [boot, rate.data],
  )
  const byId = useMemo(
    () => new Map((products.data ?? []).map((p) => [p.variantId, p])),
    [products.data],
  )
  const entries = order.flatMap((id) => {
    const item = byId.get(id)
    const n = Number.parseInt(qty[id] ?? "", 10)
    return item ? [{ item, qty: Number.isFinite(n) && n > 0 ? Math.min(n, 999) : 0 }] : []
  })
  const sheet = settings.paper === "roll" ? null : SHEETS[settings.paper]
  const perPage = sheet ? sheet.cols * sheet.rows : 1
  const skipped = sheet ? Math.min(Math.max(Number.parseInt(skip, 10) || 1, 1), perPage) - 1 : 0
  const labels = expandLabels(entries, skipped)
  const count = labels.length - skipped
  const size = labelSize(settings)
  const set = <K extends keyof LabelSettings>(k: K, v: LabelSettings[K]) =>
    setSettings((s) => ({ ...s, [k]: v }))
  const mm = (k: "widthMm" | "heightMm", text: string) => {
    const n = Number.parseInt(text, 10)
    if (Number.isFinite(n)) {
      set(k, k === "widthMm" ? Math.min(Math.max(n, 20), 120) : Math.min(Math.max(n, 15), 100))
    }
  }

  const print = async () => {
    // Lo elegido queda para la próxima vez (si quien imprime puede cambiarlo).
    if (can(me, "catalog.manage") && JSON.stringify(settings) !== JSON.stringify(saved)) {
      try {
        await api("/api/settings/labels", { method: "PUT", body: settings })
        await queryClient.invalidateQueries({ queryKey: ["settings", "labels"] })
      } catch (e) {
        toast.error(errorMessage(e))
      }
    }
    printLabels(settings)
  }

  if (!ctx || !products.data) {
    return <p className="py-6 text-center text-muted-foreground text-sm">Cargando…</p>
  }
  const business = boot?.business.name ?? ""
  return (
    <>
      <div className="grid min-w-0 gap-4">
        <div className="grid gap-2">
          <ul className="max-h-60 divide-y overflow-y-auto rounded-lg border">
            {entries.length === 0 ? (
              <li className="px-3 py-6 text-center text-muted-foreground text-sm">
                No hay productos para etiquetar.
              </li>
            ) : null}
            {entries.map(({ item }) => {
              const code = codeOf(item)
              return (
                <li key={item.variantId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.name}</span>
                    {code ? (
                      <span className="block truncate text-muted-foreground text-xs">
                        {code.text}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-warning-foreground text-xs dark:text-warning">
                        <TriangleAlertIcon className="size-3" /> Sin código que se pueda imprimir
                      </span>
                    )}
                  </span>
                  <Input
                    inputMode="numeric"
                    className="tabular h-8 w-16 text-right"
                    value={qty[item.variantId] ?? ""}
                    onChange={(e) => setQty((q) => ({ ...q, [item.variantId]: e.target.value }))}
                    aria-label={`Etiquetas de ${item.name}`}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    onClick={() => setOrder((o) => o.filter((id) => id !== item.variantId))}
                    aria-label={`Quitar ${item.name}`}
                  >
                    <XIcon />
                  </Button>
                </li>
              )
            })}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setQty(Object.fromEntries(order.map((id) => [id, "1"])))}
            >
              Una de cada
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setQty(
                  Object.fromEntries(
                    order.map((id) => [
                      id,
                      String(Math.max(0, Math.ceil((byId.get(id)?.stockMilli ?? 0) / 1000))),
                    ]),
                  ),
                )
              }
            >
              Según la existencia
            </Button>
          </div>
        </div>

        <fieldset className="grid min-w-0 grid-cols-2 gap-3 rounded-lg border p-3 sm:grid-cols-4">
          <legend className="px-1 text-muted-foreground text-sm">Papel y contenido</legend>
          <Field label="Papel" htmlFor="l-paper" className="col-span-2">
            <NativeSelect
              id="l-paper"
              value={settings.paper}
              onChange={(e) => set("paper", e.target.value as LabelSettings["paper"])}
            >
              <option value="roll">Rollo de etiquetas</option>
              {Object.entries(SHEETS).map(([id, s]) => (
                <option key={id} value={id}>
                  Hoja {s.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {settings.paper === "roll" ? (
            <>
              <Field label="Ancho (mm)" htmlFor="l-width">
                <Input
                  id="l-width"
                  inputMode="numeric"
                  className="tabular"
                  defaultValue={settings.widthMm}
                  onBlur={(e) => mm("widthMm", e.target.value)}
                />
              </Field>
              <Field label="Alto (mm)" htmlFor="l-height">
                <Input
                  id="l-height"
                  inputMode="numeric"
                  className="tabular"
                  defaultValue={settings.heightMm}
                  onBlur={(e) => mm("heightMm", e.target.value)}
                />
              </Field>
            </>
          ) : (
            <Field
              label="Empezar en la etiqueta"
              htmlFor="l-skip"
              hint="Para usar una hoja empezada"
              className="col-span-2"
            >
              <Input
                id="l-skip"
                inputMode="numeric"
                className="tabular w-20"
                value={skip}
                onChange={(e) => setSkip(e.target.value)}
              />
            </Field>
          )}
          <Field label="Precio" htmlFor="l-price" className="col-span-2">
            <NativeSelect
              id="l-price"
              value={settings.price}
              onChange={(e) => set("price", e.target.value as LabelSettings["price"])}
            >
              <option value="reference">En {ctx.refCurrency}</option>
              <option value="legal">
                En {ctx.docCurrency === "VES" ? "Bs" : ctx.docCurrency} (tasa de hoy)
              </option>
              <option value="both">
                En {ctx.refCurrency} y en {ctx.docCurrency === "VES" ? "Bs" : ctx.docCurrency}
              </option>
              <option value="own">En la moneda del producto</option>
              <option value="none">Sin precio</option>
            </NativeSelect>
          </Field>
          <div className="col-span-2 grid content-end gap-2 pb-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={settings.showBusiness}
                onChange={(e) => set("showBusiness", e.target.checked)}
              />
              Nombre del negocio
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={settings.showSku}
                onChange={(e) => set("showSku", e.target.checked)}
              />
              SKU
            </label>
          </div>
          {settings.price === "legal" || settings.price === "both" ? (
            <p className="col-span-full text-muted-foreground text-xs">
              El precio en {ctx.docCurrency === "VES" ? "bolívares" : ctx.docCurrency} es el de la
              tasa de hoy: si la tasa cambia, la etiqueta queda vieja.
            </p>
          ) : null}
        </fieldset>

        <div className="grid gap-2">
          <Label>Así se ve</Label>
          <div className="flex min-w-0 flex-wrap items-start gap-3 overflow-hidden rounded-lg border bg-muted/40 p-3">
            {entries[0] ? (
              <div className="shadow-sm">
                <LabelView
                  item={entries[0].item}
                  settings={settings}
                  business={business}
                  price={priceText(ctx, entries[0].item, settings.price)}
                />
              </div>
            ) : null}
            <p className="text-muted-foreground text-xs">
              {size.width} × {size.height} mm
              {sheet
                ? ` · ${paginate(labels, perPage).length} ${paginate(labels, perPage).length === 1 ? "hoja" : "hojas"}`
                : ""}
              <br />
              {settings.paper === "roll"
                ? "En la impresora de etiquetas elige este mismo tamaño de papel y márgenes en cero."
                : "Imprime al 100 % (sin «ajustar a la página») y márgenes en cero."}
            </p>
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancelar
        </Button>
        <Button onClick={print} disabled={count === 0}>
          <PrinterIcon /> Imprimir {count === 1 ? "1 etiqueta" : `${count} etiquetas`}
        </Button>
      </DialogFooter>
      {createPortal(
        <PrintSheet
          labels={labels}
          settings={settings}
          business={business}
          price={(item) => priceText(ctx, item, settings.price)}
        />,
        document.body,
      )}
    </>
  )
}

/** Una etiqueta al tamaño real: negocio, producto, talla y color, precio y código de barras. */
export function LabelView({
  item,
  settings,
  business,
  price,
}: {
  item: CatalogItem
  settings: LabelSettings
  business: string
  price: string | null
}) {
  const { width, height } = labelSize(settings)
  const code = codeOf(item)
  // Las letras crecen con el alto de la etiqueta.
  const f = (k: number) => `${(height * k).toFixed(2)}mm`
  const values = item.optionValues?.join(" · ")
  const caption = [code?.text, settings.showSku && item.sku !== code?.text ? item.sku : null]
    .filter(Boolean)
    .join(" · ")
  return (
    <div
      className="flex flex-col overflow-hidden bg-white text-black leading-tight"
      style={{ width: `${width}mm`, height: `${height}mm`, padding: `${f(0.06)} ${f(0.08)}` }}
    >
      {settings.showBusiness && business ? (
        <div className="truncate" style={{ fontSize: f(0.085) }}>
          {business}
        </div>
      ) : null}
      <div className="flex items-baseline justify-between gap-[1mm]">
        <div className="min-w-0 truncate font-semibold" style={{ fontSize: f(0.11) }}>
          {item.productName}
        </div>
        {values ? (
          <div className="shrink-0 font-bold" style={{ fontSize: f(0.13) }}>
            {values}
          </div>
        ) : null}
      </div>
      {price ? (
        <div className="tabular truncate font-bold" style={{ fontSize: f(0.14) }}>
          {price}
        </div>
      ) : null}
      {code ? (
        <BarcodeSvg code={code} className="mt-[0.5mm] min-h-0 w-full flex-1" />
      ) : (
        <div className="flex-1" />
      )}
      <div className="tabular truncate text-center" style={{ fontSize: f(0.085) }}>
        {caption || item.sku}
      </div>
    </div>
  )
}

/**
 * Lo que sale en la impresión (y no en la pantalla): en rollo, una etiqueta por página; en
 * hoja, cada etiqueta en su lugar de la hoja.
 */
function PrintSheet({
  labels,
  settings,
  business,
  price,
}: {
  labels: (CatalogItem | null)[]
  settings: LabelSettings
  business: string
  price: (item: CatalogItem) => string | null
}) {
  const view = (item: CatalogItem | null) =>
    item ? (
      <LabelView item={item} settings={settings} business={business} price={price(item)} />
    ) : null
  if (settings.paper === "roll") {
    return (
      <div id="labels-print" className="hidden">
        {labels.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: la misma etiqueta se repite tantas veces como se pidió
          <div key={i} className="label-page">
            {view(item)}
          </div>
        ))}
      </div>
    )
  }
  const sheet = SHEETS[settings.paper]
  return (
    <div id="labels-print" className="hidden">
      {paginate(labels, sheet.cols * sheet.rows).map((page, p) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: las hojas no tienen otro nombre que su número
          key={p}
          className="label-page relative"
          style={{ width: `${sheet.pageWidth}mm`, height: `${sheet.pageHeight}mm` }}
        >
          {page.map((item, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: cada lugar de la hoja es fijo
              key={i}
              className="absolute"
              style={{
                left: `${sheet.left + (i % sheet.cols) * sheet.pitchX}mm`,
                top: `${sheet.top + Math.floor(i / sheet.cols) * sheet.pitchY}mm`,
              }}
            >
              {view(item)}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Imprime solo las etiquetas, en el papel elegido y en claro. Mientras dura la impresión se anula
 * la hoja de estilos de los recibos (80 mm) y se esconde todo lo demás, para que no salgan
 * páginas en blanco.
 */
function printLabels(settings: LabelSettings) {
  const { width, height } = labelSize(settings)
  const page =
    settings.paper === "roll"
      ? `${width}mm ${height}mm`
      : `${SHEETS[settings.paper].pageWidth}mm ${SHEETS[settings.paper].pageHeight}mm`
  const root = document.documentElement
  const dark = root.classList.contains("dark")
  const style = document.createElement("style")
  style.textContent = `@media print {
    @page { size: ${page}; margin: 0 }
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important }
    body > *:not(#labels-print) { display: none !important }
    #labels-print, #labels-print * { visibility: visible !important }
    #labels-print { display: block !important }
    #labels-print .label-page { overflow: hidden; break-inside: avoid }
    #labels-print .label-page:not(:last-child) { break-after: page }
  }`
  document.head.append(style)
  if (dark) root.classList.remove("dark")
  window.addEventListener(
    "afterprint",
    () => {
      style.remove()
      if (dark) root.classList.add("dark")
    },
    { once: true },
  )
  window.print()
}
