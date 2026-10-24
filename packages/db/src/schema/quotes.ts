import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { user } from "./access"
import { variant } from "./catalog"
import { contact } from "./contacts"
import { currency } from "./core"
import { document } from "./documents"

/** Recargo elegido en una cotización (como en la caja): el fijo puede traer su monto. */
export interface QuoteCharge {
  chargeId: string
  amount?: { amountMinor: number; currency: string } | undefined
}

/**
 * Cotización (presupuesto): lo que se le ofrece a un cliente, con el precio de cada producto
 * congelado. No mueve inventario ni dinero; al venderse queda ligada a la venta.
 */
export const quote = sqliteTable(
  "quote",
  {
    id: text("id").primaryKey(),
    /** COT-000001, una serie para todo el negocio. */
    number: text("number").notNull().unique(),
    contactId: text("contact_id").references(() => contact.id),
    status: text("status", { enum: ["open", "converted", "cancelled"] })
      .notNull()
      .default("open"),
    /** Hasta cuándo valen los precios (ms). */
    validUntil: integer("valid_until").notNull(),
    /** Descuento a toda la cotización, como en la caja: % (centésimas de punto) o un monto. */
    discountKind: text("discount_kind", { enum: ["percent", "amount"] }),
    discountValue: integer("discount_value"),
    discountCurrency: text("discount_currency").references(() => currency.code),
    /** Recargos elegidos (delivery…); null = ninguno. */
    charges: text("charges", { mode: "json" }).$type<QuoteCharge[]>(),
    /** Lo que valía al cotizar: en la moneda de referencia y en la legal, con la tasa de ese día. */
    totalRefMinor: integer("total_ref_minor"),
    totalLegalMinor: integer("total_legal_minor").notNull(),
    rateValue: text("rate_value"),
    note: text("note"),
    /** La venta en que se convirtió. */
    documentId: text("document_id").references(() => document.id),
    createdBy: text("created_by").references(() => user.id),
    createdAt: integer("created_at").notNull(),
    closedAt: integer("closed_at"),
  },
  (t) => [
    index("quote_status").on(t.status, t.createdAt),
    index("quote_contact").on(t.contactId),
    check(
      "quote_discount",
      sql`(${t.discountKind} is null and ${t.discountValue} is null)
        or (${t.discountKind} is not null and ${t.discountValue} > 0)`,
    ),
  ],
)

/** Producto cotizado, con el precio (en su moneda) y el descuento con que se ofreció. */
export const quoteLine = sqliteTable(
  "quote_line",
  {
    id: text("id").primaryKey(),
    quoteId: text("quote_id")
      .notNull()
      .references(() => quote.id),
    lineNo: integer("line_no").notNull(),
    variantId: text("variant_id")
      .notNull()
      .references(() => variant.id),
    name: text("name").notNull(),
    qtyMilli: integer("qty_milli").notNull(),
    priceMinor: integer("price_minor").notNull(),
    priceCurrency: text("price_currency")
      .notNull()
      .references(() => currency.code),
    discountKind: text("discount_kind", { enum: ["percent", "amount"] }),
    discountValue: integer("discount_value"),
    discountCurrency: text("discount_currency").references(() => currency.code),
  },
  (t) => [
    uniqueIndex("quote_line_order").on(t.quoteId, t.lineNo),
    check("quote_line_qty", sql`${t.qtyMilli} > 0 and ${t.priceMinor} >= 0`),
  ],
)
