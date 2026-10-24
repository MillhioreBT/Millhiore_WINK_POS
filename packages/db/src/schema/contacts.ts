import { sql } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { priceList } from "./catalog"

/**
 * Clientes y proveedores. `taxId` es la cédula o el RIF tal como se imprime en la factura
 * (V-12345678, J-12345678-9); es único cuando existe.
 */
export const contact = sqliteTable(
  "contact",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["customer", "supplier", "both"] }).notNull(),
    name: text("name").notNull(),
    taxId: text("tax_id"),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    notes: text("notes"),
    /** Plazo que se le da para pagar lo fiado; 0 = sin plazo (siempre exigible). */
    creditDays: integer("credit_days").notNull().default(0),
    /** Tope de lo que puede deber, en la moneda de referencia del negocio; null = sin tope. */
    creditLimitMinor: integer("credit_limit_minor"),
    /** Lista de precios con que compra; null = los precios base. */
    priceListId: text("price_list_id").references(() => priceList.id),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("contact_tax_id").on(t.taxId).where(sql`${t.taxId} is not null`),
    index("contact_name").on(t.name),
  ],
)
