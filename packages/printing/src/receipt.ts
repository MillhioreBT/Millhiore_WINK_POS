import type { Bootstrap, DocumentDetail } from "@millhiore/contracts"
import { type Align, EscPos } from "./escpos"

/** Columnas de texto por ancho de papel con la letra normal (Font A). */
export const COLUMNS = { 58: 32, 80: 48 } as const
export type PaperWidth = keyof typeof COLUMNS

export interface PrintLine {
  text: string
  align?: Align
  bold?: boolean
  /** Doble alto (títulos). */
  tall?: boolean
}

type Business = Pick<
  Bootstrap["business"],
  "name" | "taxId" | "address" | "phone" | "receiptFooter" | "timezone"
>

const SYMBOLS: Record<string, string> = { USD: "$", VES: "Bs", EUR: "EUR", USDT: "USDT" }

const amount = new Intl.NumberFormat("es-VE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const qty = new Intl.NumberFormat("es-VE", { maximumFractionDigits: 3 })

export function money(minor: number, currency: string): string {
  return `${SYMBOLS[currency] ?? currency} ${amount.format(minor / 100)}`
}

function percent(bp: number): string {
  return `${new Intl.NumberFormat("es-VE", { maximumFractionDigits: 2 }).format(bp / 100)} %`
}

function rate(value: string): string {
  const [int = "0", dec = ""] = value.split(".")
  const trimmed = dec.replace(/0+$/, "")
  const intPart = new Intl.NumberFormat("es-VE").format(Number(int))
  return trimmed ? `${intPart},${trimmed}` : intPart
}

function dateTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("es-VE", { timeZone, dateStyle: "short", timeStyle: "short" })
    .format(ms)
    .replace(/ | /g, " ")
}

/** Corta un texto en líneas de hasta `width` caracteres, por palabras cuando se puede. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split("\n")) {
    let current = ""
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!current) current = word
      else if (current.length + 1 + word.length <= width) current += ` ${word}`
      else {
        lines.push(current)
        current = word
      }
      while (current.length > width) {
        lines.push(current.slice(0, width))
        current = current.slice(width)
      }
    }
    lines.push(current)
  }
  return lines
}

/** Texto a la izquierda y monto a la derecha; si no caben, el texto baja a varias líneas. */
export function columns(left: string, right: string, width: number): string[] {
  const room = width - right.length - 1
  if (room < 4) return [...wrap(left, width), right.padStart(width)]
  const parts = wrap(left, room)
  const last = parts.pop() ?? ""
  return [...parts, `${last.padEnd(room)} ${right}`]
}

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
}

const KIND_LABEL: Record<string, string> = {
  exempt: "Exento",
  exonerated: "Exonerado",
  not_subject: "No sujeto",
}

/** Encabezado con los datos del negocio. */
export function headerLines(business: Business, width: number): PrintLine[] {
  const center = (text: string): PrintLine[] =>
    wrap(text, width).map((t) => ({ text: t, align: "center" }))
  return [
    ...wrap(business.name, width).map(
      (t): PrintLine => ({ text: t, align: "center", bold: true, tall: true }),
    ),
    ...(business.taxId ? center(`RIF ${business.taxId}`) : []),
    ...(business.address ? center(business.address) : []),
    ...(business.phone ? center(`Tel. ${business.phone}`) : []),
  ]
}

/**
 * El recibo de un documento en líneas de texto, igual al que se ve en pantalla: encabezado,
 * renglones, desglose de IVA, IGTF, referencia en divisas y pagos.
 */
export function receiptLines(doc: DocumentDetail, business: Business, width: number): PrintLine[] {
  const cur = doc.currency
  const rule: PrintLine = { text: "-".repeat(width) }
  const center = (text: string, bold = false): PrintLine[] =>
    wrap(text, width).map((t) => ({ text: t, align: "center", bold }))
  const pair = (left: string, right: string, bold = false): PrintLine[] =>
    columns(left, right, width).map((t) => ({ text: t, bold }))

  const out: PrintLine[] = [...headerLines(business, width)]
  out.push(...center(TITLE[doc.type] ?? doc.type))
  out.push(...center(`${doc.number} · ${dateTime(doc.postedAt, business.timezone)}`))
  if (doc.createdBy) out.push(...center(`Atendió: ${doc.createdBy}`))
  if (doc.contactName) {
    const who =
      doc.type === "PURCHASE" ||
      doc.type === "PURCHASE_RETURN" ||
      doc.type === "EXPENSE" ||
      doc.type === "PAYMENT_OUT"
        ? "Proveedor"
        : "Cliente"
    out.push(
      ...center(`${who}: ${doc.contactName}${doc.contactTaxId ? ` · ${doc.contactTaxId}` : ""}`),
    )
  }
  if (doc.expenseCategoryName) out.push(...center(`Categoría: ${doc.expenseCategoryName}`))
  if (doc.stockReasonName) out.push(...center(`Motivo: ${doc.stockReasonName}`))
  if (doc.discountCode) out.push(...center(`Código de descuento: ${doc.discountCode}`))
  if (doc.externalRef) out.push(...center(`Factura: ${doc.externalRef}`))
  if (doc.note) out.push(...center(doc.note))
  if (doc.returnsNumber) {
    const of = doc.type === "PURCHASE_RETURN" ? "compra" : "venta"
    out.push(...center(`Devolución de la ${of} ${doc.returnsNumber}`))
  }
  if (doc.reversesDocumentId) out.push(...center("ANULACIÓN", true))
  if (doc.reversedBy) out.push(...center("*** ANULADA ***", true))

  if (doc.type === "STOCK_TRANSFER") {
    const reversed = doc.reversesDocumentId !== null
    out.push(...center(`De: ${reversed ? doc.toLocationName : doc.locationName}`))
    out.push(...center(`A: ${reversed ? doc.locationName : doc.toLocationName}`))
    out.push(rule)
    for (const l of doc.lines) {
      out.push(...pair(l.name, qty.format(Math.abs(l.qtyMilli) / 1000)))
    }
    out.push(rule)
    const units = doc.lines.reduce((acc, l) => acc + Math.abs(l.qtyMilli), 0)
    out.push(...pair("UNIDADES", qty.format(units / 1000), true))
    return out
  }

  out.push(rule)
  if (doc.allocations.length) {
    out.push({
      text:
        doc.type === "RETURN"
          ? "Descontado de lo que debe:"
          : doc.type === "PURCHASE_RETURN"
            ? "Descontado de lo que se le debe:"
            : doc.type === "PAYMENT_OUT"
              ? "Pago de:"
              : "Abono a:",
    })
    for (const a of doc.allocations) out.push(...pair(a.saleNumber, money(a.amountMinor, cur)))
    out.push(rule)
  }
  for (const l of doc.lines) {
    const exempt = l.taxId && l.taxRateBp === 0 ? " (E)" : ""
    out.push(...wrap(`${l.name}${exempt}`, width).map((t) => ({ text: t })))
    // Con descuento se muestra el importe de lista y, debajo, lo que se descontó.
    out.push(
      ...pair(
        `${qty.format(l.qtyMilli / 1000)} × ${money(l.unitPriceMinor, cur)}`,
        money(l.lineTotalMinor + l.discountMinor, cur),
      ),
    )
    if (l.discountMinor !== 0) out.push(...pair("  Descuento", `-${money(l.discountMinor, cur)}`))
  }
  // Recargos de la venta (delivery, servicio), después de los productos.
  for (const c of doc.charges ?? []) {
    const exempt = c.taxId && c.taxRateBp === 0 ? " (E)" : ""
    const label = c.kind === "percent" ? `${c.name} ${percent(c.rateBp)}` : c.name
    out.push(...pair(`${label}${exempt}`, money(c.amountMinor, cur)))
  }
  out.push(rule)

  // Sin impuesto asignado (negocio que no cobra IVA) no hay desglose; si cobra IVA, lo que no lo
  // lleva (un recargo de servicio) sale como no sujeto.
  const chargesVat = doc.taxes.some((t) => t.taxId !== null)
  for (const t of doc.taxes.filter((t) => chargesVat && (t.taxId !== null || t.baseMinor !== 0))) {
    if (t.rateBp > 0) {
      out.push(...pair(`Base imponible ${percent(t.rateBp)}`, money(t.baseMinor, cur)))
      out.push(...pair(`IVA ${percent(t.rateBp)}`, money(t.taxMinor, cur)))
    } else {
      const code = t.kind === "not_subject" ? "" : " (E)"
      out.push(...pair(`${KIND_LABEL[t.kind] ?? "Exento"}${code}`, money(t.baseMinor, cur)))
    }
  }
  out.push(
    ...pair(
      doc.type === "PAYMENT_IN"
        ? "ABONO"
        : doc.type === "PAYMENT_OUT"
          ? "PAGO"
          : doc.type === "TRANSFER"
            ? "TRANSFERIDO"
            : "TOTAL",
      money(doc.totalMinor, cur),
      true,
    ),
  )
  for (const s of doc.surcharges) {
    out.push(
      ...pair(`IGTF ${percent(s.rateBp)} s/ ${money(s.baseMinor, cur)}`, money(s.amountMinor, cur)),
    )
  }
  const total = doc.totalMinor + doc.surchargeMinor
  if (doc.surchargeMinor) out.push(...pair("TOTAL A PAGAR", money(total, cur), true))
  if (doc.rate && doc.rate.quote === cur) {
    const ref = Math.round(total / Number(doc.rate.value))
    out.push(...center(`Tasa BCV ${rate(doc.rate.value)} · Ref. ${money(ref, doc.rate.base)}`))
  }

  if (doc.payments.length) {
    out.push(rule)
    for (const [i, p] of doc.payments.entries()) {
      const reversed = doc.reversesDocumentId !== null
      const label =
        doc.type === "TRANSFER"
          ? `${i === 0 ? (reversed ? "Regresa a" : "Sale de") : reversed ? "Sale de" : "Entra en"} ${p.methodName}`
          : doc.type === "RETURN"
            ? `Reembolso (${p.methodName})`
            : doc.type === "PURCHASE_RETURN"
              ? `Reembolso del proveedor (${p.methodName})`
              : doc.type === "EXPENSE" || doc.type === "PAYMENT_OUT"
                ? `Pagado (${p.methodName})`
                : p.amountMinor < 0
                  ? `Vuelto (${p.methodName})`
                  : p.methodName
      out.push(...pair(label, money(Math.abs(p.amountMinor), p.currency)))
    }
  }
  // Lo que el cliente se llevó fiado: cuánto debe y hasta cuándo puede pagar.
  if (doc.creditMinor !== 0 && doc.creditCurrency) {
    out.push(rule)
    out.push(
      ...pair(
        doc.creditMinor < 0 ? "CRÉDITO ANULADO" : "A CRÉDITO (DEBE)",
        money(Math.abs(doc.creditMinor), doc.creditCurrency),
        true,
      ),
    )
    if (doc.dueAt) {
      const due = dateTime(doc.dueAt, business.timezone).split(",")[0] ?? ""
      out.push(...center(`Pagar antes del ${due}`))
    }
  }
  if (doc.type === "SALE" || doc.type === "PAYMENT_IN" || doc.type === "RETURN") {
    out.push({ text: "" })
    out.push(...center(business.receiptFooter ?? "¡Gracias por su compra!"))
  }
  return out
}

/** Página de prueba: confirma que la impresora, el papel y los acentos salen bien. */
export function testPageLines(business: Business, width: number, now: number): PrintLine[] {
  return [
    ...headerLines(business, width),
    { text: "PRUEBA DE IMPRESIÓN", align: "center", bold: true },
    { text: dateTime(now, business.timezone), align: "center" },
    { text: "-".repeat(width) },
    { text: `Papel de ${width === COLUMNS[58] ? 58 : 80} mm · ${width} columnas` },
    { text: "Acentos: áéíóú ÁÉÍÓÚ ñÑ ü ¿¡ º ª ×" },
    ...columns("Texto a la izquierda", money(123456789, "VES"), width).map((t) => ({ text: t })),
    { text: "1234567890".repeat(Math.ceil(width / 10)).slice(0, width) },
    { text: "-".repeat(width) },
    { text: "Si lees esto, la impresora está lista.", align: "center" },
  ]
}

/** Convierte las líneas en un trabajo ESC/POS listo para enviar a la impresora. */
export function toEscPos(
  lines: PrintLine[],
  opts: { openDrawer?: boolean; cut?: boolean } = {},
): Uint8Array {
  const job = new EscPos()
  if (opts.openDrawer) job.openDrawer()
  let align: Align = "left"
  job.align(align)
  for (const l of lines) {
    const want = l.align ?? "left"
    if (want !== align) {
      job.align(want)
      align = want
    }
    if (l.bold) job.bold(true)
    if (l.tall) job.size(1, 2)
    job.line(l.text)
    if (l.tall) job.size(1, 1)
    if (l.bold) job.bold(false)
  }
  job.feed(4)
  if (opts.cut ?? true) job.cut()
  return job.encode()
}

/** Las líneas como texto plano (vista previa y pruebas). */
export function toPlainText(lines: PrintLine[], width: number): string {
  return lines
    .map((l) => {
      if (l.align === "center") {
        const pad = Math.max(0, Math.floor((width - l.text.length) / 2))
        return " ".repeat(pad) + l.text
      }
      return l.align === "right" ? l.text.padStart(width) : l.text
    })
    .join("\n")
}
