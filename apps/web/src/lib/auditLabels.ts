import type { AuditEntry } from "@millhiore/contracts"

/** Cómo se lee cada clave de la bitácora. Las que no están aquí se muestran tal cual. */
const ACTION_LABEL: Record<string, string> = {
  "document.posted": "Registró un documento",
  "document.voided": "Anuló un documento",
  "shift.opened": "Abrió un turno",
  "shift.closed": "Cerró un turno",
  "rate.updated": "Cambió la tasa",
  "product.created": "Creó un producto",
  "product.updated": "Cambió un producto",
  "expense.category.created": "Creó una categoría de gasto",
  "expense.category.updated": "Cambió una categoría de gasto",
  "stock.reason.created": "Creó un motivo de ajuste",
  "stock.reason.updated": "Cambió un motivo de ajuste",
  "payment-method.updated": "Cambió un método de pago",
  "account.created": "Creó una cuenta",
  "account.updated": "Cambió una cuenta",
  "category.created": "Creó una categoría",
  "category.updated": "Cambió una categoría",
  "contact.created": "Creó un contacto",
  "contact.updated": "Cambió un contacto",
  "tax.updated": "Cambió un impuesto",
  "surcharge.updated": "Cambió el IGTF",
  "settings.business.updated": "Cambió los datos del negocio",
  "settings.fiscal.updated": "Cambió los ajustes fiscales",
  "settings.credit.updated": "Cambió el fiado",
  "settings.security.updated": "Cambió la seguridad",
  "user.updated": "Cambió un usuario",
  "user.password.changed": "Cambió su contraseña",
  "user.password.reset": "Restableció la contraseña de alguien",
  "user.password.reset.console": "Restableció una contraseña desde la consola",
  "user.pin.set": "Puso o cambió su PIN",
  "user.pin.removed": "Quitó su PIN",
  "session.revoked": "Cerró una sesión",
  "session.revoked.others": "Cerró sus otras sesiones",
}

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action
}

/** Los grupos del filtro: el prefijo de la clave y cómo se llama. */
export const ACTION_GROUPS: readonly { prefix: string; label: string }[] = [
  { prefix: "document.", label: "Ventas y documentos" },
  { prefix: "shift.", label: "Turnos" },
  { prefix: "rate.", label: "Tasa de cambio" },
  { prefix: "product.", label: "Productos" },
  { prefix: "contact.", label: "Contactos" },
  { prefix: "account.", label: "Cuentas" },
  { prefix: "stock.", label: "Motivos de ajuste" },
  { prefix: "payment-method.", label: "Métodos de pago" },
  { prefix: "expense.", label: "Categorías de gasto" },
  { prefix: "user.", label: "Usuarios, claves y PIN" },
  { prefix: "session.", label: "Sesiones" },
  { prefix: "settings.", label: "Ajustes" },
]

const DOCUMENT_LABEL: Record<string, string> = {
  SALE: "Venta",
  PAYMENT_IN: "Abono",
  RETURN: "Devolución",
  PURCHASE: "Compra",
  EXPENSE: "Gasto",
  PAYMENT_OUT: "Pago a proveedor",
  TRANSFER: "Transferencia",
  CASH_IN: "Ingreso de caja",
  CASH_OUT: "Retiro de caja",
  ADJUSTMENT: "Ajuste",
}

/** Sobre qué fue, en una línea corta: el número del documento, o lo poco que guarda cada acción. */
export function entryDetail(entry: AuditEntry): string | null {
  const data = entry.data
  if (data === null || typeof data !== "object") return null
  const d = data as Record<string, unknown>
  if (entry.entityType === "document" && typeof d.number === "string") {
    const kind = typeof d.type === "string" ? (DOCUMENT_LABEL[d.type] ?? d.type) : "Documento"
    return `${kind} ${d.number}`
  }
  if (entry.action === "session.revoked.others" && typeof d.count === "number") {
    return d.count === 1 ? "1 sesión" : `${d.count} sesiones`
  }
  if (entry.action === "shift.closed" && Array.isArray(d.differences) && d.differences.length > 0) {
    return "Con diferencias en la caja"
  }
  return null
}
