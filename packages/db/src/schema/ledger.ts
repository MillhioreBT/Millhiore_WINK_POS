import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { variant } from "./catalog"
import { location } from "./core"
import { document, documentLine, payment } from "./documents"
import { account } from "./finance"

// Los dos libros. Los movimientos son inmutables; los saldos son proyecciones que solo
// escribe el motor de contabilización y que deben coincidir siempre con la suma de los movimientos.

/**
 * Lote de un producto: lo que entró junto (una compra, un ajuste) con su fecha de vencimiento. El
 * código y la fecha se pueden corregir; lo que hay en cada ubicación sale de sus movimientos.
 */
export const lot = sqliteTable(
  "lot",
  {
    id: text("id").primaryKey(),
    variantId: text("variant_id")
      .notNull()
      .references(() => variant.id),
    /** Código del lote impreso en el empaque; opcional. */
    code: text("code"),
    /** Vence al terminar este día (AAAA-MM-DD); null = sin fecha. */
    expiresOn: text("expires_on"),
    /** El documento con que entró. */
    documentId: text("document_id")
      .notNull()
      .references(() => document.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("lot_variant").on(t.variantId, t.expiresOn)],
)

export const stockMove = sqliteTable(
  "stock_move",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id),
    documentLineId: text("document_line_id")
      .notNull()
      .references(() => documentLine.id),
    variantId: text("variant_id")
      .notNull()
      .references(() => variant.id),
    locationId: text("location_id")
      .notNull()
      .references(() => location.id),
    /** Con signo, en milésimas: negativo = sale del inventario. */
    qtyMilli: integer("qty_milli").notNull(),
    /** Lote de un producto con lotes; null = sin lote. */
    lotId: text("lot_id").references(() => lot.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check("stock_move_qty_nonzero", sql`${t.qtyMilli} <> 0`),
    index("stock_move_item").on(t.variantId, t.locationId),
    index("stock_move_document").on(t.documentId),
    index("stock_move_lot").on(t.lotId),
  ],
)

export const stockBalance = sqliteTable(
  "stock_balance",
  {
    variantId: text("variant_id")
      .notNull()
      .references(() => variant.id),
    locationId: text("location_id")
      .notNull()
      .references(() => location.id),
    qtyMilli: integer("qty_milli").notNull(),
  },
  (t) => [primaryKey({ columns: [t.variantId, t.locationId] })],
)

/** Lo que hay de cada lote en cada ubicación: Σ de sus movimientos, como `stock_balance`. */
export const lotBalance = sqliteTable(
  "lot_balance",
  {
    lotId: text("lot_id")
      .notNull()
      .references(() => lot.id),
    locationId: text("location_id")
      .notNull()
      .references(() => location.id),
    qtyMilli: integer("qty_milli").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.lotId, t.locationId] }),
    index("lot_balance_location").on(t.locationId),
  ],
)

export const accountMove = sqliteTable(
  "account_move",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id),
    paymentId: text("payment_id")
      .notNull()
      .references(() => payment.id),
    accountId: text("account_id")
      .notNull()
      .references(() => account.id),
    /** Con signo, en unidades menores de la moneda de la cuenta: negativo = sale dinero. */
    amountMinor: integer("amount_minor").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check("account_move_amount_nonzero", sql`${t.amountMinor} <> 0`),
    index("account_move_account").on(t.accountId),
    index("account_move_document").on(t.documentId),
  ],
)

export const accountBalance = sqliteTable("account_balance", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => account.id),
  amountMinor: integer("amount_minor").notNull(),
})
