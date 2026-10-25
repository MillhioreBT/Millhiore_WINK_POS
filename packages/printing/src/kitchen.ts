import type { KitchenTicket } from "@millhiore/contracts"
import { columns, type PrintLine, wrap } from "./receipt"

const qty = new Intl.NumberFormat("es-VE", { maximumFractionDigits: 3 })

function time(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("es-VE", { timeZone, timeStyle: "short" })
    .format(ms)
    .replace(/ | /g, " ")
}

/**
 * La comanda como la lee quien cocina: para quién en grande, cada producto con su cantidad y,
 * debajo, sus opciones e indicaciones. Una anulación lo dice arriba y abajo.
 */
export function kitchenLines(ticket: KitchenTicket, width: number, timeZone: string): PrintLine[] {
  const rule: PrintLine = { text: "=".repeat(width) }
  const voided = ticket.kind === "void"
  const banner: PrintLine[] = voided
    ? [{ text: "*** ANULAR ***", align: "center", bold: true, tall: true }]
    : []
  const out: PrintLine[] = [
    ...banner,
    { text: ticket.stationName.toUpperCase(), align: "center", bold: true },
    ...wrap(ticket.source.toUpperCase(), width).map(
      (t): PrintLine => ({ text: t, align: "center", bold: true, tall: true }),
    ),
    ...columns(
      `#${ticket.number} · ${time(ticket.createdAt, timeZone)}`,
      ticket.createdBy ?? "",
      width,
    ).map((t): PrintLine => ({ text: t })),
    rule,
  ]
  for (const l of ticket.lines) {
    out.push(
      ...wrap(`${qty.format(l.qtyMilli / 1000)} × ${l.name}`, width).map(
        (t): PrintLine => ({ text: t, bold: true, tall: true }),
      ),
    )
    for (const m of l.modifiers) {
      out.push(...wrap(`+ ${m.name}`, width - 2).map((t): PrintLine => ({ text: `  ${t}` })))
    }
    if (l.note) {
      out.push(
        ...wrap(`** ${l.note}`, width - 2).map((t): PrintLine => ({ text: `  ${t}`, bold: true })),
      )
    }
  }
  out.push(rule)
  return voided ? [...out, ...banner] : out
}
