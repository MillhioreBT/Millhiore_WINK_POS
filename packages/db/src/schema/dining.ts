import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { user } from "./access"
import { type PickedModifier, variant } from "./catalog"
import { currency } from "./core"
import { document } from "./documents"

/** Sala del restaurante: el salón, la terraza, la barra. */
export const diningArea = sqliteTable("dining_area", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
})

export const diningTable = sqliteTable(
  "dining_table",
  {
    id: text("id").primaryKey(),
    areaId: text("area_id")
      .notNull()
      .references(() => diningArea.id),
    name: text("name").notNull(),
    /** Puestos (para saber dónde sentar a un grupo); null = no se anotó. */
    seats: integer("seats"),
    position: integer("position").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("dining_table_area").on(t.areaId, t.position)],
)

/**
 * Cuenta abierta: lo que va consumiendo una mesa (o un cliente en la barra o para llevar) hasta
 * que paga. No mueve inventario ni dinero; al cobrarla, cada venta deja pagados sus productos.
 */
export const tab = sqliteTable(
  "tab",
  {
    /** UUIDv7 generado por quien la abre: reintentar no abre otra. */
    id: text("id").primaryKey(),
    /** CTA-000001, una serie para todo el negocio. */
    number: text("number").notNull().unique(),
    /** La mesa; null = sin mesa (barra, para llevar), con `label`. */
    tableId: text("table_id").references(() => diningTable.id),
    /** Nombre de una cuenta sin mesa («Juan», «Para llevar»). */
    label: text("label"),
    guests: integer("guests"),
    status: text("status", { enum: ["open", "closed", "cancelled"] })
      .notNull()
      .default("open"),
    /** Quien atiende la mesa (el mesonero); al abrirla, quien la abrió. */
    waiterId: text("waiter_id").references(() => user.id),
    note: text("note"),
    openedBy: text("opened_by").references(() => user.id),
    openedAt: integer("opened_at").notNull(),
    closedAt: integer("closed_at"),
    /** Por qué se cerró sin cobrar (anulada). */
    cancelReason: text("cancel_reason"),
  },
  (t) => [
    // Una mesa tiene a lo sumo una cuenta abierta.
    uniqueIndex("tab_open_table")
      .on(t.tableId)
      .where(sql`${t.status} = 'open' and ${t.tableId} is not null`),
    index("tab_status").on(t.status, t.openedAt),
  ],
)

/**
 * Lo que se pidió en una cuenta, con el precio del momento (en su moneda). Una vez guardado no se
 * edita: se anula (con motivo) o se paga; pagar o anular una parte divide la línea.
 */
export const tabLine = sqliteTable(
  "tab_line",
  {
    /** UUIDv7 generado por quien lo pide: reenviar el pedido no lo duplica. */
    id: text("id").primaryKey(),
    tabId: text("tab_id")
      .notNull()
      .references(() => tab.id),
    variantId: text("variant_id")
      .notNull()
      .references(() => variant.id),
    name: text("name").notNull(),
    qtyMilli: integer("qty_milli").notNull(),
    priceMinor: integer("price_minor").notNull(),
    priceCurrency: text("price_currency")
      .notNull()
      .references(() => currency.code),
    /** Indicaciones para la cocina («sin cebolla», «bien cocido»). */
    note: text("note"),
    /** Opciones y extras elegidos, con el precio que suman (aparte de `priceMinor`). */
    modifiers: text("modifiers", { mode: "json" }).$type<PickedModifier[]>(),
    addedBy: text("added_by").references(() => user.id),
    addedAt: integer("added_at").notNull(),
    /** Anulado después de pedirlo (se equivocaron, el cliente no lo quiso). */
    voidedAt: integer("voided_at"),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
    /** La venta que lo cobró. */
    documentId: text("document_id").references(() => document.id),
  },
  (t) => [
    index("tab_line_tab").on(t.tabId, t.addedAt),
    index("tab_line_document").on(t.documentId),
    check("tab_line_qty", sql`${t.qtyMilli} > 0 and ${t.priceMinor} >= 0`),
  ],
)
