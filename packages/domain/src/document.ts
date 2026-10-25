import Big from "big.js"
import type { Currency, CurrencyCode } from "./currency"
import { money, roundToInteger } from "./money"
import { convert, convertExact, type ExchangeRate } from "./rate"
import {
  applyRate,
  computeSurcharges,
  computeTaxes,
  isValidLineTax,
  isValidRateBp,
  type LineTax,
  type PaymentSurcharge,
  type SurchargeGroup,
  type TaxGroup,
  type ToLegal,
} from "./tax"

export const DOCUMENT_TYPES = [
  "SALE",
  "RETURN",
  "PURCHASE",
  "TRANSFER",
  "ADJUSTMENT",
  "EXPENSE",
  "PAYMENT_IN",
  "PAYMENT_OUT",
  "CASH_IN",
  "CASH_OUT",
  "DEBT_IN",
  "DEBT_OUT",
  "STOCK_TRANSFER",
  "PURCHASE_RETURN",
  "PRODUCTION",
] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

/** Tipos que el motor de contabilización sabe procesar hoy. */
export const POSTABLE_TYPES = [
  "SALE",
  "PURCHASE",
  "ADJUSTMENT",
  "CASH_IN",
  "CASH_OUT",
  "PAYMENT_IN",
  "RETURN",
  "EXPENSE",
  "PAYMENT_OUT",
  "TRANSFER",
  "DEBT_IN",
  "DEBT_OUT",
  "STOCK_TRANSFER",
  "PURCHASE_RETURN",
  "PRODUCTION",
] as const
export type PostableType = (typeof POSTABLE_TYPES)[number]

export function isPostableType(type: string): type is PostableType {
  return (POSTABLE_TYPES as readonly string[]).includes(type)
}

/**
 * Devoluciones: de un cliente (`RETURN`, de una venta) o a un proveedor (`PURCHASE_RETURN`, de una
 * compra). Pueden descontarse de lo que se debe de ese documento en vez de mover dinero.
 */
export function isReturn(type: string): type is "RETURN" | "PURCHASE_RETURN" {
  return type === "RETURN" || type === "PURCHASE_RETURN"
}

/** Ingresos y retiros de caja: solo mueven dinero, sin líneas ni impuestos. */
export function isCashMovement(type: string): type is "CASH_IN" | "CASH_OUT" {
  return type === "CASH_IN" || type === "CASH_OUT"
}

export type PostingErrorCode =
  | "UNSUPPORTED_TYPE"
  | "EMPTY_DOCUMENT"
  | "INVALID_LINE"
  | "INVALID_PAYMENT"
  | "MISSING_RATE"
  | "CURRENCY_MISMATCH"
  | "UNSETTLED"
  | "UNKNOWN_REFERENCE"
  | "INSUFFICIENT_STOCK"
  | "ID_CONFLICT"
  | "ALREADY_REVERSED"
  | "NOT_REVERSIBLE"
  | "SHIFT_CLOSED"
  | "CREDIT_DENIED"
  | "INVALID_ALLOCATION"
  | "HAS_COLLECTIONS"
  | "NOT_RETURNABLE"
  | "HAS_RETURNS"
  | "HAS_PAYMENTS"
  | "QUOTE_CLOSED"
  | "DISCOUNT_DENIED"
  | "TAB_CHANGED"

export class PostingError extends Error {
  constructor(
    readonly code: PostingErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "PostingError"
  }
}

const SERIES_TAG: Record<DocumentType, string> = {
  SALE: "",
  RETURN: "DV",
  PURCHASE: "CM",
  TRANSFER: "TR",
  ADJUSTMENT: "AJ",
  EXPENSE: "GA",
  PAYMENT_IN: "AB",
  PAYMENT_OUT: "PG",
  CASH_IN: "IC",
  CASH_OUT: "RC",
  DEBT_IN: "CC",
  DEBT_OUT: "CP",
  STOCK_TRANSFER: "TL",
  PURCHASE_RETURN: "DC",
  PRODUCTION: "PR",
}

/** Número de documento en la serie de su terminal: C1-000123 (ventas) o C1-CM-000123 (compras). */
export function formatDocumentNumber(terminalCode: string, type: DocumentType, n: number): string {
  const tag = SERIES_TAG[type]
  const serial = String(n).padStart(6, "0")
  return tag ? `${terminalCode}-${tag}-${serial}` : `${terminalCode}-${serial}`
}

export type CurrencyBook = Readonly<Record<CurrencyCode, Currency>>

export interface DraftLine {
  variantId: string
  /** Cantidad en milésimas (1000 = 1 unidad). En ADJUSTMENT lleva signo. */
  qtyMilli: number
  unitPriceMinor: number
  /**
   * Descuento sobre la línea, en la moneda del documento (con el IVA incluido si los precios lo
   * incluyen): el total de la línea es cantidad × precio menos este monto. Solo en ventas.
   */
  discountMinor?: number
  /** Resuelto por quien arma el borrador: si es false (servicios) no mueve existencias. */
  tracksStock: boolean
  /** IVA de la línea, resuelto por el servidor (nunca lo elige el cliente); null = sin impuesto. */
  tax: LineTax | null
}

export interface DraftPayment {
  id: string
  methodId: string
  accountId: string
  currency: CurrencyCode
  /** En unidades menores de `currency`. Negativo = vuelto entregado. */
  amountMinor: number
  /** Obligatoria si `currency` difiere de la del documento. */
  rate: ExchangeRate | null
  reference: string | null
  /** Recargo del método de cobro (IGTF); solo se aplica en ventas. */
  surcharge: PaymentSurcharge | null
}

/**
 * Recargo de venta (delivery, servicio…). Uno fijo suma su monto como una línea más (con el IVA
 * incluido si los precios lo incluyen); uno porcentual se calcula sobre el subtotal sin IVA de las
 * líneas y, si lleva IVA, se le suma encima. Solo en ventas.
 */
export interface DraftCharge {
  chargeId: string
  name: string
  kind: "percent" | "fixed"
  /** Porcentual: centésimas de punto sobre el subtotal sin IVA. */
  rateBp: number
  /** Fijo: el monto en la moneda del documento. */
  amountMinor: number
  /** IVA del recargo, resuelto por el servidor; null = no lleva IVA. */
  tax: LineTax | null
}

export interface PlannedCharge {
  position: number
  chargeId: string
  name: string
  kind: "percent" | "fixed"
  rateBp: number
  /** Porcentual: el subtotal sin IVA sobre el que se calculó; fijo: 0. */
  baseMinor: number
  /** Lo que suma al documento, como el total de una línea. */
  amountMinor: number
  amountLegalMinor: number
  taxId: string | null
  taxRateBp: number
}

/** Parte de un abono que paga una venta a crédito, en la moneda de ambos documentos. */
export interface DraftAllocation {
  saleDocumentId: string
  amountMinor: number
}

export interface DocumentDraft {
  id: string
  type: DocumentType
  /** Moneda en la que se expresan líneas y total. */
  currency: CurrencyCode
  /** Moneda legal del negocio (VES); el documento guarda también su total en ella. */
  legalCurrency: CurrencyCode
  /** Tasa con la que se calcula el total en moneda legal si difiere de `currency`. */
  rate: ExchangeRate | null
  /** Ubicación cuya existencia mueve el documento (en un traslado, el origen). */
  locationId: string
  /** Traslado (`STOCK_TRANSFER`): la ubicación a la que llega la mercancía. */
  toLocationId?: string
  /** Si los precios de las líneas ya traen el IVA (precio de vitrina) o se le suma aparte. */
  pricesIncludeTax: boolean
  lines: readonly DraftLine[]
  payments: readonly DraftPayment[]
  /**
   * Venta a crédito (fiado): la parte que el cliente deja a deber, en `creditCurrency`. Los pagos
   * cubren el resto. Solo en ventas. Se trata como un pago en esa moneda: con una deuda en
   * dólares sobre un documento en bolívares, hace falta la tasa del documento.
   */
  creditMinor?: number
  /** Moneda de la deuda; si falta, la del documento. Normalmente la de referencia (USD). */
  creditCurrency?: CurrencyCode
  /**
   * Abono (`PAYMENT_IN`): qué ventas a crédito paga y cuánto de cada una. En una devolución
   * (`RETURN`): lo que se descuenta de la deuda de la venta devuelta en lugar de reembolsarlo.
   */
  allocations?: readonly DraftAllocation[]
  /** Moneda de las asignaciones de una devolución (la de la deuda de la venta). */
  allocationCurrency?: CurrencyCode
  /**
   * Gasto (`EXPENSE`): lo que costó, en la moneda del documento. No lleva líneas ni IVA: el total
   * es este monto y los pagos tienen que cubrirlo.
   */
  amountMinor?: number
  /** Recargos de venta (delivery, servicio…). Solo en ventas. */
  charges?: readonly DraftCharge[]
  /**
   * Venta: la propina que deja el cliente, en la moneda del documento. No es parte de la venta (no
   * lleva IVA ni IGTF, ni suma al total): los pagos la cubren además del total.
   */
  tipMinor?: number
}

export interface PlannedLine {
  lineNo: number
  variantId: string
  qtyMilli: number
  unitPriceMinor: number
  /** Descuento ya restado de `lineTotalMinor`. */
  discountMinor: number
  lineTotalMinor: number
  taxId: string | null
  taxRateBp: number
}

export interface PlannedStockMove {
  lineNo: number
  variantId: string
  locationId: string
  qtyMilli: number
}

export interface PlannedAccountMove {
  paymentId: string
  accountId: string
  currency: CurrencyCode
  amountMinor: number
}

export interface PostingPlan {
  lines: PlannedLine[]
  /** Total del documento: Σ (base + IVA) de cada alícuota. No incluye recargos. */
  totalMinor: number
  totalLegalMinor: number
  taxes: TaxGroup[]
  surcharges: SurchargeGroup[]
  /** Σ recargos (IGTF). Lo que se cobra es `totalMinor + surchargeMinor`. */
  surchargeMinor: number
  surchargeLegalMinor: number
  stockMoves: PlannedStockMove[]
  accountMoves: PlannedAccountMove[]
  /** Σ descuentos de las líneas, en la moneda del documento y en la legal. */
  discountMinor: number
  discountLegalMinor: number
  /** Lo que queda a deber (venta a crédito); 0 en los demás documentos. */
  creditMinor: number
  /** Moneda de la deuda; null si la venta no quedó a crédito. */
  creditCurrency: CurrencyCode | null
  creditLegalMinor: number
  /** Ventas que paga un abono, con el monto de cada una. */
  allocations: DraftAllocation[]
  /** Recargos de venta, ya calculados; los de monto cero no se guardan. */
  charges: PlannedCharge[]
  /** Propina de una venta, en la moneda del documento y en la legal; 0 en lo demás. */
  tipMinor: number
  tipLegalMinor: number
}

/**
 * Calcula los recargos de una venta. `lineTaxes` es el desglose de IVA de sus líneas (sin los
 * recargos): de ahí sale el subtotal sin IVA sobre el que se aplican los porcentuales.
 */
export function planCharges(
  charges: readonly DraftCharge[],
  lineTaxes: readonly TaxGroup[],
  pricesIncludeTax: boolean,
  toLegal: ToLegal,
): PlannedCharge[] {
  const subtotalBase = lineTaxes.reduce((acc, t) => acc + t.baseMinor, 0)
  const seen = new Set<string>()
  const out: PlannedCharge[] = []
  for (const c of charges) {
    if (seen.has(c.chargeId)) {
      throw new PostingError("INVALID_LINE", `El recargo «${c.name}» aparece dos veces`)
    }
    seen.add(c.chargeId)
    if (c.tax && !isValidLineTax(c.tax)) {
      throw new PostingError("INVALID_LINE", `Impuesto inválido en el recargo «${c.name}»`)
    }
    const taxRateBp = c.tax?.rateBp ?? 0
    let baseMinor = 0
    let amountMinor: number
    if (c.kind === "percent") {
      if (!Number.isSafeInteger(c.rateBp) || c.rateBp <= 0 || c.rateBp > 10_000) {
        throw new PostingError("INVALID_LINE", `Porcentaje inválido en el recargo «${c.name}»`)
      }
      baseMinor = subtotalBase
      const net = applyRate(subtotalBase, c.rateBp)
      amountMinor = pricesIncludeTax ? net + applyRate(net, taxRateBp) : net
    } else {
      if (!Number.isSafeInteger(c.amountMinor) || c.amountMinor < 0) {
        throw new PostingError("INVALID_LINE", `Monto inválido en el recargo «${c.name}»`)
      }
      amountMinor = c.amountMinor
    }
    if (amountMinor === 0) continue
    out.push({
      position: out.length + 1,
      chargeId: c.chargeId,
      name: c.name,
      kind: c.kind,
      rateBp: c.kind === "percent" ? c.rateBp : 0,
      baseMinor,
      amountMinor,
      amountLegalMinor: toLegal(amountMinor),
      taxId: c.tax?.taxId ?? null,
      taxRateBp,
    })
  }
  return out
}

/** Las líneas y los recargos de una venta, como entradas del desglose de IVA. */
export function taxEntries(
  lines: readonly { lineTotalMinor: number; tax: LineTax | null }[],
  charges: readonly { amountMinor: number; tax: LineTax | null }[],
): { lineTotalMinor: number; tax: LineTax | null }[] {
  return [...lines, ...charges.map((c) => ({ lineTotalMinor: c.amountMinor, tax: c.tax }))]
}

/**
 * Lo que se deja a deber (venta fiada, compra o gasto pendiente) cuenta como un pago en la moneda
 * de la deuda: se lleva a la del documento sin redondear y trae la misma holgura por redondeo que
 * cualquier pago en divisas. Nunca puede superar el total.
 */
function creditOf(draft: DocumentDraft, totalMinor: number, book: CurrencyBook) {
  const creditMinor = draft.creditMinor ?? 0
  if (!Number.isSafeInteger(creditMinor) || creditMinor < 0) {
    throw new PostingError("INVALID_PAYMENT", "El monto a crédito debe ser un entero no negativo")
  }
  const creditCurrency = draft.creditCurrency ?? draft.currency
  const credit =
    creditMinor > 0
      ? inDocumentCurrency(
          { currency: creditCurrency, amountMinor: creditMinor, rate: draft.rate },
          draft.currency,
          book,
        )
      : null
  if (credit?.amountMinor.minus(totalMinor).gt(credit.tolerance)) {
    throw new PostingError("INVALID_PAYMENT", "El monto a crédito no puede superar el total")
  }
  return {
    creditMinor,
    creditCurrency,
    /** El crédito como un pago más, para el cuadre. */
    asPayment:
      creditMinor > 0
        ? { currency: creditCurrency, amountMinor: creditMinor, rate: draft.rate }
        : null,
    creditDocMinor: credit ? roundToInteger(credit.amountMinor, "half-up") : 0,
  }
}

function currencyOf(book: CurrencyBook, code: CurrencyCode): Currency {
  const currency = book[code]
  if (!currency) throw new PostingError("CURRENCY_MISMATCH", `Moneda desconocida: ${code}`)
  return currency
}

function ratePair(rate: ExchangeRate, book: CurrencyBook) {
  return { base: currencyOf(book, rate.base), quote: currencyOf(book, rate.quote) }
}

function rateCovers(rate: ExchangeRate, a: CurrencyCode, b: CurrencyCode): boolean {
  return (rate.base === a && rate.quote === b) || (rate.base === b && rate.quote === a)
}

export interface SettlementPayment {
  currency: CurrencyCode
  amountMinor: number
  rate: ExchangeRate | null
}

export interface Settlement {
  /** Σ pagos (vuelto incluido, con signo) − total, exacto y en unidades menores del documento. */
  difference: Big
  /** Holgura por redondeo: media unidad menor de cada moneda extranjera, vista en la del documento. */
  tolerance: Big
  settled: boolean
}

/**
 * Invariante 5: Σ pagos − vuelto = total, con tolerancia de redondeo por moneda.
 * Los pagos en otra moneda se convierten sin redondear; cada uno aporta media unidad menor
 * de su propia moneda como holgura, porque eso es lo que el cliente pudo entregar.
 */
export function settle(
  docCurrency: CurrencyCode,
  totalMinor: number,
  payments: readonly SettlementPayment[],
  book: CurrencyBook,
): Settlement {
  let paid = new Big(0)
  let tolerance = new Big(0)
  for (const p of payments) {
    const converted = inDocumentCurrency(p, docCurrency, book)
    paid = paid.plus(converted.amountMinor)
    tolerance = tolerance.plus(converted.tolerance)
  }
  const difference = paid.minus(totalMinor)
  return { difference, tolerance, settled: difference.abs().lte(tolerance) }
}

/**
 * Un pago visto en la moneda del documento, sin redondear, y la holgura que aporta
 * (media unidad menor de su propia moneda).
 */
export function inDocumentCurrency(
  p: SettlementPayment,
  docCurrency: CurrencyCode,
  book: CurrencyBook,
): { amountMinor: Big; tolerance: Big } {
  if (p.currency === docCurrency)
    return { amountMinor: new Big(p.amountMinor), tolerance: new Big(0) }
  if (!p.rate) {
    throw new PostingError("MISSING_RATE", `El pago en ${p.currency} requiere una tasa`)
  }
  if (!rateCovers(p.rate, p.currency, docCurrency)) {
    throw new PostingError(
      "CURRENCY_MISMATCH",
      `La tasa ${p.rate.base}/${p.rate.quote} no relaciona ${p.currency} con ${docCurrency}`,
    )
  }
  const pair = ratePair(p.rate, book)
  return {
    amountMinor: convertExact(money(p.amountMinor, p.currency), p.rate, pair).amountMinor,
    tolerance: convertExact(money(1, p.currency), p.rate, pair).amountMinor.abs().div(2),
  }
}

/**
 * Conversión de la moneda del documento a la legal con la tasa del documento.
 * Identidad si el documento ya está en moneda legal.
 */
export function legalConverter(
  docCurrency: CurrencyCode,
  legalCurrency: CurrencyCode,
  rate: ExchangeRate | null,
  book: CurrencyBook,
): ToLegal {
  if (docCurrency === legalCurrency) return (amountMinor) => amountMinor
  if (!rate) {
    throw new PostingError("MISSING_RATE", "El documento requiere la tasa para su total legal")
  }
  if (!rateCovers(rate, docCurrency, legalCurrency)) {
    throw new PostingError(
      "CURRENCY_MISMATCH",
      `La tasa ${rate.base}/${rate.quote} no relaciona ${docCurrency} con ${legalCurrency}`,
    )
  }
  const pair = ratePair(rate, book)
  return (amountMinor) => convert(money(amountMinor, docCurrency), rate, pair).amountMinor
}

/** Total de una línea: cantidad (milésimas) × precio, redondeado a la unidad menor. */
export function lineTotal(qtyMilli: number, unitPriceMinor: number): number {
  return roundToInteger(new Big(qtyMilli).times(unitPriceMinor).div(1000), "half-up")
}

function validateLine(type: PostableType, line: DraftLine, n: number): void {
  const fail = (why: string) => {
    throw new PostingError("INVALID_LINE", `Línea ${n}: ${why}`)
  }
  if (!Number.isSafeInteger(line.qtyMilli) || line.qtyMilli === 0) {
    fail("la cantidad debe ser un entero distinto de cero")
  }
  if (!Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) {
    fail("el precio unitario debe ser un entero no negativo")
  }
  const discount = line.discountMinor ?? 0
  if (!Number.isSafeInteger(discount) || discount < 0) {
    fail("el descuento debe ser un entero no negativo")
  }
  if (discount > 0 && type !== "SALE" && type !== "RETURN") {
    fail("solo una venta admite descuentos")
  }
  if (discount > lineTotal(line.qtyMilli, line.unitPriceMinor)) {
    fail("el descuento no puede superar el importe de la línea")
  }
  if (type === "ADJUSTMENT") {
    if (line.unitPriceMinor !== 0) fail("un ajuste no lleva precio")
  } else if (line.qtyMilli < 0) {
    fail("la cantidad debe ser positiva")
  }
  if (line.tax && !isValidLineTax(line.tax)) fail(`impuesto inválido (${line.tax.taxId})`)
}

/**
 * Ingreso (CASH_IN) o retiro (CASH_OUT) de caja: fondo inicial, retiro para depositar, pago de
 * un gasto menor, sobrante o faltante del arqueo. Sin líneas; cada monto, positivo y en la moneda
 * del documento, mueve su cuenta hacia arriba (ingreso) o hacia abajo (retiro).
 */
function planCashMovement(draft: DocumentDraft, book: CurrencyBook): PostingPlan {
  currencyOf(book, draft.currency)
  if (draft.lines.length > 0) {
    throw new PostingError("INVALID_LINE", "Un ingreso o retiro de caja no lleva productos")
  }
  if (draft.payments.length === 0) {
    throw new PostingError("EMPTY_DOCUMENT", "Indica el monto y la cuenta")
  }
  for (const p of draft.payments) {
    if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0) {
      throw new PostingError("INVALID_PAYMENT", "Cada monto debe ser un entero positivo")
    }
    if (p.currency !== draft.currency) {
      throw new PostingError(
        "CURRENCY_MISMATCH",
        `Todos los montos van en la moneda del documento (${draft.currency})`,
      )
    }
  }
  const totalMinor = draft.payments.reduce((acc, p) => acc + p.amountMinor, 0)
  if (!Number.isSafeInteger(totalMinor)) {
    throw new PostingError("INVALID_PAYMENT", "El total excede el rango permitido")
  }
  const toLegal = legalConverter(draft.currency, draft.legalCurrency, draft.rate, book)
  const sign = draft.type === "CASH_IN" ? 1 : -1
  return {
    lines: [],
    totalMinor,
    totalLegalMinor: toLegal(totalMinor),
    taxes: [],
    surcharges: [],
    surchargeMinor: 0,
    surchargeLegalMinor: 0,
    stockMoves: [],
    accountMoves: draft.payments.map((p) => ({
      paymentId: p.id,
      accountId: p.accountId,
      currency: p.currency,
      amountMinor: sign * p.amountMinor,
    })),
    discountMinor: 0,
    discountLegalMinor: 0,
    creditMinor: 0,
    creditCurrency: null,
    creditLegalMinor: 0,
    allocations: [],
    charges: [],
    tipMinor: 0,
    tipLegalMinor: 0,
  }
}

/**
 * Gasto (`EXPENSE`): alquiler, luz, sueldos, fletes… Sin líneas ni IVA: el total es el monto que
 * se indica y los pagos (dinero que sale de las cuentas, en positivo) lo cubren, con la misma
 * tolerancia de redondeo que una venta si se paga en otra moneda.
 */
function planExpense(draft: DocumentDraft, book: CurrencyBook): PostingPlan {
  currencyOf(book, draft.currency)
  if (draft.lines.length > 0) {
    throw new PostingError("INVALID_LINE", "Un gasto no lleva productos")
  }
  if ((draft.allocations?.length ?? 0) > 0) {
    throw new PostingError("INVALID_ALLOCATION", "Un gasto no se aplica a ninguna deuda")
  }
  const amountMinor = draft.amountMinor ?? 0
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new PostingError("INVALID_PAYMENT", "El monto del gasto debe ser un entero positivo")
  }
  const credit = creditOf(draft, amountMinor, book)
  if (draft.payments.length === 0 && credit.creditMinor === 0) {
    throw new PostingError("EMPTY_DOCUMENT", "Indica con qué se pagó o déjalo a deber")
  }
  for (const p of draft.payments) {
    if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0) {
      throw new PostingError("INVALID_PAYMENT", "Cada pago debe ser un entero positivo")
    }
    currencyOf(book, p.currency)
  }
  const toLegal = legalConverter(draft.currency, draft.legalCurrency, draft.rate, book)
  const settlement = settle(
    draft.currency,
    amountMinor,
    [...draft.payments, ...(credit.asPayment ? [credit.asPayment] : [])],
    book,
  )
  if (!settlement.settled) {
    throw new PostingError(
      "UNSETTLED",
      `Los pagos no cubren el gasto (diferencia ${settlement.difference.toFixed()} en unidades menores)`,
    )
  }
  return {
    lines: [],
    totalMinor: amountMinor,
    totalLegalMinor: toLegal(amountMinor),
    taxes: [],
    surcharges: [],
    surchargeMinor: 0,
    surchargeLegalMinor: 0,
    stockMoves: [],
    accountMoves: draft.payments.map((p) => ({
      paymentId: p.id,
      accountId: p.accountId,
      currency: p.currency,
      amountMinor: -p.amountMinor,
    })),
    discountMinor: 0,
    discountLegalMinor: 0,
    creditMinor: credit.creditMinor,
    creditCurrency: credit.creditMinor > 0 ? credit.creditCurrency : null,
    creditLegalMinor: toLegal(credit.creditDocMinor),
    allocations: [],
    charges: [],
    tipMinor: 0,
    tipLegalMinor: 0,
  }
}

/**
 * Transferencia entre cuentas (`TRANSFER`): el dinero sale de una cuenta y entra en otra (del
 * efectivo al banco, de Zelle al banco…). Lleva dos montos positivos: el primero es el origen, en
 * la moneda del documento, y el segundo el destino, que puede estar en otra moneda (un cambio de
 * divisas). En la misma moneda se recibe exactamente lo que se envía: una comisión del banco es un
 * gasto aparte. No lleva líneas, impuestos ni deuda; el total es lo que sale del origen.
 */
function planTransfer(draft: DocumentDraft, book: CurrencyBook): PostingPlan {
  currencyOf(book, draft.currency)
  if (draft.lines.length > 0) {
    throw new PostingError("INVALID_LINE", "Una transferencia no lleva productos")
  }
  if ((draft.allocations?.length ?? 0) > 0 || (draft.creditMinor ?? 0) > 0) {
    throw new PostingError("INVALID_PAYMENT", "Una transferencia no se deja a deber ni paga deudas")
  }
  const [from, to] = draft.payments
  if (!(from && to) || draft.payments.length !== 2) {
    throw new PostingError("INVALID_PAYMENT", "Indica la cuenta de origen y la de destino")
  }
  if (from.accountId === to.accountId) {
    throw new PostingError("INVALID_PAYMENT", "Elige dos cuentas distintas")
  }
  for (const p of [from, to]) {
    if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0) {
      throw new PostingError("INVALID_PAYMENT", "Cada monto debe ser un entero positivo")
    }
    currencyOf(book, p.currency)
  }
  if (from.currency !== draft.currency) {
    throw new PostingError(
      "CURRENCY_MISMATCH",
      `El monto de origen va en la moneda del documento (${draft.currency})`,
    )
  }
  if (from.currency === to.currency && from.amountMinor !== to.amountMinor) {
    throw new PostingError(
      "INVALID_PAYMENT",
      "En la misma moneda se recibe lo mismo que se envía (una comisión es un gasto aparte)",
    )
  }
  const toLegal = legalConverter(draft.currency, draft.legalCurrency, draft.rate, book)
  return {
    lines: [],
    totalMinor: from.amountMinor,
    totalLegalMinor: toLegal(from.amountMinor),
    taxes: [],
    surcharges: [],
    surchargeMinor: 0,
    surchargeLegalMinor: 0,
    stockMoves: [],
    accountMoves: [
      {
        paymentId: from.id,
        accountId: from.accountId,
        currency: from.currency,
        amountMinor: -from.amountMinor,
      },
      {
        paymentId: to.id,
        accountId: to.accountId,
        currency: to.currency,
        amountMinor: to.amountMinor,
      },
    ],
    discountMinor: 0,
    discountLegalMinor: 0,
    creditMinor: 0,
    creditCurrency: null,
    creditLegalMinor: 0,
    allocations: [],
    charges: [],
    tipMinor: 0,
    tipLegalMinor: 0,
  }
}

/**
 * Pago a un proveedor (`PAYMENT_OUT`): el negocio paga parte de lo que debe. El total es lo que se
 * descuenta de sus compras y gastos a deber (la suma de las asignaciones, en la moneda del
 * documento) y los pagos, dinero que sale de las cuentas, lo cubren. No lleva productos ni IVA y
 * no tiene recargo: lo único que se debe es lo que ya se facturó.
 */
function planDisbursement(draft: DocumentDraft, book: CurrencyBook): PostingPlan {
  currencyOf(book, draft.currency)
  if (draft.lines.length > 0) {
    throw new PostingError("INVALID_LINE", "Un pago a proveedor no lleva productos")
  }
  const allocations = draft.allocations ?? []
  if (allocations.length === 0) {
    throw new PostingError("INVALID_ALLOCATION", "Indica qué facturas paga")
  }
  checkAllocations(allocations)
  const totalMinor = allocations.reduce((acc, a) => acc + a.amountMinor, 0)
  if (!Number.isSafeInteger(totalMinor)) {
    throw new PostingError("INVALID_ALLOCATION", "El total excede el rango permitido")
  }
  if (draft.payments.length === 0) {
    throw new PostingError("EMPTY_DOCUMENT", "Indica con qué se paga")
  }
  for (const p of draft.payments) {
    if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0) {
      throw new PostingError("INVALID_PAYMENT", "Cada pago debe ser un entero positivo")
    }
    currencyOf(book, p.currency)
  }
  const toLegal = legalConverter(draft.currency, draft.legalCurrency, draft.rate, book)
  const settlement = settle(draft.currency, totalMinor, draft.payments, book)
  if (!settlement.settled) {
    throw new PostingError(
      "UNSETTLED",
      `Los pagos no cubren lo que se paga (diferencia ${settlement.difference.toFixed()} en unidades menores)`,
    )
  }
  return {
    lines: [],
    totalMinor,
    totalLegalMinor: toLegal(totalMinor),
    taxes: [],
    surcharges: [],
    surchargeMinor: 0,
    surchargeLegalMinor: 0,
    stockMoves: [],
    accountMoves: draft.payments.map((p) => ({
      paymentId: p.id,
      accountId: p.accountId,
      currency: p.currency,
      amountMinor: -p.amountMinor,
    })),
    discountMinor: 0,
    discountLegalMinor: 0,
    creditMinor: 0,
    creditCurrency: null,
    creditLegalMinor: 0,
    allocations: allocations.map((a) => ({ ...a })),
    charges: [],
    tipMinor: 0,
    tipLegalMinor: 0,
  }
}

/** Cada asignación es un monto entero positivo y una venta no se repite. */
function checkAllocations(allocations: readonly DraftAllocation[]): void {
  const seen = new Set<string>()
  for (const a of allocations) {
    if (!Number.isSafeInteger(a.amountMinor) || a.amountMinor <= 0) {
      throw new PostingError(
        "INVALID_ALLOCATION",
        "Cada monto aplicado debe ser un entero positivo",
      )
    }
    if (seen.has(a.saleDocumentId)) {
      throw new PostingError("INVALID_ALLOCATION", "Una venta no puede aparecer dos veces")
    }
    seen.add(a.saleDocumentId)
  }
}

/**
 * Descuento que le corresponde a lo que se devuelve de una línea: el proporcional a lo devuelto.
 * Al devolver todo lo que queda de la línea se descuenta exactamente lo que faltaba, así la suma
 * de las devoluciones nunca se pasa ni se queda corta del descuento original.
 */
export function returnLineDiscount(opts: {
  /** Descuento y cantidad (milésimas) de la línea original. */
  discountMinor: number
  qtyMilli: number
  /** Lo que se devuelve ahora. */
  returnQtyMilli: number
  /** Lo ya devuelto antes de esta devolución y el descuento que se le aplicó. */
  returnedQtyMilli: number
  returnedDiscountMinor: number
}): number {
  const { discountMinor, qtyMilli, returnQtyMilli, returnedQtyMilli, returnedDiscountMinor } = opts
  if (discountMinor <= 0 || qtyMilli <= 0) return 0
  if (returnedQtyMilli + returnQtyMilli >= qtyMilli) {
    return Math.max(0, discountMinor - returnedDiscountMinor)
  }
  return roundToInteger(new Big(discountMinor).times(returnQtyMilli).div(qtyMilli), "half-up")
}

/**
 * Abono (`PAYMENT_IN`): el cliente paga parte de lo que debe. El total es lo que se descuenta de
 * sus ventas a crédito (la suma de las asignaciones, en la moneda del documento); los pagos
 * cubren ese total más el recargo (IGTF) de los pagos en divisas, como en una venta. No lleva
 * productos ni IVA: el IVA ya se facturó con la venta.
 */
function planCollection(draft: DocumentDraft, book: CurrencyBook): PostingPlan {
  currencyOf(book, draft.currency)
  if (draft.lines.length > 0) {
    throw new PostingError("INVALID_LINE", "Un abono no lleva productos")
  }
  const allocations = draft.allocations ?? []
  if (allocations.length === 0) {
    throw new PostingError("INVALID_ALLOCATION", "Indica qué ventas paga el abono")
  }
  const seen = new Set<string>()
  for (const a of allocations) {
    if (!Number.isSafeInteger(a.amountMinor) || a.amountMinor <= 0) {
      throw new PostingError(
        "INVALID_ALLOCATION",
        "Cada monto aplicado debe ser un entero positivo",
      )
    }
    if (seen.has(a.saleDocumentId)) {
      throw new PostingError("INVALID_ALLOCATION", "Una venta no puede aparecer dos veces")
    }
    seen.add(a.saleDocumentId)
  }
  const totalMinor = allocations.reduce((acc, a) => acc + a.amountMinor, 0)
  if (!Number.isSafeInteger(totalMinor)) {
    throw new PostingError("INVALID_ALLOCATION", "El total excede el rango permitido")
  }
  if (draft.payments.length === 0) {
    throw new PostingError("EMPTY_DOCUMENT", "Indica con qué paga el cliente")
  }
  for (const p of draft.payments) {
    if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor === 0) {
      throw new PostingError(
        "INVALID_PAYMENT",
        "El monto de un pago debe ser un entero distinto de cero",
      )
    }
    if (p.surcharge && !isValidRateBp(p.surcharge.rateBp)) {
      throw new PostingError("INVALID_PAYMENT", `Recargo inválido (${p.surcharge.surchargeId})`)
    }
    currencyOf(book, p.currency)
  }

  const toLegal = legalConverter(draft.currency, draft.legalCurrency, draft.rate, book)
  const surcharges = computeSurcharges(
    totalMinor,
    draft.payments.map((p) => ({
      amountMinor: inDocumentCurrency(p, draft.currency, book).amountMinor,
      surcharge: p.surcharge,
    })),
    toLegal,
  )
  const surchargeMinor = surcharges.reduce((acc, s) => acc + s.amountMinor, 0)
  const surchargeLegalMinor = surcharges.reduce((acc, s) => acc + s.amountLegalMinor, 0)
  const settlement = settle(draft.currency, totalMinor + surchargeMinor, draft.payments, book)
  if (!settlement.settled) {
    throw new PostingError(
      "UNSETTLED",
      `Los pagos no cubren el abono (diferencia ${settlement.difference.toFixed()} en unidades menores)`,
    )
  }
  return {
    lines: [],
    totalMinor,
    totalLegalMinor: toLegal(totalMinor),
    taxes: [],
    surcharges,
    surchargeMinor,
    surchargeLegalMinor,
    stockMoves: [],
    accountMoves: draft.payments.map((p) => ({
      paymentId: p.id,
      accountId: p.accountId,
      currency: p.currency,
      amountMinor: p.amountMinor,
    })),
    discountMinor: 0,
    discountLegalMinor: 0,
    creditMinor: 0,
    creditCurrency: null,
    creditLegalMinor: 0,
    allocations: allocations.map((a) => ({ ...a })),
    charges: [],
    tipMinor: 0,
    tipLegalMinor: 0,
  }
}

/**
 * Deuda manual: lo que un cliente debe (`DEBT_IN`) o lo que el negocio le debe a un proveedor
 * (`DEBT_OUT`) sin una venta, compra o gasto detrás: un saldo de antes de usar el sistema o un
 * préstamo. Todo el monto queda a crédito, en la moneda del documento. Si fue un préstamo, los pagos
 * dicen de qué cuenta salió el dinero (`DEBT_IN`) o a cuál entró (`DEBT_OUT`) y suman el monto.
 * No lleva productos ni IVA: no es una venta ni un gasto.
 */
function planDebt(draft: DocumentDraft, book: CurrencyBook): PostingPlan {
  currencyOf(book, draft.currency)
  if (draft.lines.length > 0) {
    throw new PostingError("INVALID_LINE", "Una deuda no lleva productos")
  }
  if ((draft.allocations?.length ?? 0) > 0) {
    throw new PostingError("INVALID_ALLOCATION", "Una deuda no se aplica a otra")
  }
  if ((draft.charges?.length ?? 0) > 0) {
    throw new PostingError("INVALID_LINE", "Una deuda no lleva recargos")
  }
  const amountMinor = draft.amountMinor ?? 0
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new PostingError("INVALID_PAYMENT", "El monto de la deuda debe ser un entero positivo")
  }
  if (
    (draft.creditMinor ?? 0) !== amountMinor ||
    (draft.creditCurrency ?? draft.currency) !== draft.currency
  ) {
    throw new PostingError("INVALID_PAYMENT", "Toda la deuda queda a crédito, en su moneda")
  }
  for (const p of draft.payments) {
    if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0) {
      throw new PostingError("INVALID_PAYMENT", "Cada monto prestado debe ser un entero positivo")
    }
    currencyOf(book, p.currency)
  }
  if (draft.payments.length > 0) {
    const settlement = settle(draft.currency, amountMinor, draft.payments, book)
    if (!settlement.settled) {
      throw new PostingError(
        "UNSETTLED",
        `Lo prestado no es el monto de la deuda (diferencia ${settlement.difference.toFixed()} en unidades menores)`,
      )
    }
  }
  const toLegal = legalConverter(draft.currency, draft.legalCurrency, draft.rate, book)
  // Prestarle a un cliente saca dinero; que un proveedor preste, lo mete.
  const sign = draft.type === "DEBT_IN" ? -1 : 1
  return {
    lines: [],
    totalMinor: amountMinor,
    totalLegalMinor: toLegal(amountMinor),
    taxes: [],
    surcharges: [],
    surchargeMinor: 0,
    surchargeLegalMinor: 0,
    stockMoves: [],
    accountMoves: draft.payments.map((p) => ({
      paymentId: p.id,
      accountId: p.accountId,
      currency: p.currency,
      amountMinor: sign * p.amountMinor,
    })),
    discountMinor: 0,
    discountLegalMinor: 0,
    creditMinor: amountMinor,
    creditCurrency: draft.currency,
    creditLegalMinor: toLegal(amountMinor),
    allocations: [],
    charges: [],
    tipMinor: 0,
    tipLegalMinor: 0,
  }
}

/**
 * Traslado de inventario (`STOCK_TRANSFER`): la mercancía sale de una ubicación y entra en otra
 * en el mismo momento (de la tienda al depósito, de una tienda a otra). Cada línea lleva una
 * cantidad positiva de un producto con existencia y genera dos movimientos: la resta en el origen
 * y la suma en el destino. No lleva precio, impuestos, pagos ni deuda: el total es cero.
 */
function planStockTransfer(draft: DocumentDraft, book: CurrencyBook): PostingPlan {
  currencyOf(book, draft.currency)
  if (draft.payments.length > 0 || (draft.creditMinor ?? 0) > 0) {
    throw new PostingError("INVALID_PAYMENT", "Un traslado no lleva pagos ni deuda")
  }
  if ((draft.allocations?.length ?? 0) > 0) {
    throw new PostingError("INVALID_ALLOCATION", "Un traslado no se aplica a una deuda")
  }
  if ((draft.charges?.length ?? 0) > 0) {
    throw new PostingError("INVALID_LINE", "Un traslado no lleva recargos")
  }
  if (draft.lines.length === 0) {
    throw new PostingError("EMPTY_DOCUMENT", "Agrega los productos que se trasladan")
  }
  const to = draft.toLocationId
  if (!to || to === draft.locationId) {
    throw new PostingError("INVALID_LINE", "Elige una ubicación de destino distinta del origen")
  }
  const lines: PlannedLine[] = []
  const stockMoves: PlannedStockMove[] = []
  draft.lines.forEach((line, i) => {
    const n = i + 1
    if (!Number.isSafeInteger(line.qtyMilli) || line.qtyMilli <= 0) {
      throw new PostingError("INVALID_LINE", `Línea ${n}: la cantidad debe ser positiva`)
    }
    if (line.unitPriceMinor !== 0 || (line.discountMinor ?? 0) !== 0) {
      throw new PostingError("INVALID_LINE", `Línea ${n}: un traslado no lleva precio`)
    }
    if (!line.tracksStock) {
      throw new PostingError("INVALID_LINE", `Línea ${n}: el producto no lleva existencia`)
    }
    lines.push({
      lineNo: n,
      variantId: line.variantId,
      qtyMilli: line.qtyMilli,
      unitPriceMinor: 0,
      discountMinor: 0,
      lineTotalMinor: 0,
      taxId: null,
      taxRateBp: 0,
    })
    stockMoves.push(
      {
        lineNo: n,
        variantId: line.variantId,
        locationId: draft.locationId,
        qtyMilli: -line.qtyMilli,
      },
      { lineNo: n, variantId: line.variantId, locationId: to, qtyMilli: line.qtyMilli },
    )
  })
  return {
    lines,
    totalMinor: 0,
    totalLegalMinor: 0,
    taxes: [],
    surcharges: [],
    surchargeMinor: 0,
    surchargeLegalMinor: 0,
    stockMoves,
    accountMoves: [],
    discountMinor: 0,
    discountLegalMinor: 0,
    creditMinor: 0,
    creditCurrency: null,
    creditLegalMinor: 0,
    allocations: [],
    charges: [],
    tipMinor: 0,
    tipLegalMinor: 0,
  }
}

/**
 * Producción por tandas (`PRODUCTION`): lo producido entra a la existencia de la ubicación. Cada
 * línea lleva una cantidad positiva de un producto con existencia, sin precio; los ingredientes que
 * se gastan salen de su receta (los agrega quien contabiliza). Sin impuestos, pagos ni total.
 */
function planProduction(draft: DocumentDraft, book: CurrencyBook): PostingPlan {
  currencyOf(book, draft.currency)
  if (draft.payments.length > 0 || (draft.creditMinor ?? 0) > 0) {
    throw new PostingError("INVALID_PAYMENT", "Una producción no lleva pagos ni deuda")
  }
  if ((draft.allocations?.length ?? 0) > 0) {
    throw new PostingError("INVALID_ALLOCATION", "Una producción no se aplica a una deuda")
  }
  if ((draft.charges?.length ?? 0) > 0) {
    throw new PostingError("INVALID_LINE", "Una producción no lleva recargos")
  }
  if (draft.lines.length === 0) {
    throw new PostingError("EMPTY_DOCUMENT", "Elige lo que se produce")
  }
  const lines: PlannedLine[] = []
  const stockMoves: PlannedStockMove[] = []
  draft.lines.forEach((line, i) => {
    const n = i + 1
    if (!Number.isSafeInteger(line.qtyMilli) || line.qtyMilli <= 0) {
      throw new PostingError("INVALID_LINE", `Línea ${n}: la cantidad debe ser positiva`)
    }
    if (line.unitPriceMinor !== 0 || (line.discountMinor ?? 0) !== 0) {
      throw new PostingError("INVALID_LINE", `Línea ${n}: una producción no lleva precio`)
    }
    if (!line.tracksStock) {
      throw new PostingError("INVALID_LINE", `Línea ${n}: el producto no lleva existencia`)
    }
    lines.push({
      lineNo: n,
      variantId: line.variantId,
      qtyMilli: line.qtyMilli,
      unitPriceMinor: 0,
      discountMinor: 0,
      lineTotalMinor: 0,
      taxId: null,
      taxRateBp: 0,
    })
    stockMoves.push({
      lineNo: n,
      variantId: line.variantId,
      locationId: draft.locationId,
      qtyMilli: line.qtyMilli,
    })
  })
  return {
    lines,
    totalMinor: 0,
    totalLegalMinor: 0,
    taxes: [],
    surcharges: [],
    surchargeMinor: 0,
    surchargeLegalMinor: 0,
    stockMoves,
    accountMoves: [],
    discountMinor: 0,
    discountLegalMinor: 0,
    creditMinor: 0,
    creditCurrency: null,
    creditLegalMinor: 0,
    allocations: [],
    charges: [],
    tipMinor: 0,
    tipLegalMinor: 0,
  }
}

/**
 * Función pura: valida un borrador y calcula todo lo que la contabilización debe escribir
 * (totales, movimientos de inventario y de dinero). No toca la base de datos.
 */
export function planPosting(draft: DocumentDraft, book: CurrencyBook): PostingPlan {
  if (!isPostableType(draft.type)) {
    throw new PostingError("UNSUPPORTED_TYPE", `El tipo ${draft.type} aún no se contabiliza`)
  }
  const tipMinor = draft.tipMinor ?? 0
  if (!Number.isSafeInteger(tipMinor) || tipMinor < 0) {
    throw new PostingError("INVALID_PAYMENT", "La propina debe ser un entero no negativo")
  }
  if (tipMinor > 0 && draft.type !== "SALE") {
    throw new PostingError("INVALID_PAYMENT", "Solo una venta lleva propina")
  }
  if (isCashMovement(draft.type)) return planCashMovement(draft, book)
  if (draft.type === "PAYMENT_IN") return planCollection(draft, book)
  if (draft.type === "EXPENSE") return planExpense(draft, book)
  if (draft.type === "PAYMENT_OUT") return planDisbursement(draft, book)
  if (draft.type === "TRANSFER") return planTransfer(draft, book)
  if (draft.type === "DEBT_IN" || draft.type === "DEBT_OUT") return planDebt(draft, book)
  if (draft.type === "STOCK_TRANSFER") return planStockTransfer(draft, book)
  if (draft.type === "PRODUCTION") return planProduction(draft, book)
  if ((draft.allocations?.length ?? 0) > 0 && !isReturn(draft.type)) {
    throw new PostingError(
      "INVALID_ALLOCATION",
      "Solo un abono o una devolución se aplican a la deuda",
    )
  }
  if (draft.lines.length === 0) {
    throw new PostingError("EMPTY_DOCUMENT", "El documento no tiene líneas")
  }
  if ((draft.charges?.length ?? 0) > 0 && draft.type !== "SALE") {
    throw new PostingError("INVALID_LINE", "Solo una venta lleva recargos (delivery, servicio…)")
  }
  currencyOf(book, draft.currency)
  const isAdjustment = draft.type === "ADJUSTMENT"

  const lines: PlannedLine[] = draft.lines.map((line, i) => {
    validateLine(draft.type as PostableType, line, i + 1)
    // Un ajuste no tiene precio ni, por tanto, impuesto.
    const tax = isAdjustment ? null : line.tax
    return {
      lineNo: i + 1,
      variantId: line.variantId,
      qtyMilli: line.qtyMilli,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: line.discountMinor ?? 0,
      lineTotalMinor: lineTotal(line.qtyMilli, line.unitPriceMinor) - (line.discountMinor ?? 0),
      taxId: tax?.taxId ?? null,
      taxRateBp: tax?.rateBp ?? 0,
    }
  })
  if (!Number.isSafeInteger(lines.reduce((acc, l) => acc + l.lineTotalMinor, 0))) {
    throw new PostingError("INVALID_LINE", "El total excede el rango permitido")
  }

  // El total legal sale de convertir el ancla de cada alícuota (nunca de sumar líneas ya
  // convertidas): así no aparecen céntimos fantasma.
  const toLegal = legalConverter(draft.currency, draft.legalCurrency, draft.rate, book)
  const lineEntries = draft.lines.map((line, i) => ({
    lineTotalMinor: lines[i]?.lineTotalMinor ?? 0,
    tax: line.tax,
  }))
  const lineTaxes = isAdjustment ? [] : computeTaxes(lineEntries, draft.pricesIncludeTax, toLegal)
  // Los recargos (delivery, servicio) suman como líneas: entran al desglose con su propio IVA.
  const charges = planCharges(draft.charges ?? [], lineTaxes, draft.pricesIncludeTax, toLegal)
  const chargeTax = new Map((draft.charges ?? []).map((c) => [c.chargeId, c.tax]))
  const taxes = charges.length
    ? computeTaxes(
        taxEntries(
          lineEntries,
          charges.map((c) => ({
            amountMinor: c.amountMinor,
            tax: chargeTax.get(c.chargeId) ?? null,
          })),
        ),
        draft.pricesIncludeTax,
        toLegal,
      )
    : lineTaxes
  const totalMinor = taxes.reduce((acc, t) => acc + t.baseMinor + t.taxMinor, 0)
  const totalLegalMinor = taxes.reduce((acc, t) => acc + t.baseLegalMinor + t.taxLegalMinor, 0)
  if (!Number.isSafeInteger(totalMinor) || !Number.isSafeInteger(totalLegalMinor)) {
    throw new PostingError("INVALID_LINE", "El total excede el rango permitido")
  }

  const discountMinor = lines.reduce((acc, l) => acc + l.discountMinor, 0)

  // La mercancía sale al vender y al devolverle al proveedor; entra en lo demás.
  const stockSign = draft.type === "SALE" || draft.type === "PURCHASE_RETURN" ? -1 : 1
  const stockMoves: PlannedStockMove[] = []
  draft.lines.forEach((line, i) => {
    if (line.tracksStock) {
      stockMoves.push({
        lineNo: i + 1,
        variantId: line.variantId,
        locationId: draft.locationId,
        qtyMilli: stockSign * line.qtyMilli,
      })
    }
  })

  if (isAdjustment) {
    if (draft.payments.length > 0) {
      throw new PostingError("INVALID_PAYMENT", "Un ajuste de inventario no lleva pagos")
    }
    return {
      lines,
      totalMinor,
      totalLegalMinor,
      taxes,
      surcharges: [],
      surchargeMinor: 0,
      surchargeLegalMinor: 0,
      stockMoves,
      accountMoves: [],
      discountMinor: 0,
      discountLegalMinor: 0,
      creditMinor: 0,
      creditCurrency: null,
      creditLegalMinor: 0,
      allocations: [],
      charges: [],
      tipMinor: 0,
      tipLegalMinor: 0,
    }
  }

  // Se puede dejar a deber una venta (fiado) o una compra (lo que se le debe al proveedor).
  if ((draft.creditMinor ?? 0) > 0 && draft.type !== "SALE" && draft.type !== "PURCHASE") {
    throw new PostingError(
      "INVALID_PAYMENT",
      "Solo una venta o una compra se pueden dejar a crédito",
    )
  }
  const { creditMinor, creditCurrency, creditDocMinor } = creditOf(draft, totalMinor, book)
  // Una devolución puede descontarse de lo que el cliente debe: cuenta como un reembolso en la
  // moneda de la deuda (con la misma holgura de redondeo que cualquier monto en divisas).
  const allocations = isReturn(draft.type) ? (draft.allocations ?? []) : []
  const applied = allocations.reduce((acc, a) => acc + a.amountMinor, 0)
  if (allocations.length > 0) {
    checkAllocations(allocations)
    if (!draft.allocationCurrency) {
      throw new PostingError("INVALID_ALLOCATION", "Falta la moneda de la deuda")
    }
  }
  const settlementPayments: readonly SettlementPayment[] = [
    ...draft.payments,
    ...(creditMinor > 0
      ? [{ currency: creditCurrency, amountMinor: creditMinor, rate: draft.rate }]
      : []),
    ...(applied > 0 && draft.allocationCurrency
      ? [{ currency: draft.allocationCurrency, amountMinor: applied, rate: draft.rate }]
      : []),
  ]

  for (const p of draft.payments) {
    if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor === 0) {
      throw new PostingError(
        "INVALID_PAYMENT",
        "El monto de un pago debe ser un entero distinto de cero",
      )
    }
    if (p.surcharge && !isValidRateBp(p.surcharge.rateBp)) {
      throw new PostingError("INVALID_PAYMENT", `Recargo inválido (${p.surcharge.surchargeId})`)
    }
    currencyOf(book, p.currency)
  }

  // Los recargos por método de cobro (IGTF) los percibe quien vende; en compras no aplican. Lo
  // que queda a crédito no se cobra todavía: el recargo se calcula sobre lo que se paga ahora.
  const surcharges =
    draft.type === "SALE"
      ? computeSurcharges(
          totalMinor - creditDocMinor,
          draft.payments.map((p) => ({
            amountMinor: inDocumentCurrency(p, draft.currency, book).amountMinor,
            surcharge: p.surcharge,
          })),
          toLegal,
        )
      : []
  const surchargeMinor = surcharges.reduce((acc, s) => acc + s.amountMinor, 0)
  const surchargeLegalMinor = surcharges.reduce((acc, s) => acc + s.amountLegalMinor, 0)

  // Los pagos cubren la venta, su IGTF y la propina.
  const settlement = settle(
    draft.currency,
    totalMinor + surchargeMinor + tipMinor,
    settlementPayments,
    book,
  )
  if (!settlement.settled) {
    throw new PostingError(
      "UNSETTLED",
      `Los pagos no cubren el total (diferencia ${settlement.difference.toFixed()} en unidades menores)`,
    )
  }

  // El dinero entra al vender y cuando el proveedor devuelve lo de una compra; sale en lo demás.
  const accountSign = draft.type === "SALE" || draft.type === "PURCHASE_RETURN" ? 1 : -1
  const accountMoves: PlannedAccountMove[] = draft.payments.map((p) => ({
    paymentId: p.id,
    accountId: p.accountId,
    currency: p.currency,
    amountMinor: accountSign * p.amountMinor,
  }))
  return {
    lines,
    totalMinor,
    totalLegalMinor,
    taxes,
    surcharges,
    surchargeMinor,
    surchargeLegalMinor,
    stockMoves,
    accountMoves,
    discountMinor,
    discountLegalMinor: toLegal(discountMinor),
    creditMinor,
    creditCurrency: creditMinor > 0 ? creditCurrency : null,
    creditLegalMinor: toLegal(creditDocMinor),
    allocations: allocations.map((a) => ({ ...a })),
    charges,
    tipMinor,
    tipLegalMinor: toLegal(tipMinor),
  }
}
