import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { user } from "./access"
import { document } from "./documents"

/**
 * La factura de una venta, emitida por el medio autorizado: su número y su número de control (los
 * asigna la imprenta, la máquina fiscal o el medio digital, nunca este sistema). Aparte del
 * documento, que no cambia: se anota después de emitirla.
 */
export const fiscalInvoice = sqliteTable("fiscal_invoice", {
  documentId: text("document_id")
    .primaryKey()
    .references(() => document.id),
  invoiceNumber: text("invoice_number").notNull(),
  controlNumber: text("control_number").notNull().unique(),
  /** `manual`: anotada a mano (máquina fiscal o forma libre). Más adelante, el medio digital. */
  source: text("source", { enum: ["manual"] })
    .notNull()
    .default("manual"),
  recordedAt: integer("recorded_at").notNull(),
  recordedBy: text("recorded_by").references(() => user.id),
})
