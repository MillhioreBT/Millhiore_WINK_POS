import { TAX_KINDS } from "@millhiore/domain"
import { sql } from "drizzle-orm"
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { currency } from "./core"

/**
 * Alícuotas de IVA (general, reducida, general + adicional de lujo, exento…). Son datos, no
 * código: si la ley cambia la alícuota se edita aquí, y los documentos ya emitidos conservan la
 * que tenían al contabilizarse.
 */
export const tax = sqliteTable(
  "tax",
  {
    id: text("id").primaryKey(),
    /** Letra con la que se imprime en la factura y en la impresora fiscal (G, R, A, E). */
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    kind: text("kind", { enum: TAX_KINDS }).notNull(),
    /** Centésimas de punto porcentual: 1600 = 16 %. */
    rateBp: integer("rate_bp").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [
    check(
      "tax_rate_matches_kind",
      sql`${t.rateBp} between 0 and 10000 and ((${t.kind} = 'taxed') = (${t.rateBp} > 0))`,
    ),
  ],
)

/** Agrupa los productos para encontrarlos rápido en la caja (bebidas, víveres, charcutería…). */
export const category = sqliteTable("category", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  /** Orden en que se muestran; a igual posición, por nombre. */
  position: integer("position").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
})

export const product = sqliteTable(
  "product",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["good", "service"] }).notNull(),
    /** Los servicios no mueven existencias. */
    tracksStock: integer("tracks_stock", { mode: "boolean" }).notNull(),
    /** IVA del producto; null = el impuesto por defecto del negocio. */
    taxId: text("tax_id").references(() => tax.id),
    /** Categoría del producto; null = sin categoría. */
    categoryId: text("category_id").references(() => category.id),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [check("product_service_no_stock", sql`${t.kind} = 'good' or ${t.tracksStock} = 0`)],
)

/**
 * Por qué cambia la existencia sin una compra ni una venta: merma, vencido, uso interno, sobrante
 * o faltante de un conteo… Cada comercio edita la suya. Una razón de «salida» solo admite
 * cantidades negativas y una de «entrada», positivas.
 */
export const stockReason = sqliteTable("stock_reason", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  direction: text("direction", { enum: ["in", "out"] }).notNull(),
  /** Orden en que se muestran; a igual posición, por nombre. */
  position: integer("position").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
})

export const variant = sqliteTable(
  "variant",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => product.id),
    sku: text("sku").notNull().unique(),
    barcode: text("barcode").unique(),
    name: text("name").notNull(),
    priceMinor: integer("price_minor").notNull(),
    priceCurrency: text("price_currency")
      .notNull()
      .references(() => currency.code),
    /** Último costo de compra (sin IVA si el negocio lo acredita), en `costCurrency`. */
    costMinor: integer("cost_minor"),
    costCurrency: text("cost_currency").references(() => currency.code),
    /** Existencia mínima en milésimas: por debajo se avisa para reponer. null = sin aviso. */
    minStockMilli: integer("min_stock_milli"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check("variant_price_nonneg", sql`${t.priceMinor} >= 0`),
    check("variant_min_stock_nonneg", sql`${t.minStockMilli} is null or ${t.minStockMilli} >= 0`),
  ],
)
