import {
  account,
  accountBalance,
  accountMove,
  allocation,
  auditLog,
  business,
  cashShift,
  contact,
  currency,
  type Db,
  discountCode,
  document,
  documentCharge,
  documentLine,
  documentSequence,
  documentSurcharge,
  documentTax,
  expenseCategory,
  location,
  lot,
  outbox,
  payment,
  paymentMethod,
  product,
  quote,
  saleCharge,
  stockBalance,
  stockMove,
  stockReason,
  surcharge,
  tax,
  terminal,
  user,
  variant,
} from "@millhiore/db"
import {
  type CurrencyBook,
  type CurrencyCode,
  commissionMinor,
  convert,
  type DocumentDraft,
  type DocumentType,
  type DraftAllocation,
  type DraftCharge,
  type ExchangeRate,
  exchangeRate,
  formatDocumentNumber,
  ingredientQty,
  isCashMovement,
  isReturn,
  isUuidv7,
  isValidDate,
  type LineTax,
  type LotTake,
  lineTotal,
  localDate,
  money,
  type PlannedLine,
  type PlannedStockMove,
  PostingError,
  planPosting,
  rateConverter,
  recipeCost,
  type SurchargeGroup,
  splitTax,
  type TaxGroup,
  type TaxpayerType,
  uuidv7,
} from "@millhiore/domain"
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { allocateOut, applyLotMove, lotFor, lotQty, purchaseLots, returnableLots } from "./lots"
import { pickModifiers } from "./modifiers"
import { collectedOn, openPayables, openSales, owedInReference } from "./receivables"
import { type Ingredient, recipesOf } from "./recipes"
import { activeReturns, isReversed, returnableLines } from "./returns"
import { checkTabPayment, settleTab, type TabTake } from "./tabs"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export interface PostLineInput {
  variantId: string
  qtyMilli: number
  unitPriceMinor: number
  /** Descuento sobre la línea, en la moneda del documento. Solo en ventas. */
  discountMinor?: number | undefined
  /**
   * IVA ya fijado para la línea (null = sin impuesto). Solo lo usa el servidor al devolver una
   * venta, que debe conservar el IVA y la alícuota con que se facturó; la API pública no lo admite.
   */
  tax?: LineTax | null | undefined
  /** Producto con lotes: el lote existente del que sale (ajuste, traslado) o al que entra (ajuste). */
  lotId?: string | undefined
  /** Producto con lotes: el lote nuevo que entra (compra, ajuste de entrada). */
  lot?: { code?: string | null | undefined; expiresOn: string | null } | undefined
  /** Venta: opciones y extras elegidos (su precio ya va en `unitPriceMinor`). */
  modifierIds?: readonly string[] | undefined
  /** Venta: indicaciones para la cocina. */
  note?: string | null | undefined
}

export interface PostPaymentInput {
  /** UUIDv7 generado por el cliente. */
  id: string
  paymentMethodId: string
  currency: CurrencyCode
  /** Con signo: negativo = vuelto entregado. */
  amountMinor: number
  /** Tasa entre la moneda del pago y la del documento; obligatoria si difieren. */
  rate: ExchangeRate | null
  reference?: string | null | undefined
}

export interface PostDocumentInput {
  /** UUIDv7 generado por el cliente: reenviar el mismo documento es seguro. */
  id: string
  type: DocumentType
  terminalId: string
  currency: CurrencyCode
  /** Tasa para el total en moneda legal; solo hace falta si `currency` no es la legal. */
  rate: ExchangeRate | null
  lines: readonly PostLineInput[]
  payments: readonly PostPaymentInput[]
  /**
   * Si los precios de las líneas ya traen el IVA. Por defecto: en ventas, lo que diga la
   * configuración fiscal; en compras, no (como la factura del proveedor).
   */
  pricesIncludeTax?: boolean | undefined
  /** Cliente (venta) o proveedor (compra). */
  contactId?: string | null | undefined
  /** Número de la factura del proveedor u otra referencia externa. */
  externalRef?: string | null | undefined
  note?: string | null | undefined
  /**
   * Venta a crédito (fiado): lo que el cliente deja a deber, en la moneda del documento. Los
   * pagos cubren el resto. Exige un cliente.
   */
  creditMinor?: number | undefined
  /** Moneda de la deuda; si falta, la de referencia del negocio (USD). */
  creditCurrency?: CurrencyCode | undefined
  /** Devolución (`RETURN`): la venta de la que se devuelven productos. */
  returnsDocumentId?: string | null | undefined
  /**
   * Abono (`PAYMENT_IN`) o pago a proveedor (`PAYMENT_OUT`): qué ventas a crédito del cliente, o
   * qué compras y gastos a deber, paga y cuánto de cada uno.
   */
  allocations?: readonly DraftAllocation[] | undefined
  /** Gasto (`EXPENSE`): lo que costó, en la moneda del documento (los pagos lo cubren). */
  amountMinor?: number | undefined
  /** Gasto (`EXPENSE`): en qué se gastó (una categoría activa). */
  expenseCategoryId?: string | null | undefined
  /**
   * Ajuste de inventario (`ADJUSTMENT`): por qué cambia la existencia (merma, vencido, conteo…).
   * Si falta, «Otra entrada» u «Otra salida» según el signo de las cantidades.
   */
  stockReasonId?: string | null | undefined
  /** Compra o gasto a deber: hasta cuándo hay para pagar (si falta, los días de crédito del proveedor). */
  dueAt?: number | null | undefined
  /**
   * Venta: recargos (delivery, servicio…). El de monto fijo puede traer el monto en la moneda del
   * documento; si falta, se usa el sugerido convertido con la tasa del documento.
   */
  charges?: readonly { chargeId: string; amountMinor?: number | undefined }[] | undefined
  /** Venta que sale de una cotización abierta: queda convertida en la misma transacción. */
  quoteId?: string | null | undefined
  /**
   * Compra, ajuste o traslado: la ubicación cuya existencia cambia (en el traslado, el origen).
   * Si falta, la de la caja. Las ventas y devoluciones mueven siempre la ubicación de su caja.
   */
  locationId?: string | null | undefined
  /** Traslado (`STOCK_TRANSFER`): la ubicación a la que llega la mercancía. */
  toLocationId?: string | null | undefined
  /** Venta con código de descuento. */
  discountCodeId?: string | null | undefined
  /** Venta que cobra productos de una cuenta abierta (restaurante): cuánto de cada uno. */
  tab?: { id: string; lines: readonly TabTake[] } | null | undefined
  /**
   * Venta: la propina que deja el cliente, en la moneda del documento. No suma al total ni lleva
   * IVA o IGTF: los pagos la cubren además de la venta.
   */
  tipMinor?: number | undefined
  /** Para quién es la propina (un usuario activo); null = para todo el equipo. */
  tipUserId?: string | null | undefined
  /**
   * Lo pone el servidor (nunca la API): quien vende no puede dar descuentos a mano, así que los
   * descuentos de la venta no pueden pasar de lo que da su código.
   */
  discountFromCodeOnly?: boolean | undefined
}

export interface PostContext {
  now: number
  actorId: string | null
  /** Si es false, una salida que dejaría el saldo por debajo de cero se rechaza. */
  allowNegativeStock: boolean
  /** Vender (y mover caja) exige un turno abierto en la terminal. */
  requireShift: boolean
  /** Si el negocio vende a crédito (fiado). */
  creditEnabled: boolean
  fiscal: {
    taxpayer: TaxpayerType
    /** Precios de venta con IVA incluido. */
    pricesIncludeTax: boolean
    /** IVA de los productos sin uno asignado. */
    defaultTaxId: string
  }
}

export interface PostedDocument {
  id: string
  number: string
  /** Total de la factura (base + IVA), sin recargos. */
  totalMinor: number
  totalLegalMinor: number
  /** IGTF y demás recargos: lo cobrado es `totalMinor + surchargeMinor`. */
  surchargeMinor: number
  surchargeLegalMinor: number
  taxes: TaxGroup[]
  surcharges: SurchargeGroup[]
  /** Lo que el cliente deja a deber (venta a crédito); 0 si se pagó todo. */
  creditMinor: number
  creditCurrency: CurrencyCode | null
  /** Hasta cuándo puede pagar lo fiado; null si no tiene plazo. */
  dueAt: number | null
  /** true si el documento ya estaba contabilizado y no se escribió nada nuevo. */
  duplicate: boolean
}

const noRate = { rateBase: null, rateQuote: null, rateValue: null }

/**
 * Documentos que exigen turno abierto: los que mueven la gaveta desde la caja. Los gastos, los pagos
 * a proveedores y las transferencias entre cuentas solo lo exigen si tocan una cuenta de efectivo.
 */
const SHIFT_TYPES: ReadonlySet<DocumentType> = new Set([
  "SALE",
  "RETURN",
  "PAYMENT_IN",
  "CASH_IN",
  "CASH_OUT",
])

const DAY_MS = 86_400_000

/** Documentos que pueden mover la existencia de otra ubicación que la de su caja (el depósito). */
const LOCATION_TYPES: ReadonlySet<DocumentType> = new Set([
  "PURCHASE",
  "PURCHASE_RETURN",
  "ADJUSTMENT",
  "STOCK_TRANSFER",
  "PRODUCTION",
])

function requireActiveLocation(tx: Tx, id: string): void {
  const row = tx.select({ active: location.active }).from(location).where(eq(location.id, id)).get()
  if (!row?.active) {
    throw new PostingError("UNKNOWN_REFERENCE", `Ubicación desconocida o inactiva: ${id}`)
  }
}

/**
 * Una compra deja el último costo de cada producto. Sin IVA si el negocio lo acredita (el IVA
 * de compra es crédito fiscal, no costo); con IVA si no cobra IVA (para él sí es costo).
 */
function updateLastCosts(
  tx: Tx,
  lines: readonly PlannedLine[],
  draft: DocumentDraft,
  ctx: PostContext,
): void {
  for (const l of lines) {
    const net =
      draft.pricesIncludeTax && l.taxRateBp > 0 && ctx.fiscal.taxpayer !== "none"
        ? splitTax(l.unitPriceMinor, l.taxRateBp, true).baseMinor
        : !draft.pricesIncludeTax && l.taxRateBp > 0 && ctx.fiscal.taxpayer === "none"
          ? l.unitPriceMinor + splitTax(l.unitPriceMinor, l.taxRateBp, false).taxMinor
          : l.unitPriceMinor
    tx.update(variant)
      .set({ costMinor: net, costCurrency: draft.currency })
      .where(eq(variant.id, l.variantId))
      .run()
  }
}

/** Turno abierto de la terminal, si lo hay. */
export function openShiftOf(tx: Tx, terminalId: string): string | null {
  return (
    tx
      .select({ id: cashShift.id })
      .from(cashShift)
      .where(and(eq(cashShift.terminalId, terminalId), eq(cashShift.status, "open")))
      .get()?.id ?? null
  )
}

/** Cambia el signo sin producir -0 (que no es igual a 0 al comparar resultados). */
const negate = (n: number) => (n === 0 ? 0 : -n)

function rateColumns(rate: ExchangeRate | null) {
  return rate ? { rateBase: rate.base, rateQuote: rate.quote, rateValue: rate.value } : noRate
}

function loadBook(tx: Tx): CurrencyBook {
  return Object.fromEntries(
    tx
      .select()
      .from(currency)
      .all()
      .map((c) => [c.code, { code: c.code, decimals: c.decimals }]),
  )
}

function nextNumber(tx: Tx, terminalId: string, type: DocumentType): number {
  const row = tx
    .insert(documentSequence)
    .values({ terminalId, type, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [documentSequence.terminalId, documentSequence.type],
      set: { lastNumber: sql`${documentSequence.lastNumber} + 1` },
    })
    .returning({ n: documentSequence.lastNumber })
    .get()
  if (!row) throw new Error("No se pudo asignar el número de documento")
  return row.n
}

function variantName(tx: Tx, id: string): string {
  return tx.select({ name: variant.name }).from(variant).where(eq(variant.id, id)).get()?.name ?? id
}

function applyStockMove(
  tx: Tx,
  move: { variantId: string; locationId: string; qtyMilli: number },
  ctx: PostContext,
): void {
  const row = tx
    .insert(stockBalance)
    .values(move)
    .onConflictDoUpdate({
      target: [stockBalance.variantId, stockBalance.locationId],
      set: { qtyMilli: sql`${stockBalance.qtyMilli} + ${move.qtyMilli}` },
    })
    .returning({ qty: stockBalance.qtyMilli })
    .get()
  if (move.qtyMilli < 0 && row && row.qty < 0 && !ctx.allowNegativeStock) {
    throw new PostingError(
      "INSUFFICIENT_STOCK",
      `No alcanza la existencia de ${variantName(tx, move.variantId)} (quedaría en ${row.qty / 1000})`,
    )
  }
}

function applyAccountMove(tx: Tx, accountId: string, amountMinor: number): void {
  tx.insert(accountBalance)
    .values({ accountId, amountMinor })
    .onConflictDoUpdate({
      target: accountBalance.accountId,
      set: { amountMinor: sql`${accountBalance.amountMinor} + ${amountMinor}` },
    })
    .run()
}

function record(
  tx: Tx,
  ctx: PostContext,
  action: "document.posted" | "document.voided",
  doc: {
    id: string
    type: DocumentType
    number: string
    totalMinor: number
    surchargeMinor: number
    reverses?: string
  },
): void {
  tx.insert(auditLog)
    .values({
      id: uuidv7(ctx.now),
      at: ctx.now,
      actorId: ctx.actorId,
      action,
      entityType: "document",
      entityId: doc.id,
      data: doc,
    })
    .run()
  tx.insert(outbox)
    .values({ id: uuidv7(ctx.now), type: action, payload: doc, createdAt: ctx.now })
    .run()
}

/** Desglose de IVA y recargos guardado de un documento, en su orden. */
function loadBreakdown(tx: Tx, documentId: string) {
  const taxes: TaxGroup[] = tx
    .select({
      taxId: documentTax.taxId,
      kind: documentTax.kind,
      rateBp: documentTax.rateBp,
      baseMinor: documentTax.baseMinor,
      taxMinor: documentTax.taxMinor,
      baseLegalMinor: documentTax.baseLegalMinor,
      taxLegalMinor: documentTax.taxLegalMinor,
    })
    .from(documentTax)
    .where(eq(documentTax.documentId, documentId))
    .orderBy(asc(documentTax.position))
    .all()
  const surcharges: SurchargeGroup[] = tx
    .select({
      surchargeId: documentSurcharge.surchargeId,
      rateBp: documentSurcharge.rateBp,
      baseMinor: documentSurcharge.baseMinor,
      amountMinor: documentSurcharge.amountMinor,
      baseLegalMinor: documentSurcharge.baseLegalMinor,
      amountLegalMinor: documentSurcharge.amountLegalMinor,
    })
    .from(documentSurcharge)
    .where(eq(documentSurcharge.documentId, documentId))
    .orderBy(asc(documentSurcharge.position))
    .all()
  return { taxes, surcharges }
}

function resultOf(
  tx: Tx,
  row: Pick<
    typeof document.$inferSelect,
    | "id"
    | "number"
    | "totalMinor"
    | "totalLegalMinor"
    | "surchargeMinor"
    | "surchargeLegalMinor"
    | "creditMinor"
    | "creditCurrency"
    | "dueAt"
  >,
  duplicate: boolean,
): PostedDocument {
  return {
    id: row.id,
    number: row.number,
    totalMinor: row.totalMinor,
    totalLegalMinor: row.totalLegalMinor,
    surchargeMinor: row.surchargeMinor,
    surchargeLegalMinor: row.surchargeLegalMinor,
    creditMinor: row.creditMinor,
    creditCurrency: row.creditCurrency,
    dueAt: row.dueAt,
    ...loadBreakdown(tx, row.id),
    duplicate,
  }
}

function existingResult(
  tx: Tx,
  row: typeof document.$inferSelect,
  matches: boolean,
  what: string,
): PostedDocument {
  if (!matches) {
    throw new PostingError("ID_CONFLICT", `El id ${row.id} ya pertenece a otro ${what}`)
  }
  return resultOf(tx, row, true)
}

function insertBreakdown(
  tx: Tx,
  documentId: string,
  now: number,
  taxes: readonly TaxGroup[],
  surcharges: readonly SurchargeGroup[],
): void {
  taxes.forEach((t, i) => {
    tx.insert(documentTax)
      .values({ id: uuidv7(now), documentId, position: i + 1, ...t })
      .run()
  })
  surcharges.forEach((s, i) => {
    tx.insert(documentSurcharge)
      .values({ id: uuidv7(now), documentId, position: i + 1, ...s })
      .run()
  })
}

/**
 * Contabiliza un documento: valida, numera, escribe cabecera/líneas/pagos, genera los
 * movimientos de inventario y de dinero, actualiza las proyecciones y deja auditoría y evento.
 * Todo en una sola transacción: si algo falla no se escribe nada. Reenviar el mismo `id` es
 * idempotente.
 */
export function postDocument(db: Db, input: PostDocumentInput, ctx: PostContext): PostedDocument {
  return db.transaction((tx) => postDocumentIn(tx, input, ctx), { behavior: "immediate" })
}

/** Como `postDocument`, dentro de una transacción ya abierta (p. ej. el cierre de un turno). */
export function postDocumentIn(tx: Tx, input: PostDocumentInput, ctx: PostContext): PostedDocument {
  if (!isUuidv7(input.id)) {
    throw new PostingError("UNKNOWN_REFERENCE", "El id del documento debe ser un UUIDv7")
  }
  for (const p of input.payments) {
    if (!isUuidv7(p.id)) {
      throw new PostingError("UNKNOWN_REFERENCE", "El id de cada pago debe ser un UUIDv7")
    }
  }

  const existing = tx.select().from(document).where(eq(document.id, input.id)).get()
  if (existing) {
    return existingResult(
      tx,
      existing,
      existing.type === input.type && existing.terminalId === input.terminalId,
      "documento",
    )
  }

  const term = tx.select().from(terminal).where(eq(terminal.id, input.terminalId)).get()
  if (!term?.active) {
    throw new PostingError(
      "UNKNOWN_REFERENCE",
      `Terminal desconocida o inactiva: ${input.terminalId}`,
    )
  }
  const biz = tx.select().from(business).get()
  if (!biz) throw new PostingError("UNKNOWN_REFERENCE", "El negocio no está configurado")
  if ((input.locationId || input.toLocationId) && !LOCATION_TYPES.has(input.type)) {
    throw new PostingError(
      "INVALID_LINE",
      "Solo una compra (o su devolución), un ajuste, un traslado o una producción eligen la ubicación: lo demás usa la de la caja",
    )
  }
  if (input.toLocationId && input.type !== "STOCK_TRANSFER") {
    throw new PostingError("INVALID_LINE", "Solo un traslado lleva ubicación de destino")
  }
  const locationId = input.locationId || term.locationId
  if (locationId !== term.locationId) requireActiveLocation(tx, locationId)
  const toLocationId = input.type === "STOCK_TRANSFER" ? (input.toLocationId ?? null) : null
  if (toLocationId) requireActiveLocation(tx, toLocationId)
  const book = loadBook(tx)
  const party = input.contactId
    ? tx
        .select({
          id: contact.id,
          kind: contact.kind,
          active: contact.active,
          creditDays: contact.creditDays,
          creditLimitMinor: contact.creditLimitMinor,
        })
        .from(contact)
        .where(eq(contact.id, input.contactId))
        .get()
    : undefined
  if (input.contactId && !party?.active) {
    throw new PostingError("UNKNOWN_REFERENCE", `Contacto desconocido: ${input.contactId}`)
  }
  const shiftId = openShiftOf(tx, term.id)
  if (!shiftId && ctx.requireShift && SHIFT_TYPES.has(input.type)) {
    throw new PostingError("SHIFT_CLOSED", `Abre el turno de ${term.name} para registrar esto`)
  }
  let stockReasonId: string | null = null
  if (input.type === "ADJUSTMENT") {
    const signs = new Set(input.lines.map((l) => Math.sign(l.qtyMilli)))
    const reason = input.stockReasonId
      ? tx.select().from(stockReason).where(eq(stockReason.id, input.stockReasonId)).get()
      : signs.size === 1
        ? tx
            .select()
            .from(stockReason)
            .where(eq(stockReason.id, signs.has(1) ? "stk-in-other" : "stk-out-other"))
            .get()
        : undefined
    if (!reason?.active) {
      throw new PostingError("UNKNOWN_REFERENCE", "Elige el motivo del ajuste de inventario")
    }
    // Una salida solo resta existencia y una entrada solo la suma.
    const wanted = reason.direction === "in" ? 1 : -1
    if (input.lines.some((l) => Math.sign(l.qtyMilli) !== wanted)) {
      throw new PostingError(
        "INVALID_LINE",
        reason.direction === "in"
          ? `«${reason.name}» es una entrada: las cantidades deben ser positivas`
          : `«${reason.name}» es una salida: las cantidades deben ser negativas`,
      )
    }
    stockReasonId = reason.id
  } else if (input.stockReasonId) {
    throw new PostingError("INVALID_LINE", "Solo un ajuste de inventario lleva motivo")
  }
  let expenseCategoryId: string | null = null
  if (input.type === "EXPENSE") {
    const category = input.expenseCategoryId
      ? tx
          .select({ id: expenseCategory.id, active: expenseCategory.active })
          .from(expenseCategory)
          .where(eq(expenseCategory.id, input.expenseCategoryId))
          .get()
      : undefined
    if (!category?.active) {
      throw new PostingError("UNKNOWN_REFERENCE", "Elige la categoría del gasto")
    }
    expenseCategoryId = category.id
    if (party?.kind === "customer") {
      throw new PostingError("UNKNOWN_REFERENCE", "A un cliente no se le paga un gasto")
    }
  }

  const variantIds = [...new Set(input.lines.map((l) => l.variantId))]
  const variants = new Map(
    (variantIds.length === 0
      ? []
      : tx
          .select({
            id: variant.id,
            active: variant.active,
            productActive: product.active,
            tracksStock: product.tracksStock,
            tracksLots: product.tracksLots,
            taxId: product.taxId,
            costMinor: variant.costMinor,
            costCurrency: variant.costCurrency,
          })
          .from(variant)
          .innerJoin(product, eq(variant.productId, product.id))
          .where(inArray(variant.id, variantIds))
          .all()
    ).map((v) => [v.id, v]),
  )
  for (const id of variantIds) {
    // La talla o el color desactivados, o el producto entero.
    const v = variants.get(id)
    if (!(v?.active && v.productActive)) {
      throw new PostingError("UNKNOWN_REFERENCE", `Variante desconocida o inactiva: ${id}`)
    }
  }
  // Un lote nuevo entra con una compra o un ajuste de entrada; uno existente se elige al ajustar o
  // trasladar. Lo demás reparte solo.
  for (const [i, l] of input.lines.entries()) {
    if (!l.lot && !l.lotId) continue
    const fail = (why: string) => {
      throw new PostingError("INVALID_LINE", `Línea ${i + 1}: ${why}`)
    }
    if (!variants.get(l.variantId)?.tracksLots) fail("el producto no lleva lotes")
    if (l.lot && l.lotId) fail("elige un lote existente o uno nuevo, no los dos")
    if (l.lot) {
      if (
        !(
          input.type === "PURCHASE" ||
          input.type === "PRODUCTION" ||
          (input.type === "ADJUSTMENT" && l.qtyMilli > 0)
        )
      ) {
        fail("solo una compra, una producción o una entrada de inventario traen un lote nuevo")
      }
      if (l.lot.expiresOn !== null && !isValidDate(l.lot.expiresOn)) {
        fail("la fecha de vencimiento no es válida")
      }
    }
    if (l.lotId) {
      if (input.type !== "ADJUSTMENT" && input.type !== "STOCK_TRANSFER") {
        fail("solo un ajuste o un traslado eligen el lote")
      }
      const row = tx.select({ variantId: lot.variantId }).from(lot).where(eq(lot.id, l.lotId)).get()
      if (row?.variantId !== l.variantId) {
        throw new PostingError("UNKNOWN_REFERENCE", `Línea ${i + 1}: lote desconocido`)
      }
    }
  }

  // El IVA lo decide el servidor según el producto y la condición fiscal, nunca el cliente.
  // Quien no cobra IVA vende sin impuesto, pero sus compras sí lo traen del proveedor.
  const { fiscal } = ctx
  const charged =
    input.type !== "ADJUSTMENT" &&
    input.type !== "STOCK_TRANSFER" &&
    input.type !== "PRODUCTION" &&
    !(input.type === "SALE" && fiscal.taxpayer === "none")
  const taxIdOf = (variantId: string) => variants.get(variantId)?.taxId ?? fiscal.defaultTaxId
  const taxIds = charged
    ? [...new Set(input.lines.filter((l) => l.tax === undefined).map((l) => taxIdOf(l.variantId)))]
    : []
  const taxes = new Map(
    (taxIds.length === 0 ? [] : tx.select().from(tax).where(inArray(tax.id, taxIds)).all()).map(
      (t) => [t.id, t],
    ),
  )
  const lineTax = (l: PostLineInput): LineTax | null => {
    // Una devolución conserva el IVA de la línea vendida (aunque el producto cambie de IVA luego).
    if (l.tax !== undefined) return l.tax
    if (!charged) return null
    const t = taxes.get(taxIdOf(l.variantId))
    if (!t) {
      throw new PostingError("UNKNOWN_REFERENCE", `Impuesto desconocido: ${taxIdOf(l.variantId)}`)
    }
    return { taxId: t.id, kind: t.kind, rateBp: t.rateBp }
  }

  const methodIds = [...new Set(input.payments.map((p) => p.paymentMethodId))]
  const methods = new Map(
    (methodIds.length === 0
      ? []
      : tx
          .select({
            id: paymentMethod.id,
            active: paymentMethod.active,
            requiresReference: paymentMethod.requiresReference,
            commissionBp: paymentMethod.commissionBp,
            accountId: account.id,
            accountCurrency: account.currency,
            accountKind: account.kind,
            surchargeId: surcharge.id,
            surchargeRateBp: surcharge.rateBp,
            surchargeActive: surcharge.active,
          })
          .from(paymentMethod)
          .innerJoin(account, eq(paymentMethod.accountId, account.id))
          .leftJoin(surcharge, eq(paymentMethod.surchargeId, surcharge.id))
          .where(inArray(paymentMethod.id, methodIds))
          .all()
    ).map((m) => [m.id, m]),
  )
  for (const p of input.payments) {
    const m = methods.get(p.paymentMethodId)
    if (!m?.active) {
      throw new PostingError(
        "UNKNOWN_REFERENCE",
        `Método de pago desconocido o inactivo: ${p.paymentMethodId}`,
      )
    }
    if (m.accountCurrency !== p.currency) {
      throw new PostingError(
        "CURRENCY_MISMATCH",
        `El método ${m.id} cobra en ${m.accountCurrency}, no en ${p.currency}`,
      )
    }
    if (isCashMovement(input.type)) {
      // Los ingresos y retiros son de la gaveta; mover dinero entre cuentas es otro documento.
      if (m.accountKind !== "cash") {
        throw new PostingError("INVALID_PAYMENT", "Los ingresos y retiros son solo de efectivo")
      }
    } else if (input.type !== "TRANSFER" && m.requiresReference && !p.reference?.trim()) {
      throw new PostingError("INVALID_PAYMENT", `El método ${m.id} exige una referencia`)
    }
  }

  // Un gasto pagado en efectivo sale de la gaveta de la terminal, así que exige turno abierto;
  // pagado por banco, pago móvil o Zelle no depende de ninguna caja.
  if (
    (input.type === "EXPENSE" ||
      input.type === "PURCHASE_RETURN" ||
      input.type === "PAYMENT_OUT" ||
      input.type === "TRANSFER" ||
      input.type === "DEBT_IN" ||
      input.type === "DEBT_OUT") &&
    !shiftId &&
    ctx.requireShift &&
    input.payments.some((p) => methods.get(p.paymentMethodId)?.accountKind === "cash")
  ) {
    throw new PostingError("SHIFT_CLOSED", `Abre el turno de ${term.name} para mover efectivo`)
  }

  const docRate = input.rate && exchangeRate(input.rate.base, input.rate.quote, input.rate.value)
  if (docRate && docRate.base !== input.currency && docRate.quote !== input.currency) {
    throw new PostingError(
      "CURRENCY_MISMATCH",
      `La tasa ${docRate.base}/${docRate.quote} no involucra la moneda del documento (${input.currency})`,
    )
  }
  // Devolución: de una venta (o, al proveedor, de una compra) vigente, sin devolver más de lo
  // que tuvo.
  let returnOf: typeof document.$inferSelect | undefined
  if (isReturn(input.type)) {
    const [of, what] =
      input.type === "RETURN" ? (["SALE", "venta"] as const) : (["PURCHASE", "compra"] as const)
    returnOf = input.returnsDocumentId
      ? tx.select().from(document).where(eq(document.id, input.returnsDocumentId)).get()
      : undefined
    if (returnOf?.type !== of || returnOf.reversesDocumentId) {
      throw new PostingError("NOT_RETURNABLE", `Elige una ${what} para devolver`)
    }
    if (isReversed(tx, returnOf.id)) {
      throw new PostingError("NOT_RETURNABLE", `La ${what} ${returnOf.number} está anulada`)
    }
    if (input.currency !== returnOf.currency) {
      throw new PostingError("CURRENCY_MISMATCH", `La devolución va en la moneda de la ${what}`)
    }
    const left = new Map<string, number>()
    for (const l of returnableLines(tx, returnOf.id)) {
      left.set(l.variantId, (left.get(l.variantId) ?? 0) + l.remainingMilli)
    }
    for (const l of input.lines) {
      const remaining = (left.get(l.variantId) ?? 0) - l.qtyMilli
      if (remaining < 0) {
        throw new PostingError(
          "NOT_RETURNABLE",
          `De ${l.variantId} no se puede devolver más de lo que se ${of === "SALE" ? "vendió" : "compró"} y no se ha devuelto`,
        )
      }
      left.set(l.variantId, remaining)
    }
  }
  const creditMinor = input.creditMinor ?? 0
  // Una deuda en bolívares se devalúa: por defecto se lleva en la moneda de referencia.
  // Una deuda manual se lleva en la moneda en que se anotó.
  const creditCurrency =
    input.type === "DEBT_IN" || input.type === "DEBT_OUT"
      ? input.currency
      : (input.creditCurrency ?? biz.referenceCurrency)
  const allocations = input.allocations ?? []
  if (input.type === "SALE" && creditMinor > 0) {
    if (!ctx.creditEnabled) {
      throw new PostingError("CREDIT_DENIED", "El fiado está desactivado en Ajustes")
    }
    if (!party || party.kind === "supplier") {
      throw new PostingError("CREDIT_DENIED", "Elige el cliente al que le fías")
    }
    if (party.creditLimitMinor !== null) {
      const owed = owedInReference(
        [
          ...openSales(tx, { contactId: party.id }),
          { currency: creditCurrency, outstandingMinor: creditMinor, rate: docRate },
        ],
        biz.referenceCurrency,
        book,
      )
      if (owed > party.creditLimitMinor) {
        throw new PostingError("CREDIT_DENIED", "Con esta venta supera su límite de crédito")
      }
    }
  }
  // Una deuda manual es de un cliente (lo que nos debe) o de un proveedor (lo que le debemos).
  if (input.type === "DEBT_IN" && (!party || party.kind === "supplier")) {
    throw new PostingError("CREDIT_DENIED", "Elige el cliente que debe")
  }
  if (input.type === "DEBT_OUT" && (!party || party.kind === "customer")) {
    throw new PostingError("CREDIT_DENIED", "Elige el proveedor al que le debes")
  }
  // Lo que se le debe a un proveedor: una compra o un gasto a deber exige a quién se le debe.
  if ((input.type === "PURCHASE" || input.type === "EXPENSE") && creditMinor > 0) {
    if (!party || party.kind === "customer") {
      throw new PostingError("CREDIT_DENIED", "Elige el proveedor al que le debes")
    }
  }
  if (input.type === "PAYMENT_OUT") {
    if (!party || party.kind === "customer") {
      throw new PostingError("INVALID_ALLOCATION", "Elige el proveedor al que le pagas")
    }
    const open = new Map(
      (allocations.length === 0
        ? []
        : openPayables(tx, { contactId: party.id, ids: allocations.map((a) => a.saleDocumentId) })
      ).map((doc) => [doc.id, doc]),
    )
    for (const a of allocations) {
      const owed = open.get(a.saleDocumentId)
      if (!owed) {
        throw new PostingError(
          "INVALID_ALLOCATION",
          `${a.saleDocumentId} no es una compra o un gasto a deber pendiente de este proveedor`,
        )
      }
      if (owed.currency !== input.currency) {
        throw new PostingError(
          "CURRENCY_MISMATCH",
          `${owed.number} se debe en ${owed.currency}: el pago va en esa moneda`,
        )
      }
      if (a.amountMinor > owed.outstandingMinor) {
        throw new PostingError(
          "INVALID_ALLOCATION",
          `${owed.number} solo debe ${owed.outstandingMinor} (unidades menores)`,
        )
      }
    }
  }
  if (input.type === "PAYMENT_IN") {
    if (!party || party.kind === "supplier") {
      throw new PostingError("INVALID_ALLOCATION", "Elige el cliente que paga")
    }
    const open = new Map(
      (allocations.length === 0
        ? []
        : openSales(tx, { contactId: party.id, ids: allocations.map((a) => a.saleDocumentId) })
      ).map((sale) => [sale.id, sale]),
    )
    for (const a of allocations) {
      const sale = open.get(a.saleDocumentId)
      if (!sale) {
        throw new PostingError(
          "INVALID_ALLOCATION",
          `La venta ${a.saleDocumentId} no es una venta a crédito pendiente de este cliente`,
        )
      }
      if (sale.currency !== input.currency) {
        throw new PostingError(
          "CURRENCY_MISMATCH",
          `${sale.number} se debe en ${sale.currency}: el abono va en esa moneda`,
        )
      }
      if (a.amountMinor > sale.outstandingMinor) {
        throw new PostingError(
          "INVALID_ALLOCATION",
          `${sale.number} solo debe ${sale.outstandingMinor} (unidades menores)`,
        )
      }
    }
  }
  // Una devolución puede descontarse de lo que se debe de ese mismo documento: lo que el cliente
  // debe de la venta, o lo que se le debe al proveedor de la compra.
  let allocationCurrency: CurrencyCode | undefined
  if (isReturn(input.type) && allocations.length > 0) {
    const what = input.type === "RETURN" ? "venta" : "compra"
    if (!party || party.id !== returnOf?.contactId) {
      throw new PostingError(
        "INVALID_ALLOCATION",
        `Solo se descuenta de la deuda con el contacto de la ${what} devuelta`,
      )
    }
    if (allocations.some((a) => a.saleDocumentId !== returnOf?.id)) {
      throw new PostingError(
        "INVALID_ALLOCATION",
        `Solo se descuenta de la deuda de la ${what} devuelta`,
      )
    }
    const owed = (input.type === "RETURN" ? openSales : openPayables)(tx, {
      contactId: party.id,
      ids: [returnOf.id],
    })[0]
    const wanted = allocations[0]?.amountMinor ?? 0
    if (!owed || wanted > owed.outstandingMinor) {
      throw new PostingError(
        "INVALID_ALLOCATION",
        `La ${what} solo debe ${owed?.outstandingMinor ?? 0} (unidades menores)`,
      )
    }
    allocationCurrency = owed.currency
  }
  const surchargeOf = (methodId: string) => {
    const m = methods.get(methodId)
    // Los recargos (IGTF) los percibe quien vende: en ventas y en los abonos que cobra.
    return (input.type === "SALE" || input.type === "PAYMENT_IN") &&
      m?.surchargeId &&
      m.surchargeActive
      ? { surchargeId: m.surchargeId, rateBp: m.surchargeRateBp ?? 0 }
      : null
  }
  // Una cotización se vende una sola vez, y solo mientras esté abierta.
  if (input.quoteId) {
    const q = tx.select().from(quote).where(eq(quote.id, input.quoteId)).get()
    if (input.type !== "SALE" || !q) {
      throw new PostingError("UNKNOWN_REFERENCE", "Solo una venta sale de una cotización")
    }
    if (q.status !== "open") {
      throw new PostingError("QUOTE_CLOSED", `La cotización ${q.number} ya no está abierta`)
    }
  }
  const tabTaken = checkTabPayment(tx, input)
  // La propina es de una venta y, si es para alguien, para un usuario activo.
  const tipMinor = input.tipMinor ?? 0
  if (input.tipUserId) {
    if (input.type !== "SALE" || tipMinor <= 0) {
      throw new PostingError("INVALID_PAYMENT", "Solo una venta con propina dice para quién es")
    }
    const who = tx
      .select({ active: user.active })
      .from(user)
      .where(eq(user.id, input.tipUserId))
      .get()
    if (!who?.active) {
      throw new PostingError("UNKNOWN_REFERENCE", "La propina es para alguien que no está activo")
    }
  }
  // Opciones y extras: solo en ventas, y las que el producto ofrece.
  if (input.type !== "SALE" && input.lines.some((l) => l.modifierIds?.length || l.note)) {
    throw new PostingError("INVALID_LINE", "Solo una venta lleva opciones o indicaciones")
  }
  const picks =
    input.type === "SALE" ? pickModifiers(tx, input.lines, { asOrdered: !!input.tab }) : []
  // Platos con receta: al venderlos se gastan sus ingredientes (y de ahí sale su costo). Lo que se
  // produce por tandas gasta los suyos al producirse.
  const recipes =
    input.type === "SALE"
      ? recipesOf(tx, variantIds, false)
      : input.type === "PRODUCTION"
        ? recipesOf(tx, variantIds, true)
        : new Map<string, Ingredient[]>()
  if (input.type === "PRODUCTION") {
    for (const id of variantIds) {
      if (!recipes.has(id)) {
        throw new PostingError(
          "INVALID_LINE",
          `${variantName(tx, id)} no tiene receta: anota sus ingredientes en su ficha`,
        )
      }
    }
  }
  // Recargos de venta: el porcentaje y el IVA salen de su configuración, nunca del cliente; el
  // monto de uno fijo lo puede cambiar quien vende (el delivery varía según la distancia).
  const chargeInputs = input.charges ?? []
  if (chargeInputs.length && input.type !== "SALE") {
    throw new PostingError("INVALID_LINE", "Solo una venta lleva recargos (delivery, servicio…)")
  }
  const chargeRows = new Map(
    (chargeInputs.length === 0
      ? []
      : tx
          .select()
          .from(saleCharge)
          .where(
            inArray(
              saleCharge.id,
              chargeInputs.map((c) => c.chargeId),
            ),
          )
          .all()
    ).map((c) => [c.id, c]),
  )
  const chargeTaxIds = charged
    ? [...new Set([...chargeRows.values()].flatMap((c) => (c.taxId ? [c.taxId] : [])))]
    : []
  const chargeTaxes = new Map(
    (chargeTaxIds.length === 0
      ? []
      : tx.select().from(tax).where(inArray(tax.id, chargeTaxIds)).all()
    ).map((t) => [t.id, t]),
  )
  const suggestedInDocument = (row: typeof saleCharge.$inferSelect): number => {
    const from = row.currency ?? input.currency
    if (from === input.currency) return row.amountMinor
    const base = docRate && book[docRate.base]
    const quote = docRate && book[docRate.quote]
    const covers =
      docRate &&
      ((docRate.base === from && docRate.quote === input.currency) ||
        (docRate.quote === from && docRate.base === input.currency))
    if (!docRate || !base || !quote || !covers) {
      throw new PostingError(
        "MISSING_RATE",
        `El recargo «${row.name}» necesita la tasa para su monto`,
      )
    }
    return convert(money(row.amountMinor, from), docRate, { base, quote }).amountMinor
  }
  const charges: DraftCharge[] = chargeInputs.map((ci) => {
    const row = chargeRows.get(ci.chargeId)
    if (!row?.active) {
      throw new PostingError("UNKNOWN_REFERENCE", `Recargo desconocido o inactivo: ${ci.chargeId}`)
    }
    const t = row.taxId ? chargeTaxes.get(row.taxId) : undefined
    return {
      chargeId: row.id,
      name: row.name,
      kind: row.kind,
      rateBp: row.rateBp,
      amountMinor: row.kind === "fixed" ? (ci.amountMinor ?? suggestedInDocument(row)) : 0,
      tax: t ? { taxId: t.id, kind: t.kind, rateBp: t.rateBp } : null,
    }
  })
  const draft: DocumentDraft = {
    id: input.id,
    type: input.type,
    currency: input.currency,
    legalCurrency: biz.legalCurrency,
    rate: docRate,
    locationId,
    ...(toLocationId ? { toLocationId } : {}),
    pricesIncludeTax:
      input.pricesIncludeTax ?? (input.type === "SALE" ? fiscal.pricesIncludeTax : false),
    lines: input.lines.map((l) => ({
      variantId: l.variantId,
      qtyMilli: l.qtyMilli,
      unitPriceMinor: l.unitPriceMinor,
      discountMinor: l.discountMinor ?? 0,
      tracksStock: variants.get(l.variantId)?.tracksStock ?? false,
      tax: lineTax(l),
    })),
    payments: input.payments.map((p) => ({
      id: p.id,
      methodId: p.paymentMethodId,
      accountId: methods.get(p.paymentMethodId)?.accountId ?? "",
      currency: p.currency,
      amountMinor: p.amountMinor,
      rate: p.rate && exchangeRate(p.rate.base, p.rate.quote, p.rate.value),
      reference: p.reference ?? null,
      surcharge: surchargeOf(p.paymentMethodId),
    })),
    creditMinor,
    creditCurrency,
    allocations,
    ...(allocationCurrency ? { allocationCurrency } : {}),
    ...(input.type === "EXPENSE" || input.type === "DEBT_IN" || input.type === "DEBT_OUT"
      ? { amountMinor: input.amountMinor ?? 0 }
      : {}),
    ...(charges.length ? { charges } : {}),
    ...(tipMinor ? { tipMinor } : {}),
  }
  const plan = planPosting(draft, book)
  const convertCost = rateConverter(docRate, book)
  const discountCodeId = input.discountCodeId
    ? checkDiscountCode(tx, input, plan.lines, {
        today: localDate(ctx.now, biz.timezone),
        docRate,
        book,
      })
    : null
  // Una compra o un gasto a deber puede traer su fecha límite; si no, los días que da el proveedor.
  const explicitDue = input.type === "SALE" ? null : (input.dueAt ?? null)
  const dueAt =
    plan.creditMinor > 0
      ? (explicitDue ?? (party?.creditDays ? ctx.now + party.creditDays * DAY_MS : null))
      : null

  const number = formatDocumentNumber(term.code, input.type, nextNumber(tx, term.id, input.type))
  tx.insert(document)
    .values({
      id: input.id,
      type: input.type,
      number,
      terminalId: term.id,
      locationId,
      toLocationId,
      currency: input.currency,
      legalCurrency: biz.legalCurrency,
      // En un documento en moneda legal la tasa no convierte nada, pero se guarda como
      // referencia: la factura en Bs debe mostrar la tasa del día y el equivalente en divisas.
      ...rateColumns(docRate),
      pricesIncludeTax: draft.pricesIncludeTax,
      shiftId,
      contactId: input.contactId ?? null,
      returnsDocumentId: isReturn(input.type) ? (returnOf?.id ?? null) : null,
      expenseCategoryId,
      stockReasonId,
      discountCodeId,
      tipMinor: plan.tipMinor,
      tipLegalMinor: plan.tipLegalMinor,
      tipUserId: plan.tipMinor > 0 ? (input.tipUserId ?? null) : null,
      discountMinor: plan.discountMinor,
      discountLegalMinor: plan.discountLegalMinor,
      creditMinor: plan.creditMinor,
      creditCurrency: plan.creditCurrency,
      creditLegalMinor: plan.creditLegalMinor,
      dueAt,
      externalRef: input.externalRef?.trim() || null,
      totalMinor: plan.totalMinor,
      totalLegalMinor: plan.totalLegalMinor,
      surchargeMinor: plan.surchargeMinor,
      surchargeLegalMinor: plan.surchargeLegalMinor,
      note: input.note ?? null,
      createdBy: ctx.actorId,
      postedAt: ctx.now,
      createdAt: ctx.now,
    })
    .run()

  const returnedCosts = returnOf
    ? new Map(
        tx
          .select({
            variantId: documentLine.variantId,
            costMinor: documentLine.costMinor,
            costCurrency: documentLine.costCurrency,
          })
          .from(documentLine)
          .where(eq(documentLine.documentId, returnOf.id))
          .all()
          .map((r) => [r.variantId, r]),
      )
    : undefined
  const lineIds = new Map<number, string>()
  for (const l of plan.lines) {
    const id = uuidv7(ctx.now)
    lineIds.set(l.lineNo, id)
    // Lo que vale la mercancía que se vende o se ajusta, congelado: base de pérdidas y utilidad. Lo
    // devuelto vale lo que costó al venderse, no el costo de hoy.
    const recipe = recipes.get(l.variantId)
    const cost = recipe
      ? recipeCost(recipe, convertCost)
      : input.type === "SALE" || input.type === "ADJUSTMENT" || input.type === "STOCK_TRANSFER"
        ? variants.get(l.variantId)
        : returnedCosts?.get(l.variantId)
    tx.insert(documentLine)
      .values({
        id,
        documentId: input.id,
        ...l,
        costMinor: cost?.costMinor ?? null,
        costCurrency: cost?.costMinor == null ? null : cost.costCurrency,
        modifiers: picks[l.lineNo - 1] ?? null,
        note: input.type === "SALE" ? input.lines[l.lineNo - 1]?.note?.trim() || null : null,
      })
      .run()
  }
  insertBreakdown(tx, input.id, ctx.now, plan.taxes, plan.surcharges)
  if (input.quoteId) {
    tx.update(quote)
      .set({ status: "converted", documentId: input.id, closedAt: ctx.now })
      .where(eq(quote.id, input.quoteId))
      .run()
  }
  if (input.tab && tabTaken) settleTab(tx, input.tab.id, tabTaken, input.id, ctx.now)
  for (const c of plan.charges) {
    tx.insert(documentCharge)
      .values({ id: uuidv7(ctx.now), documentId: input.id, ...c })
      .run()
  }
  if (input.type === "PURCHASE") updateLastCosts(tx, plan.lines, draft, ctx)
  // Lo producido queda con el costo de su receta (como el último costo de una compra).
  if (input.type === "PRODUCTION") {
    for (const l of plan.lines) {
      const recipe = recipes.get(l.variantId)
      const cost = recipe && recipeCost(recipe, convertCost)
      if (!cost) continue
      tx.update(variant)
        .set({ costMinor: cost.costMinor, costCurrency: cost.costCurrency })
        .where(eq(variant.id, l.variantId))
        .run()
    }
  }

  // Lo que cada cobro le cuesta al comercio: la cuenta recibe el pago menos esa comisión.
  const commissions = new Map<string, number>()
  for (const p of draft.payments) {
    const bp = methods.get(p.methodId)?.commissionBp ?? 0
    // Solo los cobros a clientes (ventas y abonos) pagan comisión: no el vuelto, ni las devoluciones.
    const commission =
      input.type === "SALE" || input.type === "PAYMENT_IN" ? commissionMinor(p.amountMinor, bp) : 0
    if (commission > 0) commissions.set(p.id, commission)
    tx.insert(payment)
      .values({
        id: p.id,
        documentId: input.id,
        paymentMethodId: p.methodId,
        accountId: p.accountId,
        currency: p.currency,
        amountMinor: p.amountMinor,
        ...rateColumns(p.rate),
        reference: p.reference,
        surchargeId: p.surcharge?.surchargeId ?? null,
        surchargeRateBp: p.surcharge?.rateBp ?? 0,
        commissionRateBp: commission > 0 ? bp : 0,
        commissionMinor: commission,
      })
      .run()
  }

  for (const a of plan.allocations) {
    tx.insert(allocation)
      .values({
        id: uuidv7(ctx.now),
        paymentDocumentId: input.id,
        saleDocumentId: a.saleDocumentId,
        amountMinor: a.amountMinor,
      })
      .run()
  }

  // Los productos con lotes reparten cada movimiento entre sus lotes: lo que entra va al lote de la
  // compra (o del ajuste), lo que sale sale primero del que vence antes, lo devuelto regresa a los
  // lotes de donde salió y un traslado lleva al destino los mismos lotes que sacó del origen. Cada
  // parte se aplica antes de repartir la siguiente: dos líneas del mismo producto no se pisan.
  const today = localDate(ctx.now, biz.timezone)
  const saleable = input.type === "SALE" || input.type === "STOCK_TRANSFER"
  const sentByLine = new Map<number, LotTake[]>()
  const splitOf = (m: PlannedStockMove): LotTake[] => {
    const line = input.lines[m.lineNo - 1]
    if (!variants.get(m.variantId)?.tracksLots || !line) {
      return [{ lotId: null, qtyMilli: m.qtyMilli }]
    }
    if (m.qtyMilli < 0) {
      let out: LotTake[]
      if (input.type === "PURCHASE_RETURN" && returnOf) {
        // Al proveedor se le devuelve de los lotes que trajo esa compra; lo que falte, del que
        // vence primero.
        out = []
        let left = -m.qtyMilli
        for (const t of purchaseLots(tx, returnOf.id, m.variantId, m.locationId)) {
          if (left <= 0) break
          const qty = Math.min(left, t.qtyMilli)
          out.push({ lotId: t.lotId, qtyMilli: -qty })
          left -= qty
        }
        if (left > 0) {
          for (const t of allocateOut(tx, m.variantId, m.locationId, left, today, false)) {
            out.push({ lotId: t.lotId, qtyMilli: -t.qtyMilli })
          }
        }
      } else if (line.lotId) {
        const left = lotQty(tx, line.lotId, m.locationId)
        if (left < -m.qtyMilli) {
          throw new PostingError(
            "INSUFFICIENT_STOCK",
            `Del lote elegido solo quedan ${left / 1000} en esa ubicación`,
          )
        }
        out = [{ lotId: line.lotId, qtyMilli: m.qtyMilli }]
      } else {
        out = allocateOut(tx, m.variantId, m.locationId, -m.qtyMilli, today, saleable).map((t) => ({
          lotId: t.lotId,
          qtyMilli: -t.qtyMilli,
        }))
      }
      sentByLine.set(m.lineNo, out)
      return out
    }
    if (input.type === "STOCK_TRANSFER") {
      return (sentByLine.get(m.lineNo) ?? []).map((t) => ({
        lotId: t.lotId,
        qtyMilli: -t.qtyMilli,
      }))
    }
    if (line.lot) {
      const lotId = lotFor(tx, {
        variantId: m.variantId,
        code: line.lot.code?.trim() || null,
        expiresOn: line.lot.expiresOn,
        documentId: input.id,
        now: ctx.now,
      })
      return [{ lotId, qtyMilli: m.qtyMilli }]
    }
    if (line.lotId) return [{ lotId: line.lotId, qtyMilli: m.qtyMilli }]
    if (input.type === "RETURN" && returnOf) {
      const out: LotTake[] = []
      let left = m.qtyMilli
      for (const t of returnableLots(tx, returnOf.id, m.variantId)) {
        if (left <= 0) break
        const qty = Math.min(left, t.qtyMilli)
        out.push({ lotId: t.lotId, qtyMilli: qty })
        left -= qty
      }
      if (left > 0) out.push({ lotId: null, qtyMilli: left })
      return out
    }
    return [{ lotId: null, qtyMilli: m.qtyMilli }]
  }
  for (const m of plan.stockMoves) {
    for (const part of splitOf(m)) {
      const move = { variantId: m.variantId, locationId: m.locationId, qtyMilli: part.qtyMilli }
      tx.insert(stockMove)
        .values({
          id: uuidv7(ctx.now),
          documentId: input.id,
          documentLineId: lineIds.get(m.lineNo) ?? "",
          ...move,
          lotId: part.lotId,
          createdAt: ctx.now,
        })
        .run()
      applyStockMove(tx, move, ctx)
      if (part.lotId) {
        applyLotMove(
          tx,
          { lotId: part.lotId, locationId: m.locationId, qtyMilli: part.qtyMilli },
          ctx.allowNegativeStock,
        )
      }
    }
  }

  // Lo que se gasta de cada ingrediente sale de la ubicación de la venta o la producción (con lotes,
  // del que vence primero), con la merma de la receta; queda ligado a la línea del plato.
  for (const l of plan.lines) {
    for (const item of recipes.get(l.variantId) ?? []) {
      const qty = ingredientQty(l.qtyMilli, item)
      if (qty <= 0) continue
      const parts: LotTake[] = item.tracksLots
        ? allocateOut(tx, item.ingredientId, locationId, qty, today, false).map((t) => ({
            lotId: t.lotId,
            qtyMilli: -t.qtyMilli,
          }))
        : [{ lotId: null, qtyMilli: -qty }]
      for (const part of parts) {
        const move = { variantId: item.ingredientId, locationId, qtyMilli: part.qtyMilli }
        tx.insert(stockMove)
          .values({
            id: uuidv7(ctx.now),
            documentId: input.id,
            documentLineId: lineIds.get(l.lineNo) ?? "",
            ...move,
            lotId: part.lotId,
            createdAt: ctx.now,
          })
          .run()
        applyStockMove(tx, move, ctx)
        if (part.lotId) {
          applyLotMove(
            tx,
            { lotId: part.lotId, locationId, qtyMilli: part.qtyMilli },
            ctx.allowNegativeStock,
          )
        }
      }
    }
  }

  for (const m of plan.accountMoves) {
    tx.insert(accountMove)
      .values({
        id: uuidv7(ctx.now),
        documentId: input.id,
        paymentId: m.paymentId,
        accountId: m.accountId,
        amountMinor: m.amountMinor,
        createdAt: ctx.now,
      })
      .run()
    applyAccountMove(tx, m.accountId, m.amountMinor)
  }
  for (const p of draft.payments) {
    const commission = commissions.get(p.id)
    if (!commission) continue
    tx.insert(accountMove)
      .values({
        id: uuidv7(ctx.now),
        documentId: input.id,
        paymentId: p.id,
        accountId: p.accountId,
        amountMinor: -commission,
        createdAt: ctx.now,
      })
      .run()
    applyAccountMove(tx, p.accountId, -commission)
  }

  record(tx, ctx, "document.posted", {
    id: input.id,
    type: input.type,
    number,
    totalMinor: plan.totalMinor,
    surchargeMinor: plan.surchargeMinor,
  })
  return {
    id: input.id,
    number,
    totalMinor: plan.totalMinor,
    totalLegalMinor: plan.totalLegalMinor,
    surchargeMinor: plan.surchargeMinor,
    surchargeLegalMinor: plan.surchargeLegalMinor,
    taxes: plan.taxes,
    surcharges: plan.surcharges,
    creditMinor: plan.creditMinor,
    creditCurrency: plan.creditCurrency,
    dueAt,
    duplicate: false,
  }
}

/**
 * Valida el código de descuento de una venta: activo, vigente hoy y con usos disponibles. Si quien
 * vende no puede dar descuentos a mano, los descuentos de la venta no pasan de lo que da el código
 * (un porcentaje del ticket o un monto fijo llevado a la moneda de la venta). Devuelve su id.
 */
function checkDiscountCode(
  tx: Tx,
  input: PostDocumentInput,
  lines: readonly PlannedLine[],
  opts: { today: string; docRate: ExchangeRate | null; book: CurrencyBook },
): string {
  if (input.type !== "SALE") {
    throw new PostingError("INVALID_LINE", "Solo una venta lleva código de descuento")
  }
  const code = tx
    .select()
    .from(discountCode)
    .where(eq(discountCode.id, input.discountCodeId ?? ""))
    .get()
  if (!code?.active) {
    throw new PostingError(
      "UNKNOWN_REFERENCE",
      "El código de descuento no existe o está desactivado",
    )
  }
  if (
    (code.validFrom && opts.today < code.validFrom) ||
    (code.validUntil && opts.today > code.validUntil)
  ) {
    throw new PostingError("DISCOUNT_DENIED", `El código ${code.code} no está vigente hoy`)
  }
  if (code.maxUses !== null && discountCodeUses(tx, code.id) >= code.maxUses) {
    throw new PostingError("DISCOUNT_DENIED", `El código ${code.code} ya se usó todas las veces`)
  }
  if (input.discountFromCodeOnly) {
    const pool = lines.reduce((acc, l) => acc + lineTotal(l.qtyMilli, l.unitPriceMinor), 0)
    let allowed: number
    if (code.kind === "percent") {
      // El mismo redondeo que la caja: la mitad hacia arriba.
      allowed = commissionMinor(pool, code.rateBp)
    } else {
      const from = code.currency ?? input.currency
      const rate = opts.docRate
      const base = rate ? opts.book[rate.base] : undefined
      const quote = rate ? opts.book[rate.quote] : undefined
      if (from === input.currency) {
        allowed = code.amountMinor
      } else if (rate && base && quote && (rate.base === from || rate.quote === from)) {
        allowed = convert(money(code.amountMinor, from), rate, { base, quote }).amountMinor
      } else {
        throw new PostingError("MISSING_RATE", `El código ${code.code} necesita la tasa del día`)
      }
    }
    const given = lines.reduce((acc, l) => acc + l.discountMinor, 0)
    if (given > Math.min(pool, allowed)) {
      throw new PostingError(
        "DISCOUNT_DENIED",
        `El código ${code.code} no da tanto descuento: pide a quien pueda dar descuentos`,
      )
    }
  }
  return code.id
}

/** Ventas vigentes que usaron un código (sin reversos ni anuladas). */
export function discountCodeUses(db: Pick<Db, "select">, codeId: string): number {
  const reversal = alias(document, "reversal")
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(document)
      .leftJoin(reversal, eq(reversal.reversesDocumentId, document.id))
      .where(
        and(
          eq(document.discountCodeId, codeId),
          isNull(document.reversesDocumentId),
          isNull(reversal.id),
        ),
      )
      .get()?.n ?? 0
  )
}

/**
 * Anula un documento contabilizado generando un documento de reverso con todo en signo
 * contrario. El original no se toca. Solo se puede anular una vez y un reverso no se anula.
 * `reversalId` es un UUIDv7 del cliente, así que reintentar es idempotente.
 */
export function voidDocument(
  db: Db,
  originalId: string,
  reversalId: string,
  ctx: PostContext,
  reason: string | null = null,
): PostedDocument {
  if (!isUuidv7(reversalId)) {
    throw new PostingError("UNKNOWN_REFERENCE", "El id del reverso debe ser un UUIDv7")
  }

  return db.transaction(
    (tx) => {
      const existing = tx.select().from(document).where(eq(document.id, reversalId)).get()
      if (existing) {
        return existingResult(tx, existing, existing.reversesDocumentId === originalId, "reverso")
      }

      const original = tx.select().from(document).where(eq(document.id, originalId)).get()
      if (!original) {
        throw new PostingError("UNKNOWN_REFERENCE", `Documento desconocido: ${originalId}`)
      }
      if (original.reversesDocumentId) {
        throw new PostingError("NOT_REVERSIBLE", "Un documento de reverso no se puede anular")
      }
      const already = tx
        .select({ id: document.id })
        .from(document)
        .where(eq(document.reversesDocumentId, originalId))
        .get()
      if (already) {
        throw new PostingError("ALREADY_REVERSED", `El documento ${original.number} ya fue anulado`)
      }

      if (
        (original.type === "SALE" || original.type === "PURCHASE") &&
        activeReturns(tx, original.id) > 0
      ) {
        throw new PostingError(
          "HAS_RETURNS",
          `${original.number} tiene devoluciones: anúlalas primero`,
        )
      }
      if (
        (original.type === "SALE" || original.type === "DEBT_IN") &&
        original.creditMinor > 0 &&
        collectedOn(tx, original.id) !== 0
      ) {
        throw new PostingError(
          "HAS_COLLECTIONS",
          `La venta ${original.number} ya tiene abonos: anúlalos primero`,
        )
      }
      if (
        (original.type === "PURCHASE" ||
          original.type === "EXPENSE" ||
          original.type === "DEBT_OUT") &&
        original.creditMinor > 0 &&
        collectedOn(tx, original.id) !== 0
      ) {
        throw new PostingError(
          "HAS_PAYMENTS",
          `${original.number} ya tiene pagos aplicados: anúlalos primero`,
        )
      }

      const number = formatDocumentNumber(
        tx
          .select({ code: terminal.code })
          .from(terminal)
          .where(eq(terminal.id, original.terminalId))
          .get()?.code ?? "",
        original.type,
        nextNumber(tx, original.terminalId, original.type),
      )
      const reversal = {
        ...original,
        id: reversalId,
        number,
        totalMinor: negate(original.totalMinor),
        totalLegalMinor: negate(original.totalLegalMinor),
        surchargeMinor: negate(original.surchargeMinor),
        surchargeLegalMinor: negate(original.surchargeLegalMinor),
        discountMinor: negate(original.discountMinor),
        discountLegalMinor: negate(original.discountLegalMinor),
        creditMinor: negate(original.creditMinor),
        creditLegalMinor: negate(original.creditLegalMinor),
        tipMinor: negate(original.tipMinor),
        tipLegalMinor: negate(original.tipLegalMinor),
        // El reverso pertenece al turno en que se anula: de esa gaveta sale o entra el dinero.
        shiftId: openShiftOf(tx, original.terminalId),
        reversesDocumentId: original.id,
        note: reason,
        createdBy: ctx.actorId,
        postedAt: ctx.now,
        createdAt: ctx.now,
      }
      tx.insert(document).values(reversal).run()

      const breakdown = loadBreakdown(tx, original.id)
      insertBreakdown(
        tx,
        reversalId,
        ctx.now,
        breakdown.taxes.map((t) => ({
          ...t,
          baseMinor: negate(t.baseMinor),
          taxMinor: negate(t.taxMinor),
          baseLegalMinor: negate(t.baseLegalMinor),
          taxLegalMinor: negate(t.taxLegalMinor),
        })),
        breakdown.surcharges.map((s) => ({
          ...s,
          baseMinor: negate(s.baseMinor),
          amountMinor: negate(s.amountMinor),
          baseLegalMinor: negate(s.baseLegalMinor),
          amountLegalMinor: negate(s.amountLegalMinor),
        })),
      )

      const lineIds = new Map<string, string>()
      for (const l of tx
        .select()
        .from(documentLine)
        .where(eq(documentLine.documentId, original.id))
        .orderBy(asc(documentLine.lineNo))
        .all()) {
        const id = uuidv7(ctx.now)
        lineIds.set(l.id, id)
        tx.insert(documentLine)
          .values({
            ...l,
            id,
            documentId: reversalId,
            qtyMilli: -l.qtyMilli,
            discountMinor: negate(l.discountMinor),
            lineTotalMinor: negate(l.lineTotalMinor),
          })
          .run()
      }

      // Los recargos (delivery, servicio) se devuelven con la venta.
      for (const c of tx
        .select()
        .from(documentCharge)
        .where(eq(documentCharge.documentId, original.id))
        .orderBy(asc(documentCharge.position))
        .all()) {
        tx.insert(documentCharge)
          .values({
            ...c,
            id: uuidv7(ctx.now),
            documentId: reversalId,
            baseMinor: negate(c.baseMinor),
            amountMinor: negate(c.amountMinor),
            amountLegalMinor: negate(c.amountLegalMinor),
          })
          .run()
      }

      const paymentIds = new Map<string, string>()
      for (const p of tx.select().from(payment).where(eq(payment.documentId, original.id)).all()) {
        const id = uuidv7(ctx.now)
        paymentIds.set(p.id, id)
        tx.insert(payment)
          .values({
            ...p,
            id,
            documentId: reversalId,
            amountMinor: -p.amountMinor,
            commissionMinor: negate(p.commissionMinor),
          })
          .run()
      }

      // Anular un abono vuelve a dejar a deber lo que había pagado.
      for (const a of tx
        .select()
        .from(allocation)
        .where(eq(allocation.paymentDocumentId, original.id))
        .all()) {
        tx.insert(allocation)
          .values({
            id: uuidv7(ctx.now),
            paymentDocumentId: reversalId,
            saleDocumentId: a.saleDocumentId,
            amountMinor: negate(a.amountMinor),
          })
          .run()
      }

      for (const m of tx
        .select()
        .from(stockMove)
        .where(eq(stockMove.documentId, original.id))
        .all()) {
        const reverse = {
          variantId: m.variantId,
          locationId: m.locationId,
          qtyMilli: -m.qtyMilli,
        }
        tx.insert(stockMove)
          .values({
            id: uuidv7(ctx.now),
            documentId: reversalId,
            documentLineId: lineIds.get(m.documentLineId) ?? "",
            ...reverse,
            lotId: m.lotId,
            createdAt: ctx.now,
          })
          .run()
        applyStockMove(tx, reverse, ctx)
        if (m.lotId) {
          applyLotMove(
            tx,
            { lotId: m.lotId, locationId: m.locationId, qtyMilli: -m.qtyMilli },
            ctx.allowNegativeStock,
          )
        }
      }

      for (const m of tx
        .select()
        .from(accountMove)
        .where(eq(accountMove.documentId, original.id))
        .all()) {
        tx.insert(accountMove)
          .values({
            id: uuidv7(ctx.now),
            documentId: reversalId,
            paymentId: paymentIds.get(m.paymentId) ?? "",
            accountId: m.accountId,
            amountMinor: -m.amountMinor,
            createdAt: ctx.now,
          })
          .run()
        applyAccountMove(tx, m.accountId, -m.amountMinor)
      }

      record(tx, ctx, "document.voided", {
        id: reversalId,
        type: original.type,
        number,
        totalMinor: reversal.totalMinor,
        surchargeMinor: reversal.surchargeMinor,
        reverses: original.id,
      })
      return resultOf(tx, reversal, false)
    },
    { behavior: "immediate" },
  )
}
