import type { PlacedOrder, PublicCatalog, PublicProduct } from "@millhiore/contracts"
import { formatMoney, formatQtyUnit } from "../lib/format"

/** Un producto en el pedido del cliente (en su equipo, hasta que lo manda). */
export interface CartLine {
  variantId: string
  name: string
  unit: PublicProduct["unit"]
  qtyMilli: number
  /** Indicaciones («sin cebolla»); cada indicación distinta va en su línea. */
  note: string | null
}

const sameLine = (a: CartLine, b: CartLine) =>
  a.variantId === b.variantId && (a.note ?? "") === (b.note ?? "")

/** Agrega al pedido: si ya está (con las mismas indicaciones), suma la cantidad. */
export function addLine(lines: readonly CartLine[], line: CartLine): CartLine[] {
  const found = lines.find((l) => sameLine(l, line))
  if (!found) return [...lines, line]
  return lines.map((l) => (l === found ? { ...l, qtyMilli: l.qtyMilli + line.qtyMilli } : l))
}

/** Cambia la cantidad de una línea; en cero, la quita. */
export function setLineQty(
  lines: readonly CartLine[],
  index: number,
  qtyMilli: number,
): CartLine[] {
  return qtyMilli > 0
    ? lines.map((l, i) => (i === index ? { ...l, qtyMilli } : l))
    : lines.filter((_, i) => i !== index)
}

/** Precio × cantidad en milésimas, redondeado como en el servidor. */
export const lineTotal = (unitMinor: number, qtyMilli: number) =>
  Math.floor((unitMinor * qtyMilli + 500) / 1000)

/**
 * Lo que vale el pedido con los precios de ahora del catálogo, y las líneas que siguen a la venta
 * (lo que salió del catálogo se descarta al abrir la página).
 */
export function priced(
  lines: readonly CartLine[],
  catalog: PublicCatalog,
): {
  lines: (CartLine & {
    referenceMinor: number | null
    legalMinor: number | null
    available: boolean
  })[]
  reference: number | null
  legal: number | null
} {
  const variants = new Map(catalog.products.flatMap((p) => p.variants.map((v) => [v.id, v])))
  const out = lines.flatMap((l) => {
    const v = variants.get(l.variantId)
    return v
      ? [
          {
            ...l,
            referenceMinor: v.referenceMinor,
            legalMinor: v.legalMinor,
            available: v.available,
          },
        ]
      : []
  })
  const sum = (key: "referenceMinor" | "legalMinor") =>
    out.some((l) => l[key] === null)
      ? null
      : out.reduce((t, l) => t + lineTotal(l[key] ?? 0, l.qtyMilli), 0)
  return { lines: out, reference: sum("referenceMinor"), legal: sum("legalMinor") }
}

/** Cuántas cosas lleva (las de peso cuentan una). */
export const itemCount = (lines: readonly CartLine[]) =>
  lines.reduce((n, l) => n + (l.unit === "unit" ? l.qtyMilli / 1000 : 1), 0)

/** «1,5» o «0,250» → milésimas; null si no es una cantidad. */
export function parseQty(text: string): number | null {
  const clean = text.trim().replace(/\s/g, "").replace(",", ".")
  if (!/^\d+(\.\d{1,3})?$/.test(clean)) return null
  const milli = Math.round(Number(clean) * 1000)
  return milli > 0 ? milli : null
}

export interface Customer {
  name: string
  phone: string
  delivery: "pickup" | "delivery"
  address: string
  payment: string
  note: string
}

/** El mensaje que el cliente manda por WhatsApp, con los precios con que quedó anotado. */
export function whatsappText(order: PlacedOrder, customer: Customer): string {
  const ref = (minor: number | null) =>
    minor === null ? null : formatMoney(minor, order.referenceCurrency)
  const legal = (minor: number | null) =>
    minor === null ? null : formatMoney(minor, order.legalCurrency)
  const lines = order.lines.flatMap((l) => {
    const price =
      l.referenceMinor !== null
        ? ref(lineTotal(l.referenceMinor, l.qtyMilli))
        : legal(l.legalMinor === null ? null : lineTotal(l.legalMinor, l.qtyMilli))
    return [
      `• ${formatQtyUnit(l.qtyMilli, l.unit)} × ${l.name}${price ? `: ${price}` : ""}`,
      ...(l.note ? [`   (${l.note})`] : []),
    ]
  })
  const totalRef = ref(order.totalReferenceMinor)
  const totalLegal = legal(order.totalLegalMinor)
  const total = totalRef
    ? `Total: ${totalRef}${totalLegal ? ` (${totalLegal})` : ""}`
    : totalLegal
      ? `Total: ${totalLegal}`
      : null
  return [
    `Hola, quiero hacer este pedido (${order.number}):`,
    ...lines,
    total,
    `A nombre de: ${customer.name.trim()} · ${customer.phone.trim()}`,
    customer.delivery === "delivery"
      ? `Delivery a: ${customer.address.trim()}`
      : "Lo retiro en la tienda",
    customer.payment ? `Pago: ${customer.payment}` : null,
    customer.note.trim() ? `Nota: ${customer.note.trim()}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n")
}

/** Un id para el pedido (también por HTTP, donde `crypto.randomUUID` no existe). */
export function newOrderId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("")
}

const CART_KEY = "millhiore.catalog.cart"
const CUSTOMER_KEY = "millhiore.catalog.customer"

/** Lee lo guardado en el equipo; si no se puede (modo privado), nada. */
function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // sin almacenamiento: el pedido vive mientras la página esté abierta
  }
}

export const loadCart = (): CartLine[] => {
  const lines = read<CartLine[]>(CART_KEY)
  return Array.isArray(lines) ? lines : []
}
export const saveCart = (lines: CartLine[]) => write(CART_KEY, lines.length ? lines : null)
export const loadCustomer = (): Partial<Customer> => read<Partial<Customer>>(CUSTOMER_KEY) ?? {}
export const saveCustomer = (c: Customer) =>
  write(CUSTOMER_KEY, { name: c.name, phone: c.phone, address: c.address })
