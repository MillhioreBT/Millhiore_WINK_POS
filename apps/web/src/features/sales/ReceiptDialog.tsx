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
import { formatDateTime, formatMoney, formatPercent, formatQty, formatRate } from "../../lib/format"
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

/** Encabezado de recibos y reportes: nombre, RIF, dirección y teléfono del negocio. */
export function BusinessHeader({ business }: { business: BusinessInfo | undefined }) {
  if (!business) return null
  return (
    <>
      <p className="font-bold text-sm">{business.name}</p>
      {business.taxId ? <p>RIF {business.taxId}</p> : null}
      {business.address ? <p>{business.address}</p> : null}
      {business.phone ? <p>Tel. {business.phone}</p> : null}
    </>
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
        <BusinessHeader business={business} />
        <p className="mt-1">{TITLE[doc.type] ?? doc.type}</p>
        <p>
          {doc.number} · {formatDateTime(doc.postedAt)}
        </p>
        {doc.createdBy ? <p>Atendió: {doc.createdBy}</p> : null}
        {doc.contactName ? (
          <p>
            {doc.type === "PURCHASE" || doc.type === "EXPENSE" || doc.type === "PAYMENT_OUT"
              ? "Proveedor"
              : "Cliente"}
            : {doc.contactName}
            {doc.contactTaxId ? ` · ${doc.contactTaxId}` : ""}
          </p>
        ) : null}
        {doc.expenseCategoryName ? <p>Categoría: {doc.expenseCategoryName}</p> : null}
        {doc.stockReasonName ? <p>Motivo: {doc.stockReasonName}</p> : null}
        {doc.externalRef ? <p>Factura: {doc.externalRef}</p> : null}
        {doc.note ? <p>{doc.note}</p> : null}
        {doc.returnsNumber ? <p>Devolución de la venta {doc.returnsNumber}</p> : null}
        {doc.reversesDocumentId ? <p className="font-bold">ANULACIÓN</p> : null}
        {doc.reversedBy ? <p className="font-bold">*** ANULADA ***</p> : null}
      </div>
      <hr className="my-2 border-dashed border-current" />
      {doc.allocations.length ? (
        <>
          <p>
            {doc.type === "RETURN"
              ? "Descontado de lo que debe:"
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
          <p className="flex justify-between">
            <span>
              {formatQty(l.qtyMilli)} × {formatMoney(l.unitPriceMinor, cur)}
            </span>
            <span>{formatMoney(l.lineTotalMinor + l.discountMinor, cur)}</span>
          </p>
          {l.discountMinor !== 0 ? (
            <p className="flex justify-between">
              <span>&nbsp;&nbsp;Descuento</span>
              <span>-{formatMoney(l.discountMinor, cur)}</span>
            </p>
          ) : null}
        </div>
      ))}
      <hr className="my-2 border-dashed border-current" />
      {/* Sin impuesto asignado (negocio que no cobra IVA) no hay desglose que mostrar. */}
      {doc.taxes
        .filter((t) => t.taxId !== null)
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
              <span>{KIND_LABEL[t.kind] ?? "Exento"} (E)</span>
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
                : doc.type === "EXPENSE" || doc.type === "PAYMENT_OUT"
                  ? "Pagado"
                  : p.amountMinor < 0
                    ? "Vuelto"
                    : p.methodName}
            {doc.type !== "TRANSFER" &&
            (doc.type === "RETURN" ||
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
