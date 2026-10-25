import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const currency = sqliteTable(
  "currency",
  {
    code: text("code").primaryKey(),
    name: text("name").notNull(),
    symbol: text("symbol").notNull(),
    /** Cifras decimales de la unidad menor (2 → céntimos). */
    decimals: integer("decimals").notNull(),
  },
  (t) => [check("currency_decimals_range", sql`${t.decimals} between 0 and 8`)],
)

export const business = sqliteTable("business", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Moneda de referencia de precios y costos (normalmente USD). */
  referenceCurrency: text("reference_currency")
    .notNull()
    .references(() => currency.code),
  /** Moneda legal (VES). */
  legalCurrency: text("legal_currency")
    .notNull()
    .references(() => currency.code),
  timezone: text("timezone").notNull().default("America/Caracas"),
  createdAt: integer("created_at").notNull(),
})

/**
 * Sucursal: un local del negocio con sus ubicaciones (tienda, depósito, cocina) y sus cajas.
 * Todas comparten el catálogo, los clientes y las cuentas; cada una tiene su inventario, sus
 * turnos y sus informes, y sus datos salen en el recibo de lo que se vende allí. La primera,
 * `main`, existe siempre (con una sola, no se nota).
 */
export const branch = sqliteTable("branch", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  /** Para el recibo; vacíos, los del negocio. */
  address: text("address"),
  phone: text("phone"),
  /** Lista de precios con que vende (vacío: el precio base). */
  priceListId: text("price_list_id"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
})

export const location = sqliteTable("location", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => business.id),
  /** Siempre lleno (las anteriores a las sucursales quedaron en `main`). */
  branchId: text("branch_id").references(() => branch.id),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["store", "warehouse", "kitchen"] }).notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
})

export const terminal = sqliteTable("terminal", {
  id: text("id").primaryKey(),
  locationId: text("location_id")
    .notNull()
    .references(() => location.id),
  /** Prefijo de la serie de documentos, p. ej. "C1" → C1-000123. */
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
})

export const setting = sqliteTable("setting", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull().$type<unknown>(),
})

export const exchangeRate = sqliteTable(
  "exchange_rate",
  {
    id: text("id").primaryKey(),
    /** 1 `base` = `value` `quote`. */
    base: text("base")
      .notNull()
      .references(() => currency.code),
    quote: text("quote")
      .notNull()
      .references(() => currency.code),
    /** Decimal de 8 cifras en texto. */
    value: text("value").notNull(),
    source: text("source", { enum: ["bcv", "dolarapi", "manual"] }).notNull(),
    effectiveAt: integer("effective_at").notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check("exchange_rate_distinct", sql`${t.base} <> ${t.quote}`),
    index("exchange_rate_lookup").on(t.base, t.quote, t.effectiveAt),
    uniqueIndex("exchange_rate_dedupe").on(t.base, t.quote, t.effectiveAt, t.source),
  ],
)
