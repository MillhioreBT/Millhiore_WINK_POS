import type { DocumentType } from "./document"

/** Permisos granulares. Siempre se verifican en el servidor, nunca solo en la interfaz. */
export const PERMISSIONS = [
  "sale.create",
  "sale.discount",
  "sale.void",
  "sale.credit",
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

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value)
}

export interface RoleTemplate {
  id: string
  name: string
  permissions: readonly Permission[]
}

/** Los cuatro roles que trae cada instalación. Se pueden editar y crear más. */
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
      "payment.receive",
      "inventory.view",
      "shift.manage",
    ],
  },
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
}

/** Permiso que exige contabilizar un documento de este tipo. */
export function permissionToPost(type: DocumentType): Permission | undefined {
  return POST_PERMISSION[type]
}

/** Permiso que exige anular un documento de este tipo. */
export function permissionToVoid(type: DocumentType): Permission | undefined {
  return VOID_PERMISSION[type]
}
