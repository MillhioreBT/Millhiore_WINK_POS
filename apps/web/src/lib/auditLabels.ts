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
  "product.prices.bulk": "Cambió precios en lote",
  "price-list.created": "Creó una lista de precios",
  "price-list.updated": "Cambió una lista de precios",
  "charge.created": "Creó un recargo de venta",
  "charge.updated": "Cambió un recargo de venta",
  "quote.created": "Hizo una cotización",
  "quote.cancelled": "Anuló una cotización",
  "expense.category.created": "Creó una categoría de gasto",
  "expense.category.updated": "Cambió una categoría de gasto",
  "stock.reason.created": "Creó un motivo de ajuste",
  "stock.reason.updated": "Cambió un motivo de ajuste",
  "payment-method.updated": "Cambió un método de pago",
  "account.created": "Creó una cuenta",
  "account.updated": "Cambió una cuenta",
  "lot.updated": "Corrigió un lote",
  "discount-code.created": "Creó un código de descuento",
  "discount-code.updated": "Cambió un código de descuento",
  "settings.lots.updated": "Cambió los días de aviso de vencimiento",
  "location.created": "Creó una ubicación",
  "location.updated": "Cambió una ubicación",
  "terminal.created": "Creó una caja",
  "terminal.updated": "Cambió una caja",
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
  { prefix: "price-list.", label: "Listas de precios" },
  { prefix: "charge.", label: "Recargos de venta" },
  { prefix: "quote.", label: "Cotizaciones" },
  { prefix: "contact.", label: "Contactos" },
  { prefix: "account.", label: "Cuentas" },
  { prefix: "stock.", label: "Motivos de ajuste" },
  { prefix: "lot.", label: "Lotes" },
  { prefix: "discount-code.", label: "Códigos de descuento" },
  { prefix: "location.", label: "Ubicaciones" },
  { prefix: "terminal.", label: "Cajas" },
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
  DEBT_IN: "Deuda de cliente",
  DEBT_OUT: "Deuda con proveedor",
  STOCK_TRANSFER: "Traslado",
  PURCHASE_RETURN: "Devolución a proveedor",
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
  if (entry.entityType === "quote" && typeof d.number === "string") return `Cotización ${d.number}`
  if (entry.entityType === "location" || entry.entityType === "terminal") {
    const row = (d.after ?? d) as Record<string, unknown>
    if (typeof row.name === "string") return row.name
  }
  if (entry.action === "product.prices.bulk" && typeof d.count === "number") {
    return d.count === 1 ? "1 producto" : `${d.count} productos`
  }
  if (entry.action === "session.revoked.others" && typeof d.count === "number") {
    return d.count === 1 ? "1 sesión" : `${d.count} sesiones`
  }
  if (entry.action === "shift.closed" && Array.isArray(d.differences) && d.differences.length > 0) {
    return "Con diferencias en la caja"
  }
  return null
}
