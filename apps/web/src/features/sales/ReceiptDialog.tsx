import type { Bootstrap, DocumentDetail } from "@millhiore/contracts"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { PrinterIcon } from "lucide-react"
import { useEffect, useRef } from "react"
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatPercent,
  formatQty,
  formatQtyUnit,
  formatRate,
  perUnit,
} from "../../lib/format"
import { openDrawer, usePrintDocument } from "../../lib/printing"
import { bootstrapQuery, documentQuery } from "../../lib/queries"

const TITLE: Record<string, string> = {
  SALE: "NOTA DE VENTA · NO FISCAL",
  PAYMENT_IN: "RECIBO DE ABONO · NO FISCAL",
  RETURN: "DEVOLUCIÓN · NO FISCAL",
  PURCHASE: "COMPRA",
  EXPENSE: "COMPROBANTE DE GASTO · NO FISCAL",
  PAYMENT_OUT: "COMPROBANTE DE PAGO · NO FISCAL",
  TRANSFER: "TRANSFERENCIA ENTRE CUENTAS",
  CASH_IN: "INGRESO DE CAJA",
  CASH_OUT: "RETIRO DE CAJA",
  ADJUSTMENT: "AJUSTE DE INVENTARIO",
  DEBT_IN: "CUENTA POR COBRAR · NO FISCAL",
  DEBT_OUT: "CUENTA POR PAGAR",
  STOCK_TRANSFER: "TRASLADO DE INVENTARIO",
  PURCHASE_RETURN: "DEVOLUCIÓN A PROVEEDOR",
  PRODUCTION: "PRODUCCIÓN",
}

/** Origen y destino de una transferencia; en su anulación el dinero va al revés. */
const transferLeg = (index: number, reversed: boolean) =>
  index === 0 ? (reversed ? "Regresa a" : "Sale de") : reversed ? "Sale de" : "Entra en"

const KIND_LABEL: Record<string, string> = {
  exempt: "Exento",
  exonerated: "Exonerado",
  not_subject: "No sujeto",
}

export type BusinessInfo = Bootstrap["business"]

/**
 * Encabezado de recibos y reportes: nombre, RIF, dirección y teléfono del negocio. Lo de una
 * sucursal lleva su nombre y, si los tiene, su dirección y su teléfono.
 */
export function BusinessHeader({
  business,
  branch,
}: {
  business: BusinessInfo | undefined
  branch?: DocumentDetail["branch"] | undefined
}) {
  if (!business) return null
  const address = branch?.address ?? business.address
  const phone = branch?.phone ?? business.phone
  return (
    <>
      <p className="font-bold text-sm">{business.name}</p>
      {branch ? <p>Sucursal {branch.name}</p> : null}
      {business.taxId ? <p>RIF {business.taxId}</p> : null}
      {address ? <p>{address}</p> : null}
      {phone ? <p>Tel. {phone}</p> : null}
    </>
  )
}

/** Los lotes que movió una línea: código, vencimiento y cantidad. */
function LotLines({ lots }: { lots: DocumentDetail["lines"][number]["lots"] }) {
  return lots.map((x) => (
    <p key={x.lotId} className="flex justify-between gap-2 pl-2">
      <span>
        {x.code ? `Lote ${x.code}` : "Lote"}
        {x.expiresOn ? ` · vence ${formatDate(x.expiresOn)}` : " · sin fecha"}
      </span>
      <span>{formatQty(x.qtyMilli)}</span>
    </p>
  ))
}

/** Comprobante de un traslado: de dónde a dónde y cuánto de cada producto, sin precios. */
function TransferReceipt({
  doc,
  business,
}: {
  doc: DocumentDetail
  business: BusinessInfo | undefined
}) {
  // El reverso devuelve la mercancía: va del destino al origen.
  const reversed = doc.reversesDocumentId !== null
  const units = doc.lines.reduce((acc, l) => acc + Math.abs(l.qtyMilli), 0)
  return (
    <div id="receipt" className="mx-auto w-full max-w-[320px] font-mono text-[12px] leading-snug">
      <div className="text-center">
        <BusinessHeader business={business} branch={doc.branch} />
        <p className="mt-1">{TITLE[doc.type]}</p>
        <p>
          {doc.number} · {formatDateTime(doc.postedAt)}
        </p>
        {doc.createdBy ? <p>Atendió: {doc.createdBy}</p> : null}
        <p>De: {reversed ? doc.toLocationName : doc.locationName}</p>
        <p>A: {reversed ? doc.locationName : doc.toLocationName}</p>
        {doc.note ? <p>{doc.note}</p> : null}
        {doc.reversesDocumentId ? <p className="font-bold">ANULACIÓN</p> : null}
        {doc.reversedBy ? <p className="font-bold">*** ANULADO ***</p> : null}
      </div>
      <hr className="my-2 border-dashed border-current" />
      {doc.lines.map((l) => (
        <div key={l.lineNo}>
          <p className="flex justify-between gap-2">
            <span>{l.name}</span>
            <span>{formatQtyUnit(Math.abs(l.qtyMilli), l.unit)}</span>
          </p>
          <LotLines lots={l.lots} />
        </div>
      ))}
      <hr className="my-2 border-dashed border-current" />
      <p className="flex justify-between font-bold">
        <span>UNIDADES</span>
        <span>{formatQty(units)}</span>
      </p>
    </div>
  )
}

/** Comprobante de una producción: lo producido y lo que se gastó de cada ingrediente, sin precios. */
function ProductionReceipt({
  doc,
  business,
}: {
  doc: DocumentDetail
  business: BusinessInfo | undefined
}) {
  return (
    <div id="receipt" className="mx-auto w-full max-w-[320px] font-mono text-[12px] leading-snug">
      <div className="text-center">
        <BusinessHeader business={business} branch={doc.branch} />
        <p className="mt-1">{TITLE[doc.type]}</p>
        <p>
          {doc.number} · {formatDateTime(doc.postedAt)}
        </p>
        {doc.createdBy ? <p>Atendió: {doc.createdBy}</p> : null}
        <p>En: {doc.locationName}</p>
        {doc.note ? <p>{doc.note}</p> : null}
        {doc.reversesDocumentId ? <p className="font-bold">ANULACIÓN</p> : null}
        {doc.reversedBy ? <p className="font-bold">*** ANULADA ***</p> : null}
      </div>
      <hr className="my-2 border-dashed border-current" />
      {doc.lines.map((l) => (
        <div key={l.lineNo}>
          <p className="flex justify-between gap-2 font-bold">
            <span>{l.name}</span>
            <span>{formatQtyUnit(Math.abs(l.qtyMilli), l.unit)}</span>
          </p>
          <LotLines lots={l.lots} />
          {l.ingredients.length ? (
            <p className="mt-1">{doc.reversesDocumentId ? "Volvió:" : "Se gastó:"}</p>
          ) : null}
          {l.ingredients.map((i) => (
            <p key={i.variantId} className="flex justify-between gap-2 pl-2">
              <span>{i.name}</span>
              <span>{formatQty(i.qtyMilli)}</span>
            </p>
          ))}
        </div>
      ))}
    </div>
  )
}

/** Recibo de una venta, listo para imprimir en papel térmico de 80 mm. No es una factura fiscal. */
export function Receipt({
  doc,
  business,
}: {
  doc: DocumentDetail
  business: BusinessInfo | undefined
}) {
  if (doc.type === "STOCK_TRANSFER") return <TransferReceipt doc={doc} business={business} />
  if (doc.type === "PRODUCTION") return <ProductionReceipt doc={doc} business={business} />
  const cur = doc.currency
  // Las líneas exentas o exoneradas se marcan (E), como en la factura venezolana.
  const taxCode = (taxId: string | null, rateBp: number) => (taxId && rateBp === 0 ? " (E)" : "")
  const rate = doc.rate
  const refAmount = (minor: number) => {
    if (!rate || rate.quote !== cur) return null
    return Math.round(minor / Number(rate.value))
  }
  const total = doc.totalMinor + doc.surchargeMinor
  const ref = rate?.base
  const refTotal = refAmount(total)
  return (
    <div id="receipt" className="mx-auto w-full max-w-[320px] font-mono text-[12px] leading-snug">
      <div className="text-center">
        <BusinessHeader business={business} branch={doc.branch} />
        <p className="mt-1">{TITLE[doc.type] ?? doc.type}</p>
        <p>
          {doc.number} · {formatDateTime(doc.postedAt)}
        </p>
        {doc.createdBy ? <p>Atendió: {doc.createdBy}</p> : null}
        {doc.contactName ? (
          <p>
            {doc.type === "PURCHASE" ||
            doc.type === "PURCHASE_RETURN" ||
            doc.type === "EXPENSE" ||
            doc.type === "PAYMENT_OUT"
              ? "Proveedor"
              : "Cliente"}
            : {doc.contactName}
            {doc.contactTaxId ? ` · ${doc.contactTaxId}` : ""}
          </p>
        ) : null}
        {doc.invoiceRequested && doc.contactAddress ? <p>{doc.contactAddress}</p> : null}
        {doc.invoice ? (
          <p>
            Factura N.º {doc.invoice.invoiceNumber} · Control {doc.invoice.controlNumber}
          </p>
        ) : null}
        {doc.expenseCategoryName ? <p>Categoría: {doc.expenseCategoryName}</p> : null}
        {doc.stockReasonName ? <p>Motivo: {doc.stockReasonName}</p> : null}
        {doc.discountCode ? <p>Código de descuento: {doc.discountCode}</p> : null}
        {doc.externalRef ? <p>Factura: {doc.externalRef}</p> : null}
        {doc.note ? <p>{doc.note}</p> : null}
        {doc.returnsNumber ? (
          <p>
            Devolución de la {doc.type === "PURCHASE_RETURN" ? "compra" : "venta"}{" "}
            {doc.returnsNumber}
          </p>
        ) : null}
        {doc.reversesDocumentId ? <p className="font-bold">ANULACIÓN</p> : null}
        {doc.reversedBy ? <p className="font-bold">*** ANULADA ***</p> : null}
      </div>
      <hr className="my-2 border-dashed border-current" />
      {doc.allocations.length ? (
        <>
          <p>
            {doc.type === "RETURN"
              ? "Descontado de lo que debe:"
              : doc.type === "PURCHASE_RETURN"
                ? "Descontado de lo que se le debe:"
                : doc.type === "PAYMENT_OUT"
                  ? "Pago de:"
                  : "Abono a:"}
          </p>
          {doc.allocations.map((a) => (
            <p key={a.saleDocumentId} className="flex justify-between">
              <span>{a.saleNumber}</span>
              <span>{formatMoney(a.amountMinor, cur)}</span>
            </p>
          ))}
          <hr className="my-2 border-dashed border-current" />
        </>
      ) : null}
      {doc.lines.map((l) => (
        <div key={l.lineNo} className="mb-1">
          <p>
            {l.name}
            {taxCode(l.taxId, l.taxRateBp)}
          </p>
          {l.modifiers.map((m) => (
            <p key={m.id}>&nbsp;&nbsp;+ {m.name}</p>
          ))}
          <p className="flex justify-between">
            <span>
              {formatQtyUnit(l.qtyMilli, l.unit)} × {formatMoney(l.unitPriceMinor, cur)}
              {perUnit(l.unit)}
            </span>
            <span>{formatMoney(l.lineTotalMinor + l.discountMinor, cur)}</span>
          </p>
          {l.discountMinor !== 0 ? (
            <p className="flex justify-between">
              <span>&nbsp;&nbsp;Descuento</span>
              <span>-{formatMoney(l.discountMinor, cur)}</span>
            </p>
          ) : null}
          {doc.type === "PURCHASE" || doc.type === "ADJUSTMENT" ? <LotLines lots={l.lots} /> : null}
        </div>
      ))}
      {/* Recargos de la venta (delivery, servicio), después de los productos. */}
      {doc.charges.map((c) => (
        <p key={c.chargeId} className="flex justify-between">
          <span>
            {c.name}
            {c.kind === "percent" ? ` ${formatPercent(c.rateBp)}` : ""}
            {taxCode(c.taxId, c.taxRateBp)}
          </span>
          <span>{formatMoney(c.amountMinor, cur)}</span>
        </p>
      ))}
      <hr className="my-2 border-dashed border-current" />
      {/* Sin impuesto asignado (negocio que no cobra IVA) no hay desglose que mostrar; si cobra
      IVA, lo que no lo lleva (un recargo de servicio) sale como no sujeto. */}
      {doc.taxes
        .filter(
          (t) => doc.taxes.some((x) => x.taxId !== null) && (t.taxId !== null || t.baseMinor !== 0),
        )
        .map((t) =>
          t.rateBp > 0 ? (
            <div key={`${t.taxId}-${t.rateBp}`}>
              <p className="flex justify-between">
                <span>Base imponible {formatPercent(t.rateBp)}</span>
                <span>{formatMoney(t.baseMinor, cur)}</span>
              </p>
              <p className="flex justify-between">
                <span>IVA {formatPercent(t.rateBp)}</span>
                <span>{formatMoney(t.taxMinor, cur)}</span>
              </p>
            </div>
          ) : (
            <p key={`${t.taxId}-${t.kind}`} className="flex justify-between">
              <span>
                {KIND_LABEL[t.kind] ?? "Exento"}
                {t.kind === "not_subject" ? "" : " (E)"}
              </span>
              <span>{formatMoney(t.baseMinor, cur)}</span>
            </p>
          ),
        )}
      <p className="flex justify-between font-bold">
        <span>
          {doc.type === "PAYMENT_IN"
            ? "ABONO"
            : doc.type === "PAYMENT_OUT"
              ? "PAGO"
              : doc.type === "TRANSFER"
                ? "TRANSFERIDO"
                : "TOTAL"}
        </span>
        <span>{formatMoney(doc.totalMinor, cur)}</span>
      </p>
      {doc.surcharges.map((s) => (
        <p key={s.surchargeId} className="flex justify-between">
          <span>
            IGTF {formatPercent(s.rateBp)} s/ {formatMoney(s.baseMinor, cur)}
          </span>
          <span>{formatMoney(s.amountMinor, cur)}</span>
        </p>
      ))}
      {doc.surchargeMinor ? (
        <p className="flex justify-between font-bold">
          <span>TOTAL A PAGAR</span>
          <span>{formatMoney(total, cur)}</span>
        </p>
      ) : null}
      {doc.tipMinor ? (
        <>
          <p className="flex justify-between">
            <span>Propina{doc.tipUserName ? ` (${doc.tipUserName})` : ""}</span>
            <span>{formatMoney(doc.tipMinor, cur)}</span>
          </p>
          <p className="flex justify-between font-bold">
            <span>CON PROPINA</span>
            <span>{formatMoney(total + doc.tipMinor, cur)}</span>
          </p>
        </>
      ) : null}
      {rate && ref && refTotal !== null ? (
        <p className="mt-1 text-center">
          Tasa BCV {formatRate(rate.value)} · Ref. {formatMoney(refTotal, ref)}
        </p>
      ) : null}
      <hr className="my-2 border-dashed border-current" />
      {doc.payments.map((p, i) => (
        <p key={p.id} className="flex justify-between">
          <span>
            {doc.type === "TRANSFER"
              ? `${transferLeg(i, doc.reversesDocumentId !== null)} ${p.methodName}`
              : doc.type === "RETURN"
                ? "Reembolso"
                : doc.type === "PURCHASE_RETURN"
                  ? "Reembolso del proveedor"
                  : doc.type === "EXPENSE" || doc.type === "PAYMENT_OUT"
                    ? "Pagado"
                    : p.amountMinor < 0
                      ? "Vuelto"
                      : p.methodName}
            {doc.type !== "TRANSFER" &&
            (doc.type === "RETURN" ||
              doc.type === "PURCHASE_RETURN" ||
              doc.type === "EXPENSE" ||
              doc.type === "PAYMENT_OUT" ||
              p.amountMinor < 0)
              ? ` (${p.methodName})`
              : ""}
          </span>
          <span>{formatMoney(Math.abs(p.amountMinor), p.currency)}</span>
        </p>
      ))}
      {doc.creditMinor !== 0 && doc.creditCurrency ? (
        <div className="mt-1 border border-current border-dashed p-1">
          <p className="flex justify-between font-bold">
            <span>{doc.creditMinor < 0 ? "CRÉDITO ANULADO" : "A CRÉDITO (DEBE)"}</span>
            <span>{formatMoney(Math.abs(doc.creditMinor), doc.creditCurrency)}</span>
          </p>
          {doc.dueAt ? <p>Pagar antes del {formatDateTime(doc.dueAt).split(",")[0]}</p> : null}
        </div>
      ) : null}
      {doc.type === "SALE" || doc.type === "PAYMENT_IN" || doc.type === "RETURN" ? (
        <p className="mt-3 whitespace-pre-line text-center">
          {business?.receiptFooter ?? "¡Gracias por su compra!"}
        </p>
      ) : null}
    </div>
  )
}

/** Recibo al terminar una venta: se imprime solo si está configurado y abre la gaveta. */
export function ReceiptDialog({
  documentId,
  onClose,
  done = "Nueva venta",
}: {
  documentId: string | null
  onClose: () => void
  /** Texto del botón que cierra el recibo. */
  done?: string
}) {
  const boot = useQuery(bootstrapQuery)
  const doc = useQuery({ ...documentQuery(documentId ?? ""), enabled: documentId !== null })
  const { print, printing, mode, autoPrint } = usePrintDocument()
  // Impresión automática y gaveta: una sola vez por venta (reimprimir no vuelve a abrirla).
  const handled = useRef<string | null>(null)

  useEffect(() => {
    const d = doc.data
    if (!d || !boot.data || handled.current === d.id) return
    handled.current = d.id
    const cash = d.payments.some(
      (p) => boot.data.paymentMethods.find((m) => m.id === p.paymentMethodId)?.kind === "cash",
    )
    const wantsDrawer = boot.data.printer.openDrawer && mode !== "browser" && cash
    if (autoPrint) {
      // Con la impresora del navegador se espera a que el recibo esté pintado.
      setTimeout(() => void print(d.id, { openDrawer: wantsDrawer }), mode === "browser" ? 300 : 0)
    } else if (wantsDrawer) {
      void openDrawer()
    }
  }, [doc.data, boot.data, autoPrint, mode, print])

  return (
    <Dialog open={documentId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Recibo</DialogTitle>
        <DialogDescription className="sr-only">Recibo de la venta para imprimir</DialogDescription>
        {doc.data ? (
          <div className="rounded-lg border bg-white p-4 text-black">
            <Receipt doc={doc.data} business={boot.data?.business} />
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Cargando…</p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => doc.data && print(doc.data.id)}
            disabled={!doc.data || printing}
          >
            <PrinterIcon /> {printing ? "Imprimiendo…" : "Imprimir"}
          </Button>
          <Button onClick={onClose} autoFocus>
            {done}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
