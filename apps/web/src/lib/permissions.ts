import type { Permission } from "@millhiore/domain"

/** Qué deja hacer cada permiso, dicho como en el negocio. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  "sale.create": "Vender",
  "sale.discount": "Dar descuentos",
  "sale.void": "Anular ventas y hacer devoluciones",
  "sale.credit": "Vender fiado",
  "table.serve": "Atender mesas",
  "kitchen.view": "Ver la pantalla de cocina",
  "payment.receive": "Cobrar abonos",
  "purchase.create": "Registrar compras",
  "purchase.void": "Anular compras y devolver a proveedores",
  "inventory.view": "Ver productos y existencias",
  "inventory.adjust": "Ajustar existencias, trasladar y producir",
  "catalog.manage": "Crear y editar productos",
  "cost.view": "Ver costos y utilidad",
  "contact.manage": "Crear y editar clientes y proveedores",
  "shift.manage": "Abrir y cerrar turnos",
  "finance.view": "Ver cuentas y saldos",
  "finance.manage": "Manejar cuentas y transferencias",
  "expense.create": "Registrar gastos",
  "payable.manage": "Pagar a proveedores",
  "rate.manage": "Cambiar la tasa",
  "report.view": "Ver informes",
  "audit.view": "Ver la bitácora",
  "settings.manage": "Cambiar los ajustes",
  "user.manage": "Manejar usuarios",
}
