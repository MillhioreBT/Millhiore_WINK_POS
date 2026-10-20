import { RECURRENCE_FREQUENCIES } from "@millhiore/domain"
import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import { user } from "./access"
import { contact } from "./contacts"
import { currency, terminal } from "./core"

/** Dónde vive el dinero: caja en USD, caja en Bs, banco, pago móvil, Zelle, Binance… */
export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["cash", "bank", "mobile", "wallet"] }).notNull(),
  currency: text("currency")
    .notNull()
    .references(() => currency.code),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
})

/**
 * Recargo que un método de cobro añade a lo que paga el cliente, p. ej. el IGTF (3 %) que un
 * sujeto pasivo especial percibe por los pagos en divisas. Configurable, nunca fijo en el código.
 */
export const surcharge = sqliteTable(
  "surcharge",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    /** Centésimas de punto porcentual: 300 = 3 %. */
    rateBp: integer("rate_bp").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [check("surcharge_rate_range", sql`${t.rateBp} between 0 and 10000`)],
)

export const paymentMethod = sqliteTable("payment_method", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  accountId: text("account_id")
    .notNull()
    .references(() => account.id),
  requiresReference: integer("requires_reference", { mode: "boolean" }).notNull().default(false),
  /** Recargo que se cobra al usar este método (IGTF en divisas); null = ninguno. */
  surchargeId: text("surcharge_id").references(() => surcharge.id),
  /**
   * Comisión que descuenta el banco o el punto de venta por cada cobro (puntos básicos del monto:
   * 250 = 2,5 %). Se aplica a ventas y abonos, no a devoluciones. 0 = ninguna.
   */
  commissionBp: integer("commission_bp").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
})

/**
 * Turno de caja de una terminal: se abre contando el efectivo y se cierra con arqueo. Las
 * diferencias se contabilizan como ingreso o retiro de caja, así el saldo de cada cuenta de
 * efectivo siempre coincide con lo que hay en la gaveta. Una sola apertura por terminal.
 */
export const cashShift = sqliteTable(
  "cash_shift",
  {
    id: text("id").primaryKey(),
    terminalId: text("terminal_id")
      .notNull()
      .references(() => terminal.id),
    status: text("status", { enum: ["open", "closed"] }).notNull(),
    openedBy: text("opened_by").references(() => user.id),
    openedAt: integer("opened_at").notNull(),
    openingNote: text("opening_note"),
    closedBy: text("closed_by").references(() => user.id),
    closedAt: integer("closed_at"),
    closingNote: text("closing_note"),
  },
  (t) => [
    uniqueIndex("cash_shift_one_open").on(t.terminalId).where(sql`${t.status} = 'open'`),
    index("cash_shift_opened_at").on(t.openedAt),
    check("cash_shift_closed_fields", sql`(${t.status} = 'closed') = (${t.closedAt} is not null)`),
  ],
)

/** Arqueo de cada cuenta de efectivo al abrir y al cerrar el turno. */
export const cashShiftAccount = sqliteTable(
  "cash_shift_account",
  {
    shiftId: text("shift_id")
      .notNull()
      .references(() => cashShift.id),
    accountId: text("account_id")
      .notNull()
      .references(() => account.id),
    /** Saldo según los libros al abrir, y lo contado. */
    openingExpectedMinor: integer("opening_expected_minor").notNull(),
    openingCountedMinor: integer("opening_counted_minor").notNull(),
    /** Al cerrar: lo que debería haber, lo contado y el detalle por billete. */
    closingExpectedMinor: integer("closing_expected_minor"),
    closingCountedMinor: integer("closing_counted_minor"),
    /** Billetes y monedas contados: { "2000": 3 } = 3 billetes de 20,00. */
    closingDenominations: text("closing_denominations", { mode: "json" }).$type<
      Record<string, number>
    >(),
    /** Ingreso/retiro con que se asentó la diferencia (sobrante o faltante), si la hubo. */
    openingAdjustmentId: text("opening_adjustment_id"),
    closingAdjustmentId: text("closing_adjustment_id"),
  },
  (t) => [primaryKey({ columns: [t.shiftId, t.accountId] })],
)

/** En qué se gasta el dinero del negocio: alquiler, servicios, sueldos… Cada comercio edita las suyas. */
export const expenseCategory = sqliteTable("expense_category", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  /** Orden en que se muestran; a igual posición, por nombre. */
  position: integer("position").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
})

/**
 * Gasto que se repite (alquiler, internet, sueldos…). Cuando llega `nextDueDay` se registra un
 * gasto: solo, a deber, si es automático (y tiene proveedor), o a mano desde «Por registrar».
 */
export const recurringExpense = sqliteTable(
  "recurring_expense",
  {
    id: text("id").primaryKey(),
    /** En qué se gasta, con las palabras del comercio. */
    note: text("note").notNull(),
    categoryId: text("category_id")
      .notNull()
      .references(() => expenseCategory.id),
    /** A quién se le paga; obligatorio si se genera solo (queda a deber a ese proveedor). */
    contactId: text("contact_id").references(() => contact.id),
    currency: text("currency")
      .notNull()
      .references(() => currency.code),
    amountMinor: integer("amount_minor").notNull(),
    frequency: text("frequency", { enum: RECURRENCE_FREQUENCIES }).notNull(),
    /** Día del mes del primer vencimiento: los meses cortos no corren la fecha de los siguientes. */
    anchorDay: integer("anchor_day").notNull(),
    /** Próximo vencimiento, fecha de calendario del negocio "AAAA-MM-DD". */
    nextDueDay: text("next_due_day").notNull(),
    /** Genera solo el gasto a deber al vencer. */
    auto: integer("auto", { mode: "boolean" }).notNull().default(false),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    /** Por qué no se pudo generar la última vez (sin tasa, proveedor inactivo…); null si todo bien. */
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check("recurring_expense_amount_positive", sql`${t.amountMinor} > 0`),
    check("recurring_expense_anchor_range", sql`${t.anchorDay} between 1 and 31`),
    index("recurring_expense_due").on(t.active, t.nextDueDay),
  ],
)
