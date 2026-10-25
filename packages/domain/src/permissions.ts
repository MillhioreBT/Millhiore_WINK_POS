import type { DocumentType } from "./document"

/** Permisos granulares. Siempre se verifican en el servidor, nunca solo en la interfaz. */
export const PERMISSIONS = [
  "sale.create",
  "sale.discount",
  "sale.void",
  "sale.credit",
  /** Abrir cuentas en las mesas, pedir y moverlas (cobrarlas es vender). */
  "table.serve",
  /** Ver la pantalla de cocina y marcar lo que está listo. */
  "kitchen.view",
  "payment.receive",
  "purchase.create",
  "purchase.void",
  "inventory.view",
  "inventory.adjust",
  "catalog.manage",
  "cost.view",
  "contact.manage",
  "shift.manage",
  "finance.view",
  "finance.manage",
  "expense.create",
  "payable.manage",
  "rate.manage",
  "report.view",
  "audit.view",
  "settings.manage",
  "user.manage",
] as const
export type Permission = (typeof PERMISSIONS)[number]

/**
 * Lo que se le puede dar a una clave de la API: todo menos manejar usuarios y ajustes (una clave
 * no crea usuarios, ni otras claves, ni cambia cómo funciona el negocio).
 */
export const API_KEY_PERMISSIONS = PERMISSIONS.filter(
  (p) => p !== "user.manage" && p !== "settings.manage",
)

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value)
}

export interface RoleTemplate {
  id: string
  name: string
  permissions: readonly Permission[]
}

/** Los roles que trae cada instalación. Se pueden editar y crear más. */
export const DEFAULT_ROLES: readonly RoleTemplate[] = [
  { id: "owner", name: "Dueño", permissions: PERMISSIONS },
  {
    id: "manager",
    name: "Administrador",
    permissions: PERMISSIONS.filter((p) => p !== "user.manage" && p !== "settings.manage"),
  },
  {
    id: "cashier",
    name: "Cajero",
    permissions: [
      "sale.create",
      "sale.credit",
      "table.serve",
      "payment.receive",
      "inventory.view",
      "shift.manage",
    ],
  },
  // Toma los pedidos de las mesas; cobra el cajero.
  { id: "waiter", name: "Mesonero", permissions: ["table.serve"] },
  // Ve las comandas en la pantalla de cocina y marca lo que está listo.
  { id: "kitchen", name: "Cocina", permissions: ["kitchen.view"] },
  {
    id: "warehouse",
    name: "Almacenista",
    permissions: ["purchase.create", "inventory.view", "inventory.adjust", "catalog.manage"],
  },
]

const POST_PERMISSION: Partial<Record<DocumentType, Permission>> = {
  SALE: "sale.create",
  PAYMENT_IN: "payment.receive",
  RETURN: "sale.void",
  EXPENSE: "expense.create",
  PAYMENT_OUT: "payable.manage",
  TRANSFER: "finance.manage",
  PURCHASE: "purchase.create",
  ADJUSTMENT: "inventory.adjust",
  CASH_IN: "shift.manage",
  CASH_OUT: "shift.manage",
  DEBT_IN: "finance.manage",
  DEBT_OUT: "payable.manage",
  STOCK_TRANSFER: "inventory.adjust",
  PURCHASE_RETURN: "purchase.void",
  PRODUCTION: "inventory.adjust",
}

const VOID_PERMISSION: Partial<Record<DocumentType, Permission>> = {
  SALE: "sale.void",
  PAYMENT_IN: "sale.void",
  RETURN: "sale.void",
  EXPENSE: "finance.manage",
  PAYMENT_OUT: "payable.manage",
  TRANSFER: "finance.manage",
  PURCHASE: "purchase.void",
  ADJUSTMENT: "inventory.adjust",
  CASH_IN: "finance.manage",
  CASH_OUT: "finance.manage",
  DEBT_IN: "finance.manage",
  DEBT_OUT: "payable.manage",
  STOCK_TRANSFER: "inventory.adjust",
  PURCHASE_RETURN: "purchase.void",
  PRODUCTION: "inventory.adjust",
}

/** Permiso que exige contabilizar un documento de este tipo. */
export function permissionToPost(type: DocumentType): Permission | undefined {
  return POST_PERMISSION[type]
}

/** Permiso que exige anular un documento de este tipo. */
export function permissionToVoid(type: DocumentType): Permission | undefined {
  return VOID_PERMISSION[type]
}
