import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { user } from "./access"
import { document } from "./documents"

/** Un producto pedido desde el catálogo, con el precio que vio el cliente (IVA incluido). */
export interface WebOrderLine {
  variantId: string
  /** Con la talla y el color: «Franela (M)». */
  name: string
  unit: "unit" | "kg" | "l" | "m"
  qtyMilli: number
  /** Precio de una unidad en la moneda de referencia y en la legal; null si no había tasa. */
  referenceMinor: number | null
  legalMinor: number | null
  /** Indicaciones del cliente («sin cebolla»). */
  note: string | null
}

/**
 * Pedido que hace un cliente desde el catálogo en línea. No mueve inventario ni dinero: llega a
 * la bandeja «Pedidos» (y por WhatsApp) y se cobra en la caja, que lo deja atendido con su venta.
 */
export const webOrder = sqliteTable(
  "web_order",
  {
    /** Lo genera la página del cliente: si reintenta, no se anota dos veces. */
    id: text("id").primaryKey(),
    /** P-000001, una serie para todo el negocio. */
    number: integer("number").notNull().unique(),
    status: text("status", { enum: ["new", "done", "cancelled"] })
      .notNull()
      .default("new"),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull(),
    delivery: text("delivery", { enum: ["pickup", "delivery"] }).notNull(),
    address: text("address"),
    /** Cómo quiere pagar (el nombre de un método de pago). */
    payment: text("payment"),
    note: text("note"),
    lines: text("lines", { mode: "json" }).notNull().$type<WebOrderLine[]>(),
    totalReferenceMinor: integer("total_reference_minor"),
    totalLegalMinor: integer("total_legal_minor"),
    referenceCurrency: text("reference_currency").notNull(),
    legalCurrency: text("legal_currency").notNull(),
    /** La lista de precios del catálogo cuando se pidió (la caja la usa al cobrarlo). */
    priceListId: text("price_list_id"),
    /** La venta que lo cobró. */
    documentId: text("document_id").references(() => document.id),
    /** Por qué se descartó. */
    cancelReason: text("cancel_reason"),
    handledBy: text("handled_by").references(() => user.id),
    handledAt: integer("handled_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("web_order_status").on(t.status, t.createdAt)],
)
