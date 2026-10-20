import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { variant } from "./catalog"
import { location } from "./core"
import { document, documentLine, payment } from "./documents"
import { account } from "./finance"

// Los dos libros. Los movimientos son inmutables; los saldos son proyecciones que solo
// escribe el motor de contabilización y que deben coincidir siempre con la suma de los movimientos.

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
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check("stock_move_qty_nonzero", sql`${t.qtyMilli} <> 0`),
    index("stock_move_item").on(t.variantId, t.locationId),
    index("stock_move_document").on(t.documentId),
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
