import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { MessageCircleIcon, PrinterIcon, ShoppingCartIcon, XCircleIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import {
  formatDateTime,
  formatDay,
  formatMoney,
  formatPercent,
  formatQty,
  formatRate,
} from "../../lib/format"
import { bootstrapQuery, queryClient, quoteQuery, rateStatusQuery } from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { buildCart, convertMinor, makeContext } from "../pos/compute"
import { usePos } from "../pos/store"
import { whatsappNumber } from "../receivables/StatementDialog"
import { BusinessHeader } from "../sales/ReceiptDialog"
import { isExpired, QUOTE_STATUS, quoteCharges, quoteLines } from "./quoteTicket"

/**
 * Una cotización lista para imprimir o mandar por WhatsApp, con los montos en Bs a la tasa de hoy
 * (se cobran a la del día del pago). Desde aquí se vende o se anula.
 */
export function QuoteDialog({ quoteId, onClose }: { quoteId: string; onClose: () => void }) {
  const me = useMe()
  const navigate = useNavigate()
  const boot = useQuery(bootstrapQuery)
  const rate = useQuery(rateStatusQuery)
  const quote = useQuery(quoteQuery(quoteId))
  const loadQuote = usePos((s) => s.loadQuote)
  const [busy, setBusy] = useState(false)
  const ctx = useMemo(
    () => (boot.data ? makeContext(boot.data, rate.data?.current?.value ?? null) : null),
    [boot.data, rate.data],
  )
  const q = quote.data
  const cart = useMemo(
    () => (ctx && q ? buildCart(ctx, quoteLines(q), q.saleDiscount, null, quoteCharges(q)) : null),
    [ctx, q],
  )
  if (!q || !ctx || !cart) return null

  const doc = ctx.docCurrency
  const ref = ctx.refCurrency
  const totalRef = convertMinor(ctx, cart.ticket.totalMinor, doc, ref)
  const expired = isExpired(q)
  const inactive = q.lines.some((l) => !l.active)
  const canSell = q.status === "open" && can(me, "sale.create") && !inactive

  const text = [
    `*Cotización ${q.number}* · ${boot.data?.business.name ?? ""}`,
    q.contactName ? `Para: ${q.contactName}` : null,
    `Válida hasta el ${formatDay(q.validUntil)}`,
    "",
    ...cart.lines.map(
      (l, i) =>
        `${formatQty(l.qtyMilli)} × ${l.name}: ${formatMoney(cart.ticket.lineTotals[i] ?? 0, doc)}`,
    ),
    ...cart.ticket.charges.map((c) => `${c.name}: ${formatMoney(c.amountMinor, doc)}`),
    "",
    `*Total: ${formatMoney(cart.ticket.totalMinor, doc)}*${totalRef !== null ? ` (${formatMoney(totalRef, ref)})` : ""}`,
    ctx.rate
      ? `Tasa BCV de hoy: ${formatRate(ctx.rate.value)}. Se cobra a la tasa del día del pago.`
      : null,
    q.note ? `\n${q.note}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n")
  const phone = whatsappNumber(q.contactPhone)

  const sell = () => {
    loadQuote(
      {
        id: q.id,
        number: q.number,
        validUntil: q.validUntil,
        contact: q.contact,
      },
      { lines: quoteLines(q), saleDiscount: q.saleDiscount, charges: quoteCharges(q) },
    )
    onClose()
    void navigate({ to: "/caja" })
  }

  const cancel = async () => {
    setBusy(true)
    try {
      await api(`/api/quotes/${q.id}/cancel`, { body: {} })
      await queryClient.invalidateQueries({ queryKey: ["quotes"] })
      toast.success(`Cotización ${q.number} anulada`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Cotización {q.number}</DialogTitle>
        <DialogDescription>
          {QUOTE_STATUS[q.status]}
          {expired ? " · vencida: los precios pueden haber cambiado" : ""}
          {q.documentNumber ? ` en la venta ${q.documentNumber}` : ""}
        </DialogDescription>
        <div className="rounded-lg border bg-white p-4 text-black">
          <div
            id="receipt"
            className="mx-auto w-full max-w-[320px] font-mono text-[12px] leading-snug"
          >
            <div className="text-center">
              <BusinessHeader business={boot.data?.business} />
              <p className="mt-1">COTIZACIÓN · NO FISCAL</p>
              <p>
                {q.number} · {formatDateTime(q.createdAt)}
              </p>
              <p>Válida hasta el {formatDay(q.validUntil)}</p>
              {q.createdBy ? <p>Atendió: {q.createdBy}</p> : null}
              {q.contactName ? <p>Cliente: {q.contactName}</p> : null}
            </div>
            <hr className="my-2 border-dashed border-current" />
            {cart.lines.map((l, i) => (
              <div key={l.variantId} className="mb-1">
                <p>{l.name}</p>
                <p className="flex justify-between">
                  <span>
                    {formatQty(l.qtyMilli)} × {formatMoney(l.unitPriceMinor, doc)}
                  </span>
                  <span>
                    {formatMoney((cart.ticket.lineTotals[i] ?? 0) + (l.discountMinor ?? 0), doc)}
                  </span>
                </p>
                {l.discountMinor ? (
                  <p className="flex justify-between">
                    <span>&nbsp;&nbsp;Descuento</span>
                    <span>-{formatMoney(l.discountMinor, doc)}</span>
                  </p>
                ) : null}
              </div>
            ))}
            {cart.ticket.charges.map((c) => (
              <p key={c.chargeId} className="flex justify-between">
                <span>
                  {c.name}
                  {c.kind === "percent" ? ` ${formatPercent(c.rateBp)}` : ""}
                </span>
                <span>{formatMoney(c.amountMinor, doc)}</span>
              </p>
            ))}
            <hr className="my-2 border-dashed border-current" />
            {cart.ticket.taxes
              .filter((t) => t.taxMinor !== 0)
              .map((t) => (
                <p key={`${t.taxId}-${t.rateBp}`} className="flex justify-between">
                  <span>
                    IVA {formatPercent(t.rateBp)} s/ {formatMoney(t.baseMinor, doc)}
                  </span>
                  <span>{formatMoney(t.taxMinor, doc)}</span>
                </p>
              ))}
            <p className="flex justify-between font-bold">
              <span>TOTAL</span>
              <span>{formatMoney(cart.ticket.totalMinor, doc)}</span>
            </p>
            {ctx.rate && totalRef !== null ? (
              <p className="mt-1 text-center">
                Tasa BCV de hoy {formatRate(ctx.rate.value)} · Ref. {formatMoney(totalRef, ref)}
              </p>
            ) : null}
            <p className="mt-1 text-center">Se cobra a la tasa BCV del día del pago.</p>
            {q.note ? <p className="mt-2 whitespace-pre-line text-center">{q.note}</p> : null}
          </div>
        </div>
        {inactive && q.status === "open" ? (
          <p className="text-destructive text-sm">
            Algún producto de la cotización ya no se vende: no se puede convertir en venta.
          </p>
        ) : null}
        <DialogFooter className="flex-wrap">
          {q.status === "open" && can(me, "sale.create") ? (
            <Button variant="ghost" onClick={cancel} disabled={busy}>
              <XCircleIcon /> Anular
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => window.print()}>
            <PrinterIcon /> Imprimir
          </Button>
          <Button variant="outline" asChild>
            <a
              href={`https://wa.me/${phone ?? ""}?text=${encodeURIComponent(text)}`}
              target="_blank"
              rel="noreferrer"
            >
              <MessageCircleIcon /> WhatsApp
            </a>
          </Button>
          {canSell ? (
            <Button onClick={sell}>
              <ShoppingCartIcon /> Vender
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
