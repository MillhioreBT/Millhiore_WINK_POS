import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { user } from "./access"
import type { PickedModifier } from "./catalog"
import { tab, tabLine } from "./dining"
import { document } from "./documents"

/** La impresora de una estación (la de la cocina, la de la barra), sin pasar por el navegador. */
export interface StationPrinter {
  mode: "network" | "windows" | "device"
  host: string | null
  port: number
  share: string | null
  device: string | null
  paperWidth: 58 | 80
}

/**
 * Donde se prepara lo que se pide: la cocina, la barra, la parrilla. Cada una recibe los productos
 * de sus categorías (o, si no tiene ninguna, todo lo que no va a otra) en su impresora o en la
 * pantalla de cocina.
 */
export const kitchenStation = sqliteTable("kitchen_station", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Categorías que prepara; null = todo lo que no va a otra estación. */
  categoryIds: text("category_ids", { mode: "json" }).$type<string[]>(),
  /** null = solo la pantalla de cocina. */
  printer: text("printer", { mode: "json" }).$type<StationPrinter>(),
  /** También recibe lo vendido directo en la caja (no solo lo de las mesas). */
  counterSales: integer("counter_sales", { mode: "boolean" }).notNull().default(true),
  /** Minutos en que debería estar listo: pasado ese tiempo la pantalla lo resalta. */
  targetMinutes: integer("target_minutes").notNull().default(15),
  position: integer("position").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
})

/** Una comanda: lo que una estación tiene que preparar (o dejar de preparar) de un pedido. */
export const kitchenTicket = sqliteTable(
  "kitchen_ticket",
  {
    id: text("id").primaryKey(),
    /** Número del día (vuelve a 1 cada día). */
    number: integer("number").notNull(),
    stationId: text("station_id")
      .notNull()
      .references(() => kitchenStation.id),
    /** «order»: preparar; «void»: se anuló, dejar de preparar. */
    kind: text("kind", { enum: ["order", "void"] }).notNull(),
    /** Para quién es: «Mesa 4», «Juan (barra)», «Venta C1-000123». */
    source: text("source").notNull(),
    tabId: text("tab_id").references(() => tab.id),
    documentId: text("document_id").references(() => document.id),
    status: text("status", { enum: ["pending", "ready"] })
      .notNull()
      .default("pending"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: integer("created_at").notNull(),
    readyAt: integer("ready_at"),
    readyBy: text("ready_by").references(() => user.id),
    /** Cuándo se mandó a la impresora de la estación (null = no tiene, o aún no). */
    printedAt: integer("printed_at"),
    /** Por qué no se imprimió (la pantalla lo muestra para reimprimir). */
    printError: text("print_error"),
  },
  (t) => [
    index("kitchen_ticket_station").on(t.stationId, t.status, t.createdAt),
    index("kitchen_ticket_tab").on(t.tabId),
  ],
)

export const kitchenTicketLine = sqliteTable(
  "kitchen_ticket_line",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => kitchenTicket.id),
    /** Lo pedido en la cuenta de una mesa (null en las ventas de la caja). */
    tabLineId: text("tab_line_id").references(() => tabLine.id),
    name: text("name").notNull(),
    qtyMilli: integer("qty_milli").notNull(),
    modifiers: text("modifiers", { mode: "json" }).$type<PickedModifier[]>(),
    note: text("note"),
  },
  (t) => [
    index("kitchen_ticket_line_ticket").on(t.ticketId),
    index("kitchen_ticket_line_tab").on(t.tabLineId),
  ],
)
