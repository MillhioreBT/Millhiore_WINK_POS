import { DOCUMENT_TYPES, TAX_KINDS } from "@millhiore/domain"
import { sql } from "drizzle-orm"
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import { discountCode, type PickedModifier, saleCharge, stockReason, tax, variant } from "./catalog"
import { contact } from "./contacts"
import { currency, location, terminal } from "./core"
import { account, cashShift, expenseCategory, paymentMethod, surcharge } from "./finance"

/**
 * Documento contabilizado. Es inmutable (triggers en la migración `immutability`): un error se
 * corrige con un documento de reverso (`reversesDocumentId`), nunca con un UPDATE.
 */
export const document = sqliteTable(
  "document",
  {
    /** UUIDv7 generado por el cliente: reintentar es idempotente. */
    id: text("id").primaryKey(),
    type: text("type", { enum: DOCUMENT_TYPES }).notNull(),
    /** Número dentro de la serie de la terminal, p. ej. "C1-000123". */
    number: text("number").notNull().unique(),
    terminalId: text("terminal_id")
      .notNull()
      .references(() => terminal.id),
    /** Ubicación cuya existencia mueve el documento; en un traslado, el origen. */
    locationId: text("location_id")
      .notNull()
      .references(() => location.id),
    /** Traslado (`STOCK_TRANSFER`): la ubicación a la que llega la mercancía. */
    toLocationId: text("to_location_id").references(() => location.id),
    currency: text("currency")
      .notNull()
      .references(() => currency.code),
    legalCurrency: text("legal_currency")
      .notNull()
      .references(() => currency.code),
    /** Tasa usada para el total legal; nula cuando `currency` ya es la legal. */
    rateBase: text("rate_base"),
    rateQuote: text("rate_quote"),
    rateValue: text("rate_value"),
    /** Si los precios de las líneas ya traían el IVA. */
    pricesIncludeTax: integer("prices_include_tax", { mode: "boolean" }).notNull().default(false),
    /** Σ (base + IVA) de `document_tax`: el total de la factura, sin recargos. */
    totalMinor: integer("total_minor").notNull(),
    totalLegalMinor: integer("total_legal_minor").notNull(),
    /** Σ descuentos de las líneas (ya restados del total), en la moneda del documento y en la legal. */
    discountMinor: integer("discount_minor").notNull().default(0),
    discountLegalMinor: integer("discount_legal_minor").notNull().default(0),
    /** Σ recargos de `document_surcharge` (IGTF). Lo cobrado es total + recargos. */
    surchargeMinor: integer("surcharge_minor").notNull().default(0),
    surchargeLegalMinor: integer("surcharge_legal_minor").notNull().default(0),
    /** Cliente (venta) o proveedor (compra). */
    contactId: text("contact_id").references(() => contact.id),
    /**
     * Venta a crédito (fiado): lo que el cliente deja a deber, en `creditCurrency` (normalmente
     * la moneda de referencia: una deuda en bolívares se devalúa). En el reverso lleva el signo
     * contrario. Lo cobrado después son abonos (`PAYMENT_IN`) asignados a la venta.
     */
    creditMinor: integer("credit_minor").notNull().default(0),
    creditCurrency: text("credit_currency").references(() => currency.code),
    /** Lo fiado visto en moneda legal con la tasa del día de la venta (para los informes). */
    creditLegalMinor: integer("credit_legal_minor").notNull().default(0),
    /** Hasta cuándo tiene el cliente para pagar lo fiado (según sus días de crédito). */
    dueAt: integer("due_at"),
    /** Referencia externa: número de la factura del proveedor, orden del cliente… */
    externalRef: text("external_ref"),
    /** Turno de caja abierto en la terminal cuando se contabilizó (null si no había). */
    shiftId: text("shift_id").references(() => cashShift.id),
    /** Si no es nulo, este documento anula al indicado. Una sola anulación por documento. */
    reversesDocumentId: text("reverses_document_id").references((): AnySQLiteColumn => document.id),
    /** Devolución (`RETURN`): la venta de la que se devuelven productos. */
    returnsDocumentId: text("returns_document_id").references((): AnySQLiteColumn => document.id),
    /** Gasto (`EXPENSE`): en qué se gastó. */
    expenseCategoryId: text("expense_category_id").references(() => expenseCategory.id),
    /** Ajuste de inventario (`ADJUSTMENT`): por qué cambió la existencia. */
    stockReasonId: text("stock_reason_id").references(() => stockReason.id),
    /** Venta con código de descuento: cuál se usó (cuenta como un uso mientras no se anule). */
    discountCodeId: text("discount_code_id").references(() => discountCode.id),
    /**
     * Venta: la propina que dejó el cliente, en la moneda del documento y en la legal (con signo
     * contrario en el reverso). No es parte del total: los pagos la cubren además.
     */
    tipMinor: integer("tip_minor").notNull().default(0),
    tipLegalMinor: integer("tip_legal_minor").notNull().default(0),
    /** Para quién es la propina (un usuario); null = para todo el equipo. */
    tipUserId: text("tip_user_id"),
    note: text("note"),
    createdBy: text("created_by"),
    postedAt: integer("posted_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check(
      "document_rate_all_or_none",
      sql`(${t.rateBase} is null) = (${t.rateQuote} is null) and (${t.rateQuote} is null) = (${t.rateValue} is null)`,
    ),
    uniqueIndex("document_reverses_unique").on(t.reversesDocumentId),
    index("document_posted_at").on(t.postedAt),
    index("document_type_posted_at").on(t.type, t.postedAt),
    index("document_shift").on(t.shiftId),
    index("document_contact").on(t.contactId),
    index("document_returns").on(t.returnsDocumentId),
    index("document_expense_category").on(t.expenseCategoryId),
    index("document_stock_reason").on(t.stockReasonId),
  ],
)

export const documentLine = sqliteTable(
  "document_line",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id),
    lineNo: integer("line_no").notNull(),
    variantId: text("variant_id")
      .notNull()
      .references(() => variant.id),
    /** Milésimas de unidad (1000 = 1) para poder vender por peso. */
    qtyMilli: integer("qty_milli").notNull(),
    unitPriceMinor: integer("unit_price_minor").notNull(),
    /** Descuento de la línea, ya restado de `lineTotalMinor` (cantidad × precio − descuento). */
    discountMinor: integer("discount_minor").notNull().default(0),
    lineTotalMinor: integer("line_total_minor").notNull(),
    /** IVA congelado al contabilizar; null = sin impuesto. */
    taxId: text("tax_id").references(() => tax.id),
    taxRateBp: integer("tax_rate_bp").notNull().default(0),
    /**
     * Costo unitario del producto al contabilizar (su último costo de compra), en `costCurrency`.
     * Solo en ventas y ajustes de inventario; null si el producto no tenía costo. Es lo que vale
     * la mercancía que sale, para medir pérdidas y, más adelante, la utilidad.
     */
    costMinor: integer("cost_minor"),
    costCurrency: text("cost_currency").references(() => currency.code),
    /** Opciones y extras elegidos (ya incluidos en el precio); null = ninguno. */
    modifiers: text("modifiers", { mode: "json" }).$type<PickedModifier[]>(),
    /** Indicaciones para la cocina («sin cebolla»). */
    note: text("note"),
  },
  (t) => [
    check("document_line_qty_nonzero", sql`${t.qtyMilli} <> 0`),
    uniqueIndex("document_line_order").on(t.documentId, t.lineNo),
  ],
)

export const payment = sqliteTable(
  "payment",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id),
    paymentMethodId: text("payment_method_id")
      .notNull()
      .references(() => paymentMethod.id),
    accountId: text("account_id")
      .notNull()
      .references(() => account.id),
    currency: text("currency")
      .notNull()
      .references(() => currency.code),
    /** Con signo: negativo = vuelto entregado. */
    amountMinor: integer("amount_minor").notNull(),
    /** Tasa entre la moneda del pago y la del documento; nula si son la misma. */
    rateBase: text("rate_base"),
    rateQuote: text("rate_quote"),
    rateValue: text("rate_value"),
    reference: text("reference"),
    /** Recargo del método congelado al contabilizar (solo ventas); null = ninguno. */
    surchargeId: text("surcharge_id").references(() => surcharge.id),
    surchargeRateBp: integer("surcharge_rate_bp").notNull().default(0),
    /**
     * Comisión del método congelada al contabilizar: lo que el banco descuenta de este cobro, con
     * el signo del pago (negativa en el reverso). La cuenta recibe el pago menos la comisión.
     */
    commissionRateBp: integer("commission_rate_bp").notNull().default(0),
    commissionMinor: integer("commission_minor").notNull().default(0),
  },
  (t) => [
    check("payment_amount_nonzero", sql`${t.amountMinor} <> 0`),
    check(
      "payment_rate_all_or_none",
      sql`(${t.rateBase} is null) = (${t.rateQuote} is null) and (${t.rateQuote} is null) = (${t.rateValue} is null)`,
    ),
    index("payment_document").on(t.documentId),
  ],
)

/**
 * Desglose del documento por alícuota de IVA, en su moneda y en la legal: lo que va a la
 * factura y al libro de ventas/compras. Inmutable como el documento.
 */
export const documentTax = sqliteTable(
  "document_tax",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id),
    position: integer("position").notNull(),
    /** null = líneas sin impuesto (negocio que no cobra IVA). */
    taxId: text("tax_id").references(() => tax.id),
    kind: text("kind", { enum: TAX_KINDS }).notNull(),
    rateBp: integer("rate_bp").notNull(),
    baseMinor: integer("base_minor").notNull(),
    taxMinor: integer("tax_minor").notNull(),
    baseLegalMinor: integer("base_legal_minor").notNull(),
    taxLegalMinor: integer("tax_legal_minor").notNull(),
  },
  (t) => [uniqueIndex("document_tax_order").on(t.documentId, t.position)],
)

/** Recargos cobrados en el documento (IGTF), con la base sobre la que se calcularon. */
export const documentSurcharge = sqliteTable(
  "document_surcharge",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id),
    position: integer("position").notNull(),
    surchargeId: text("surcharge_id")
      .notNull()
      .references(() => surcharge.id),
    rateBp: integer("rate_bp").notNull(),
    baseMinor: integer("base_minor").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    baseLegalMinor: integer("base_legal_minor").notNull(),
    amountLegalMinor: integer("amount_legal_minor").notNull(),
  },
  (t) => [uniqueIndex("document_surcharge_order").on(t.documentId, t.position)],
)

/**
 * Recargos de venta cobrados en el documento (delivery, servicio…), congelados al contabilizar: si
 * luego cambia el recargo, la venta no. Suman al total como una línea más, con su IVA.
 */
export const documentCharge = sqliteTable(
  "document_charge",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id),
    position: integer("position").notNull(),
    chargeId: text("charge_id")
      .notNull()
      .references(() => saleCharge.id),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["percent", "fixed"] }).notNull(),
    rateBp: integer("rate_bp").notNull(),
    /** Porcentual: el subtotal sin IVA sobre el que se calculó; fijo: 0. */
    baseMinor: integer("base_minor").notNull(),
    /** Lo que suma a la venta, en su moneda (con el IVA si los precios lo incluyen). */
    amountMinor: integer("amount_minor").notNull(),
    amountLegalMinor: integer("amount_legal_minor").notNull(),
    taxId: text("tax_id").references(() => tax.id),
    taxRateBp: integer("tax_rate_bp").notNull(),
  },
  (t) => [uniqueIndex("document_charge_order").on(t.documentId, t.position)],
)

/**
 * Qué documento a crédito paga un abono o un pago a proveedor y cuánto (en la moneda de ambos):
 * una venta fiada (`PAYMENT_IN`) o una compra o gasto a deber (`PAYMENT_OUT`). Es inmutable:
 * anular el pago agrega filas con el monto negativo, así lo que se debe de un documento es
 * `credit_minor − Σ amount_minor`. (`sale_document_id` es el documento a crédito, sea del tipo que sea.)
 */
export const allocation = sqliteTable(
  "allocation",
  {
    id: text("id").primaryKey(),
    paymentDocumentId: text("payment_document_id")
      .notNull()
      .references(() => document.id),
    saleDocumentId: text("sale_document_id")
      .notNull()
      .references(() => document.id),
    amountMinor: integer("amount_minor").notNull(),
  },
  (t) => [
    check("allocation_amount_nonzero", sql`${t.amountMinor} <> 0`),
    index("allocation_payment").on(t.paymentDocumentId),
    index("allocation_sale").on(t.saleDocumentId),
  ],
)

/** Último número emitido por (terminal, tipo). */
export const documentSequence = sqliteTable(
  "document_sequence",
  {
    terminalId: text("terminal_id")
      .notNull()
      .references(() => terminal.id),
    type: text("type", { enum: DOCUMENT_TYPES }).notNull(),
    lastNumber: integer("last_number").notNull(),
  },
  (t) => [primaryKey({ columns: [t.terminalId, t.type] })],
)
