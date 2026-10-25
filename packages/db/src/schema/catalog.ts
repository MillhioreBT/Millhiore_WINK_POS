import { type ProductOption, TAX_KINDS } from "@millhiore/domain"
import { sql } from "drizzle-orm"
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
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
    /**
     * Lleva lotes con fecha de vencimiento (perecederos): cada entrada crea un lote y las salidas
     * se reparten solas, primero el que vence antes. Solo en productos con existencia.
     */
    tracksLots: integer("tracks_lots", { mode: "boolean" }).notNull().default(false),
    /** IVA del producto; null = el impuesto por defecto del negocio. */
    taxId: text("tax_id").references(() => tax.id),
    /** Categoría del producto; null = sin categoría. */
    categoryId: text("category_id").references(() => category.id),
    /**
     * Tallas, colores u otras características (hasta tres) con sus valores en orden; null = se
     * vende de una sola forma. Cada combinación es una variante con su código y su existencia.
     */
    options: text("options", { mode: "json" }).$type<ProductOption[]>(),
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
    /** El del producto con los valores de la combinación: «Camisa (M, Azul)». */
    name: text("name").notNull(),
    /** Un valor por cada característica del producto, en su orden; null si no tiene. */
    optionValues: text("option_values", { mode: "json" }).$type<string[]>(),
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

/**
 * Lista de precios (al mayor, para revendedores…). Un producto puede tener precio propio en la
 * lista; si no lo tiene, vale su precio base con el ajuste de la lista (`adjustBp`).
 */
export const priceList = sqliteTable(
  "price_list",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    /** % sobre el precio base, en centésimas de punto: −1000 = 10 % menos. */
    adjustBp: integer("adjust_bp").notNull().default(0),
    position: integer("position").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [check("price_list_adjust_range", sql`${t.adjustBp} between -9900 and 1000000`)],
)

/** Precio propio de un producto en una lista, en la moneda en que se fijó. */
export const priceListPrice = sqliteTable(
  "price_list_price",
  {
    priceListId: text("price_list_id")
      .notNull()
      .references(() => priceList.id),
    variantId: text("variant_id")
      .notNull()
      .references(() => variant.id),
    priceMinor: integer("price_minor").notNull(),
    priceCurrency: text("price_currency")
      .notNull()
      .references(() => currency.code),
  },
  (t) => [
    primaryKey({ columns: [t.priceListId, t.variantId] }),
    check("price_list_price_nonneg", sql`${t.priceMinor} >= 0`),
  ],
)

/**
 * Recargo de venta (delivery, servicio, empaque…): se suma a la venta aparte de los productos. Uno
 * fijo vale un monto (como el precio de un producto: con el IVA incluido si los precios lo
 * incluyen); uno porcentual se calcula sobre el subtotal sin IVA de los productos. Lleva el IVA que
 * se le asigne o ninguno (no sujeto). Con `auto` se agrega solo a cada venta.
 */
export const saleCharge = sqliteTable(
  "sale_charge",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    kind: text("kind", { enum: ["percent", "fixed"] }).notNull(),
    /** Porcentual: centésimas de punto (1000 = 10 %). */
    rateBp: integer("rate_bp").notNull().default(0),
    /** Fijo: monto sugerido en `currency` (se puede cambiar en cada venta). */
    amountMinor: integer("amount_minor").notNull().default(0),
    currency: text("currency").references(() => currency.code),
    /** IVA del recargo; null = no lleva IVA. */
    taxId: text("tax_id").references(() => tax.id),
    auto: integer("auto", { mode: "boolean" }).notNull().default(false),
    position: integer("position").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [
    check(
      "sale_charge_kind",
      sql`(${t.kind} = 'percent' and ${t.rateBp} between 1 and 10000)
        or (${t.kind} = 'fixed' and ${t.amountMinor} >= 0 and ${t.currency} is not null)`,
    ),
  ],
)

/**
 * Código de descuento que el cliente dice en la caja (PROMO10): un porcentaje o un monto sobre
 * toda la venta, con vigencia y usos máximos opcionales. Uno por venta. Lo aplica cualquier
 * cajero, aunque no pueda dar descuentos a mano.
 */
export const discountCode = sqliteTable(
  "discount_code",
  {
    id: text("id").primaryKey(),
    /** En mayúsculas, sin espacios. */
    code: text("code").notNull().unique(),
    kind: text("kind", { enum: ["percent", "amount"] }).notNull(),
    /** Porcentaje: centésimas de punto (1000 = 10 %). */
    rateBp: integer("rate_bp").notNull().default(0),
    /** Monto fijo, en `currency`. */
    amountMinor: integer("amount_minor").notNull().default(0),
    currency: text("currency").references(() => currency.code),
    /** Cuántas ventas pueden usarlo; null = sin límite. */
    maxUses: integer("max_uses"),
    /** Desde y hasta qué día vale (AAAA-MM-DD, incluidos); null = sin límite. */
    validFrom: text("valid_from"),
    validUntil: text("valid_until"),
    note: text("note"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check(
      "discount_code_value",
      sql`(${t.kind} = 'percent' and ${t.rateBp} between 1 and 10000)
        or (${t.kind} = 'amount' and ${t.amountMinor} > 0 and ${t.currency} is not null)`,
    ),
  ],
)

/**
 * Opciones y extras que se eligen al vender un producto: «Término» (una sola, obligatoria),
 * «Extras» (varios, con su precio). Un grupo sirve para varios productos.
 */
export const modifierGroup = sqliteTable(
  "modifier_group",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Cuántas hay que elegir como mínimo (1 = obligatoria). */
    minSelect: integer("min_select").notNull().default(0),
    /** Cuántas se pueden elegir como máximo; null = todas. */
    maxSelect: integer("max_select"),
    position: integer("position").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check(
      "modifier_group_select",
      sql`${t.minSelect} >= 0 and (${t.maxSelect} is null or ${t.maxSelect} >= max(${t.minSelect}, 1))`,
    ),
  ],
)

export const modifier = sqliteTable(
  "modifier",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => modifierGroup.id),
    name: text("name").notNull(),
    /** Lo que suma al precio del producto, en `priceCurrency`; 0 = no cambia el precio. */
    priceMinor: integer("price_minor").notNull().default(0),
    priceCurrency: text("price_currency").references(() => currency.code),
    position: integer("position").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [
    check(
      "modifier_price",
      sql`${t.priceMinor} >= 0 and (${t.priceMinor} = 0 or ${t.priceCurrency} is not null)`,
    ),
  ],
)

/** Qué grupos de opciones se ofrecen con cada producto, en su orden. */
export const productModifierGroup = sqliteTable(
  "product_modifier_group",
  {
    productId: text("product_id")
      .notNull()
      .references(() => product.id),
    groupId: text("group_id")
      .notNull()
      .references(() => modifierGroup.id),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.productId, t.groupId] })],
)

/** Una opción elegida, congelada en la línea con el nombre y el precio que tenía. */
export interface PickedModifier {
  id: string
  name: string
  priceMinor: number
  priceCurrency: string | null
}

/**
 * Receta de un producto: cuánto de cada ingrediente (un producto con existencia) lleva una
 * unidad, más la merma. Si el producto no lleva existencia (un plato), sus ingredientes se
 * descuentan al venderlo; si la lleva, la receta sirve para producirlo por tandas.
 */
export const recipeItem = sqliteTable(
  "recipe_item",
  {
    productId: text("product_id")
      .notNull()
      .references(() => product.id),
    ingredientId: text("ingredient_id")
      .notNull()
      .references(() => variant.id),
    /** Por cada unidad del producto, en milésimas del ingrediente (150 = 0,150 kg). */
    qtyMilli: integer("qty_milli").notNull(),
    /** Merma en centésimas de punto: 1000 = se pierde un 10 % más al prepararlo. */
    wasteBp: integer("waste_bp").notNull().default(0),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.ingredientId] }),
    check("recipe_item_qty", sql`${t.qtyMilli} > 0 and ${t.wasteBp} between 0 and 10000`),
  ],
)
