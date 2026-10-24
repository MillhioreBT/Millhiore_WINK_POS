import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { HandCoinsIcon, MessageCircleIcon } from "lucide-react"
import { formatDateTime, formatMoney } from "../../lib/format"
import { bootstrapQuery, statementQuery } from "../../lib/queries"
import { can, useMe } from "../../lib/session"

/** "0414-1234567" → "584141234567" (el formato que pide wa.me); null si no parece un teléfono. */
export function whatsappNumber(phone: string | null): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, "")
  if (digits.length < 10) return null
  if (digits.startsWith("58")) return digits
  return `58${digits.replace(/^0+/, "")}`
}

/** Estado de cuenta de un cliente: lo que debe venta por venta y su historial de fiados y abonos. */
export function StatementDialog({
  contactId,
  onClose,
  onCollect,
}: {
  contactId: string
  onClose: () => void
  onCollect: () => void
}) {
  const me = useMe()
  const boot = useQuery(bootstrapQuery)
  const statement = useQuery(statementQuery(contactId))
  const data = statement.data
  const phone = whatsappNumber(data?.contact.phone ?? null)
  const reminder = data?.balances.length
    ? `Hola ${data.contact.name}, te escribimos de ${boot.data?.business.name ?? "la tienda"}. Tienes un saldo pendiente de ${data.balances
        .map((b) => formatMoney(b.outstandingMinor, b.currency))
        .join(" y ")}. ¡Gracias!`
    : null

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{data?.contact.name ?? "Estado de cuenta"}</DialogTitle>
          <DialogDescription>
            {data
              ? [
                  data.contact.taxId,
                  data.contact.phone,
                  data.contact.creditDays
                    ? `${data.contact.creditDays} días de crédito`
                    : "sin plazo de pago",
                  data.contact.creditLimitMinor !== null
                    ? `límite ${formatMoney(data.contact.creditLimitMinor, data.referenceCurrency)}`
                    : "sin límite",
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Cargando…"}
          </DialogDescription>
        </DialogHeader>

        {data ? (
          <div className="grid grid-cols-1 gap-4">
            <div className="rounded-lg bg-muted/60 p-3">
              {data.balances.length ? (
                <ul className="grid gap-1">
                  {data.balances.map((b) => (
                    <li key={b.currency} className="flex flex-wrap items-baseline justify-between">
                      <span className="text-muted-foreground text-sm">Debe</span>
                      <span className="tabular font-bold text-2xl">
                        {formatMoney(b.outstandingMinor, b.currency)}
                        {b.overdueMinor > 0 ? (
                          <Badge variant="destructive" className="ml-2 align-middle">
                            {formatMoney(b.overdueMinor, b.currency)} vencido
                          </Badge>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="font-medium text-success">No debe nada.</p>
              )}
            </div>

            {data.open.length ? (
              <section>
                <h3 className="mb-1 font-medium text-sm">Por cobrar</h3>
                <ul className="divide-y rounded-lg border text-sm">
                  {data.open.map((s) => (
                    <li key={s.id} className="grid grid-cols-[1fr_auto] gap-x-3 px-3 py-2">
                      <span className="font-medium">
                        {s.kind === "DEBT_IN" ? `${s.label} · ` : ""}
                        {s.number}
                        {s.overdue ? (
                          <Badge variant="destructive" className="ml-2">
                            Vencida
                          </Badge>
                        ) : null}
                      </span>
                      <span className="tabular text-right font-medium">
                        {formatMoney(s.outstandingMinor, s.currency)}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {formatDateTime(s.postedAt)}
                        {s.dueAt ? ` · vence ${formatDateTime(s.dueAt).split(",")[0]}` : ""}
                      </span>
                      <span className="tabular text-right text-muted-foreground text-xs">
                        {s.paidMinor > 0
                          ? `de ${formatMoney(s.creditMinor, s.currency)}`
                          : "sin abonos"}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {data.movements.length ? (
              <section>
                <h3 className="mb-1 font-medium text-sm">Historial</h3>
                <ul className="max-h-56 divide-y overflow-y-auto rounded-lg border text-sm">
                  {data.movements.map((m) => (
                    <li
                      key={m.id}
                      className={`flex items-baseline justify-between gap-3 px-3 py-2 ${m.voided ? "text-muted-foreground line-through" : ""}`}
                    >
                      <span>
                        {m.type === "SALE" ? "Fiado" : m.type === "DEBT_IN" ? "Deuda" : "Abono"}{" "}
                        {m.number}
                        <span className="ml-2 text-muted-foreground text-xs">
                          {formatDateTime(m.postedAt)}
                        </span>
                      </span>
                      <span
                        className={`tabular font-medium ${m.type === "PAYMENT_IN" && !m.voided ? "text-success" : ""}`}
                      >
                        {m.type === "PAYMENT_IN" ? "−" : "+"}
                        {formatMoney(m.amountMinor, m.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {phone && reminder ? (
            <Button variant="outline" asChild>
              <a
                href={`https://wa.me/${phone}?text=${encodeURIComponent(reminder)}`}
                target="_blank"
                rel="noreferrer"
              >
                <MessageCircleIcon /> Recordar por WhatsApp
              </a>
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
          {data?.balances.length && can(me, "payment.receive") ? (
            <Button variant="success" onClick={onCollect}>
              <HandCoinsIcon /> Cobrar abono
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
