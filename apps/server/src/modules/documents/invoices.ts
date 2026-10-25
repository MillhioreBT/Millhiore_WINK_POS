import type { RecordInvoiceBody } from "@millhiore/contracts"
import { auditLog, contact, type Db, document, fiscalInvoice } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { and, eq, ne } from "drizzle-orm"
import type { Actor } from "../../http/actor"
import { HttpError } from "../../http/errors"
import { requireLocalServer } from "../../posting/post"
import { locationsIn } from "../branches/service"

/**
 * Anota los números de la factura que emitió el medio autorizado (máquina fiscal, forma libre o,
 * desde 2027, el medio digital) para una venta. Anotarlos pide poder vender; cambiarlos después,
 * poder anular ventas. Queda en la bitácora.
 */
export function recordInvoice(
  db: Db,
  id: string,
  body: RecordInvoiceBody,
  actor: Actor,
  now: number,
): void {
  db.transaction(
    (tx) => {
      const doc = tx.select().from(document).where(eq(document.id, id)).get()
      if (!doc) throw new HttpError(404, "NOT_FOUND", `No existe el documento ${id}`)
      if (doc.type !== "SALE" || doc.reversesDocumentId) {
        throw new HttpError(409, "NOT_INVOICEABLE", "Solo una venta lleva factura")
      }
      const here = locationsIn(tx, actor.branchIds)
      if (here && !here.has(doc.locationId)) {
        throw new HttpError(403, "OTHER_BRANCH", "Es de una sucursal donde no trabajas")
      }
      requireLocalServer(tx, [doc.locationId])
      const reversed = tx
        .select({ id: document.id })
        .from(document)
        .where(eq(document.reversesDocumentId, id))
        .get()
      if (reversed)
        throw new HttpError(409, "NOT_INVOICEABLE", `La venta ${doc.number} está anulada`)
      // Una venta sin «con factura» también se puede facturar si tiene la cédula o el RIF (las de
      // antes de guardar los datos del cliente, los de su contacto).
      const taxId = doc.customerName
        ? doc.customerTaxId
        : doc.contactId
          ? tx
              .select({ taxId: contact.taxId })
              .from(contact)
              .where(eq(contact.id, doc.contactId))
              .get()?.taxId
          : null
      if (!doc.invoiceRequested && !taxId) {
        throw new HttpError(
          409,
          "CUSTOMER_REQUIRED",
          `La venta ${doc.number} no tiene la cédula o el RIF del cliente: no se le puede anotar factura`,
        )
      }
      const before = tx.select().from(fiscalInvoice).where(eq(fiscalInvoice.documentId, id)).get()
      if (before && !actor.permissions.has("sale.void")) {
        throw new HttpError(
          403,
          "FORBIDDEN",
          "Cambiar los números de una factura ya anotada pide poder anular ventas",
        )
      }
      const taken = tx
        .select({ number: document.number })
        .from(fiscalInvoice)
        .innerJoin(document, eq(document.id, fiscalInvoice.documentId))
        .where(
          and(
            eq(fiscalInvoice.controlNumber, body.controlNumber),
            ne(fiscalInvoice.documentId, id),
          ),
        )
        .get()
      if (taken) {
        throw new HttpError(
          409,
          "CONTROL_TAKEN",
          `El número de control ${body.controlNumber} ya está en la venta ${taken.number}`,
        )
      }
      const row = {
        invoiceNumber: body.invoiceNumber,
        controlNumber: body.controlNumber,
        source: "manual" as const,
        recordedAt: now,
        recordedBy: actor.userId,
      }
      tx.insert(fiscalInvoice)
        .values({ documentId: id, ...row })
        .onConflictDoUpdate({ target: fiscalInvoice.documentId, set: row })
        .run()
      tx.insert(auditLog)
        .values({
          id: uuidv7(now),
          at: now,
          actorId: actor.userId,
          action: before ? "document.invoice.changed" : "document.invoice.recorded",
          entityType: "document",
          entityId: id,
          data: {
            number: doc.number,
            before: before
              ? { invoiceNumber: before.invoiceNumber, controlNumber: before.controlNumber }
              : null,
            after: { invoiceNumber: body.invoiceNumber, controlNumber: body.controlNumber },
          },
        })
        .run()
    },
    { behavior: "immediate" },
  )
}
