import type {
  Bootstrap,
  PaymentMethodInfo,
  PickedModifier,
  SaleChargeInfo,
} from "@millhiore/contracts"
import {
  type CurrencyBook,
  computeSurcharges,
  computeTaxes,
  type DraftCharge,
  type ExchangeRate,
  exchangeRate,
  inDocumentCurrency,
  type LineTax,
  lineTotal,
  type PaymentSurcharge,
  type PlannedCharge,
  type Price,
  type PriceListRule,
  planCharges,
  priceInList,
  qtyForAmount,
  roundToInteger,
  type SurchargeGroup,
  settle,
  type TaxGroup,
  taxEntries,
} from "@millhiore/domain"
import Big from "big.js"

// La caja calcula con las mismas funciones que el servidor (packages/domain): lo que ve el
// cajero es exactamente lo que se contabiliza. Las ventas van en moneda legal (Bs), como la
// factura venezolana, con la referencia en divisas a la tasa del día.

export interface PosContext {
  /** Moneda del documento: la legal (VES). */
  docCurrency: string
  /** Moneda de referencia de los precios (USD). */
  refCurrency: string
  /** 1 referencia = value legal; null si no hay tasa vigente. */
  rate: ExchangeRate | null
  book: CurrencyBook
  fiscal: Bootstrap["fiscal"]
  taxes: ReadonlyMap<string, Bootstrap["taxes"][number]>
  methods: readonly PaymentMethodInfo[]
  /** El negocio vende a crédito (fiado). */
  creditEnabled: boolean
  /** Listas de precios activas, por id, en su orden. */
  priceLists: ReadonlyMap<string, PriceListRule & { id: string; name: string }>
  /** Recargos de venta activos (delivery, servicio…), por id, en su orden. */
  charges: ReadonlyMap<string, SaleChargeInfo>
}

export function makeContext(b: Bootstrap, rateValue: string | null): PosContext {
  const { referenceCurrency, legalCurrency } = b.business
  return {
    docCurrency: legalCurrency,
    refCurrency: referenceCurrency,
    rate: rateValue ? exchangeRate(referenceCurrency, legalCurrency, rateValue) : null,
    book: Object.fromEntries(b.currencies.map((c) => [c.code, c])),
    fiscal: b.fiscal,
    taxes: new Map(b.taxes.map((t) => [t.id, t])),
    methods: b.paymentMethods,
    creditEnabled: b.credit.enabled,
    charges: new Map(b.features.charges ? b.charges.map((c) => [c.id, c]) : []),
    priceLists: new Map(
      (b.features.priceLists ? b.priceLists : []).map((l) => [
        l.id,
        {
          id: l.id,
          name: l.name,
          adjustBp: l.adjustBp,
          prices: new Map(l.prices.map((p) => [p.variantId, p])),
        },
      ]),
    ),
  }
}

/** Precio de un producto con la lista elegida (o el normal, sin lista o si ya no existe). */
export function priceWithList(
  ctx: PosContext,
  priceListId: string | null,
  variantId: string,
  base: Price,
): Price {
  return priceInList(
    variantId,
    base,
    priceListId ? (ctx.priceLists.get(priceListId) ?? null) : null,
  )
}

/** Convierte un monto exacto entre la moneda del documento y otra, sin redondear. */
function convertBig(ctx: PosContext, amount: Big, from: string, to: string): Big | null {
  if (from === to) return amount
  const r = ctx.rate
  if (!r) return null
  const base = ctx.book[r.base]
  const quote = ctx.book[r.quote]
  if (!base || !quote) return null
  const scale = new Big(10).pow(quote.decimals - base.decimals)
  if (from === r.base && to === r.quote) return amount.times(r.value).times(scale)
  if (from === r.quote && to === r.base) return amount.div(r.value).div(scale)
  return null
}

/** Monto en `from` → unidades menores de `to`, redondeado; null si no hay tasa para el par. */
export function convertMinor(
  ctx: PosContext,
  amount: number | Big,
  from: string,
  to: string,
): number | null {
  const exact = convertBig(ctx, new Big(amount), from, to)
  return exact === null ? null : roundToInteger(exact, "half-up")
}

/** Precio unitario en la moneda del documento; null si está en divisas y falta la tasa. */
export function unitPriceInDoc(
  ctx: PosContext,
  priceMinor: number,
  priceCurrency: string,
): number | null {
  return convertMinor(ctx, priceMinor, priceCurrency, ctx.docCurrency)
}

/**
 * Precio unitario en la moneda del documento con las opciones y extras, que suman su precio (cada
 * uno en su moneda) al del producto; null si falta la tasa para alguno.
 */
export function unitWithModifiers(
  ctx: PosContext,
  priceMinor: number,
  priceCurrency: string,
  modifiers: readonly PickedModifier[] | undefined,
): number | null {
  let unit = unitPriceInDoc(ctx, priceMinor, priceCurrency)
  for (const m of modifiers ?? []) {
    if (!m.priceMinor || !m.priceCurrency || unit === null) continue
    const extra = unitPriceInDoc(ctx, m.priceMinor, m.priceCurrency)
    unit = extra === null ? null : unit + extra
  }
  return unit
}

/** IVA que el servidor aplicará a la línea (mismo criterio que posting/post.ts). */
export function lineTaxOf(ctx: PosContext, taxId: string | null): LineTax | null {
  if (ctx.fiscal.taxpayer === "none") return null
  const t = ctx.taxes.get(taxId ?? ctx.fiscal.defaultTaxId)
  return t ? { taxId: t.id, kind: t.kind, rateBp: t.rateBp } : null
}

/**
 * Un descuento: un porcentaje (en centésimas de punto, 1000 = 10 %) o un monto en la moneda en que
 * se escribió (Bs o $). Se convierte a la moneda del documento al calcular.
 */
export type DiscountSpec =
  | { kind: "percent"; bp: number; code?: DiscountCodeRef | undefined }
  | { kind: "amount"; amountMinor: number; currency: string; code?: DiscountCodeRef | undefined }

/** El código de descuento del que sale el descuento de la venta (lo aplica cualquier cajero). */
export interface DiscountCodeRef {
  id: string
  code: string
}

export interface CartLine {
  /** Identifica la línea en el ticket (el producto, o uno propio si lleva opciones). */
  key?: string | undefined
  variantId: string
  name: string
  qtyMilli: number
  /** En la moneda del documento. */
  unitPriceMinor: number
  /** Descuento sobre la línea (moneda del documento), ya calculado; 0 si no hay. */
  discountMinor?: number
  /** IVA del producto (null = el impuesto por defecto). */
  taxId: string | null
  /** Opciones y extras elegidos (su precio ya va en `unitPriceMinor`). */
  modifiers?: readonly PickedModifier[] | undefined
  /** Indicaciones para la cocina. */
  note?: string | null | undefined
}

/** La clave de una línea del ticket: la suya, o el producto si no lleva opciones. */
export function lineKey(l: { key?: string | undefined; variantId: string }): string {
  return l.key ?? l.variantId
}

export interface Ticket {
  /** Total de cada línea ya con su descuento. */
  lineTotals: number[]
  /** Recargos de la venta (delivery, servicio…), ya calculados; suman al total. */
  charges: PlannedCharge[]
  /** Σ descuentos de las líneas (los de línea y la parte del descuento a toda la venta). */
  discountMinor: number
  taxes: TaxGroup[]
  totalMinor: number
  /** Σ IVA (para mostrar). */
  taxMinor: number
  /** Propina que se cobra con la venta (aparte del total, sin IVA ni IGTF); la pone el cobro. */
  tipMinor?: number
}

const identity = (n: number) => n

export function computeTicket(
  ctx: PosContext,
  lines: readonly CartLine[],
  charges: readonly DraftCharge[] = [],
): Ticket {
  const lineTotals = lines.map(
    (l) => lineTotal(l.qtyMilli, l.unitPriceMinor) - (l.discountMinor ?? 0),
  )
  const entries = lines.map((l, i) => ({
    lineTotalMinor: lineTotals[i] ?? 0,
    tax: lineTaxOf(ctx, l.taxId),
  }))
  const pricesIncludeTax = ctx.fiscal.pricesIncludeTax
  const lineTaxes = computeTaxes(entries, pricesIncludeTax, identity)
  // Los recargos se calculan igual que en el servidor: el porcentaje sobre el subtotal sin IVA.
  const planned = lines.length ? planCharges(charges, lineTaxes, pricesIncludeTax, identity) : []
  const chargeTax = new Map(charges.map((c) => [c.chargeId, c.tax]))
  const taxes = planned.length
    ? computeTaxes(
        taxEntries(
          entries,
          planned.map((c) => ({
            amountMinor: c.amountMinor,
            tax: chargeTax.get(c.chargeId) ?? null,
          })),
        ),
        pricesIncludeTax,
        identity,
      )
    : lineTaxes
  return {
    lineTotals,
    charges: planned,
    discountMinor: lines.reduce((acc, l) => acc + (l.discountMinor ?? 0), 0),
    taxes,
    totalMinor: taxes.reduce((acc, t) => acc + t.baseMinor + t.taxMinor, 0),
    taxMinor: taxes.reduce((acc, t) => acc + t.taxMinor, 0),
  }
}

export interface PaymentEntry {
  id: string
  methodId: string
  currency: string
  /** Unidades menores de `currency`; negativo = vuelto entregado. */
  amountMinor: number
  reference: string | null
}

/** Tasa que acompaña a un pago: ninguna si va en la moneda del documento. */
export function paymentRate(ctx: PosContext, currency: string): ExchangeRate | null {
  return currency === ctx.docCurrency ? null : ctx.rate
}

/** Se puede cobrar con este método: su moneda es la del documento o hay tasa para convertirla. */
export function methodUsable(ctx: PosContext, m: PaymentMethodInfo): boolean {
  return (
    m.currency === ctx.docCurrency ||
    (ctx.rate !== null && (m.currency === ctx.rate.base || m.currency === ctx.rate.quote))
  )
}

function surchargeOf(ctx: PosContext, methodId: string): PaymentSurcharge | null {
  const s = ctx.methods.find((m) => m.id === methodId)?.surcharge
  return s ? { surchargeId: s.id, rateBp: s.rateBp } : null
}

/** Lo que se deja a deber (fiado): monto en unidades menores de su moneda, normalmente USD. */
export interface CreditEntry {
  currency: string
  amountMinor: number
}

export interface Checkout {
  surcharges: SurchargeGroup[]
  surchargeMinor: number
  /** Total + recargos + propina: lo que hay que cobrar. */
  dueMinor: number
  /** Lo fiado visto en la moneda del documento (redondeado); 0 si no hay. */
  creditDocMinor: number
  /** Falta por cobrar (positivo) o vuelto a entregar (negativo), exacto, en moneda del documento. */
  remaining: Big
  settled: boolean
}

export function computeCheckout(
  ctx: PosContext,
  ticket: Ticket,
  payments: readonly PaymentEntry[],
  credit: CreditEntry | null = null,
): Checkout {
  const forSettle = payments.map((p) => ({
    currency: p.currency,
    amountMinor: p.amountMinor,
    rate: paymentRate(ctx, p.currency),
  }))
  // Lo fiado se trata como un pago en su moneda (igual que en el servidor): trae la holgura de
  // redondeo de una deuda en dólares y el IGTF solo se calcula sobre lo que se paga ahora.
  const owed =
    credit && credit.amountMinor > 0
      ? {
          currency: credit.currency,
          amountMinor: credit.amountMinor,
          rate: paymentRate(ctx, credit.currency),
        }
      : null
  const creditDocMinor = owed
    ? roundToInteger(inDocumentCurrency(owed, ctx.docCurrency, ctx.book).amountMinor, "half-up")
    : 0
  const surcharges = computeSurcharges(
    ticket.totalMinor - creditDocMinor,
    payments.map((p, i) => ({
      amountMinor: inDocumentCurrency(
        forSettle[i] ?? { currency: p.currency, amountMinor: 0, rate: null },
        ctx.docCurrency,
        ctx.book,
      ).amountMinor,
      surcharge: surchargeOf(ctx, p.methodId),
    })),
    identity,
  )
  const surchargeMinor = surcharges.reduce((acc, s) => acc + s.amountMinor, 0)
  const dueMinor = ticket.totalMinor + surchargeMinor + (ticket.tipMinor ?? 0)
  const s = settle(ctx.docCurrency, dueMinor, owed ? [...forSettle, owed] : forSettle, ctx.book)
  return {
    surcharges,
    surchargeMinor,
    dueMinor,
    creditDocMinor,
    remaining: s.difference.times(-1),
    settled: s.settled,
  }
}

/**
 * Cuánto cobrar con `method` para saldar la cuenta, en su moneda. Si el método lleva IGTF, el
 * monto incluye el recargo que su propio pago genera (se resuelve por aproximaciones: el
 * recargo de un pago depende del pago).
 */
export function amountToSettle(
  ctx: PosContext,
  ticket: Ticket,
  payments: readonly PaymentEntry[],
  method: PaymentMethodInfo,
): number {
  let amount = 0
  for (let i = 0; i < 8; i++) {
    const trial =
      amount > 0
        ? [
            ...payments,
            {
              id: "trial",
              methodId: method.id,
              currency: method.currency,
              amountMinor: amount,
              reference: null,
            },
          ]
        : payments
    const c = computeCheckout(ctx, ticket, trial)
    if (c.settled || c.remaining.lte(0)) return amount
    const more = convertMinor(ctx, c.remaining, ctx.docCurrency, method.currency)
    if (more === null) return amount
    amount += Math.max(1, more)
  }
  return amount
}

/** Vuelto a entregar en `currency` (positivo), o 0 si no sobra nada. */
export function changeIn(ctx: PosContext, checkout: Checkout, currency: string): number {
  if (checkout.settled || checkout.remaining.gte(0)) return 0
  return convertMinor(ctx, checkout.remaining.times(-1), ctx.docCurrency, currency) ?? 0
}

/**
 * Se puede dejar a deber en `currency`: es la del documento o hay tasa para convertirla (la
 * deuda va en dólares aunque la factura sea en bolívares).
 */
export function creditUsable(ctx: PosContext, currency: string): boolean {
  return (
    currency === ctx.docCurrency ||
    (ctx.rate !== null && (currency === ctx.rate.base || currency === ctx.rate.quote))
  )
}

/**
 * Cuánto dejar a deber (en `currency`) para que lo pagado más lo fiado cubra la cuenta. El IGTF
 * depende de lo que se deje a deber (solo se cobra sobre lo que se paga ahora), así que se
 * resuelve por aproximaciones, como `amountToSettle`. 0 si ya está pagado o sobra dinero.
 */
export function creditToLeave(
  ctx: PosContext,
  ticket: Ticket,
  payments: readonly PaymentEntry[],
  currency: string,
): number {
  if (!creditUsable(ctx, currency)) return 0
  let credit = 0
  for (let i = 0; i < 8; i++) {
    const c = computeCheckout(
      ctx,
      ticket,
      payments,
      credit > 0 ? { currency, amountMinor: credit } : null,
    )
    if (c.settled) return credit
    const delta = convertMinor(ctx, c.remaining, ctx.docCurrency, currency)
    if (delta === null || delta === 0) return credit
    credit = Math.max(0, credit + delta)
  }
  return credit
}

/** Lo que descuenta `spec` sobre `baseMinor` (moneda del documento): nunca más que la base. */
export function discountOf(ctx: PosContext, spec: DiscountSpec, baseMinor: number): number {
  if (baseMinor <= 0) return 0
  const raw =
    spec.kind === "percent"
      ? roundToInteger(new Big(baseMinor).times(spec.bp).div(10_000), "half-up")
      : (convertMinor(ctx, spec.amountMinor, spec.currency, ctx.docCurrency) ?? 0)
  return Math.max(0, Math.min(baseMinor, raw))
}

/** Recargo elegido en la venta; uno fijo puede llevar el monto escrito para esta venta. */
export interface TicketCharge {
  chargeId: string
  amount?: { amountMinor: number; currency: string } | undefined
}

/** Los recargos que se agregan solos a cada venta (p. ej. el servicio de un restaurante). */
export function autoCharges(ctx: PosContext): TicketCharge[] {
  return [...ctx.charges.values()].filter((c) => c.auto).map((c) => ({ chargeId: c.id }))
}

/** IVA de un recargo: el suyo, salvo que el negocio no cobre IVA; null = no lleva. */
function chargeTaxOf(ctx: PosContext, taxId: string | null): LineTax | null {
  if (!taxId || ctx.fiscal.taxpayer === "none") return null
  const t = ctx.taxes.get(taxId)
  return t ? { taxId: t.id, kind: t.kind, rateBp: t.rateBp } : null
}

/**
 * Los recargos elegidos, listos para calcular: el monto de uno fijo en la moneda del documento (el
 * escrito o el sugerido). `missingRate` si alguno está en divisas y no hay tasa.
 */
export function draftCharges(
  ctx: PosContext,
  chosen: readonly TicketCharge[],
): { charges: DraftCharge[]; missingRate: boolean } {
  let missingRate = false
  const charges: DraftCharge[] = []
  for (const tc of chosen) {
    const info = ctx.charges.get(tc.chargeId)
    if (!info) continue
    let amountMinor = 0
    if (info.kind === "fixed") {
      const amount = tc.amount ?? {
        amountMinor: info.amountMinor,
        currency: info.currency ?? ctx.docCurrency,
      }
      const inDoc = convertMinor(ctx, amount.amountMinor, amount.currency, ctx.docCurrency)
      if (inDoc === null) missingRate = true
      amountMinor = inDoc ?? 0
    }
    charges.push({
      chargeId: info.id,
      name: info.name,
      kind: info.kind,
      rateBp: info.rateBp,
      amountMinor,
      tax: chargeTaxOf(ctx, info.taxId),
    })
  }
  return { charges, missingRate }
}

/**
 * Cuánto lleva un monto (en bolívares o en la moneda de referencia) al precio por unidad del
 * ticket, en milésimas; null si no se puede convertir o el monto no alcanza para nada.
 */
export function qtyForMoney(
  ctx: PosContext,
  amount: { minor: number; currency: string },
  unitPriceMinor: number | null,
): number | null {
  if (unitPriceMinor === null) return null
  const inDoc = convertMinor(ctx, amount.minor, amount.currency, ctx.docCurrency)
  if (inDoc === null) return null
  const qty = qtyForAmount(inDoc, unitPriceMinor)
  return qty && qty > 0 ? qty : null
}

/** Línea del ticket tal como se guarda en la caja: precio de catálogo y descuento elegido. */
export interface StoredLine {
  variantId: string
  name: string
  qtyMilli: number
  priceMinor: number
  priceCurrency: string
  taxId: string | null
  discount?: DiscountSpec | undefined
  /** Precio congelado (de una cotización): no le aplica la lista de precios. */
  fixedPrice?: boolean | undefined
  key?: string | undefined
  modifiers?: readonly PickedModifier[] | undefined
  note?: string | null | undefined
}

/**
 * El ticket de la caja: precios en la moneda del documento (con la lista de precios elegida, si
 * hay) y los descuentos ya calculados. El de
 * cada línea se resta de su importe; el de toda la venta se reparte entre las líneas en proporción
 * a lo que vale cada una (el servidor solo conoce descuentos por línea, y así el IVA de cada
 * línea se calcula sobre lo que de verdad se cobra). Lo que sobra por redondeo va a la mayor.
 */
export function buildCart(
  ctx: PosContext,
  stored: readonly StoredLine[],
  saleDiscount: DiscountSpec | null,
  priceListId: string | null = null,
  chosenCharges: readonly TicketCharge[] = [],
): { lines: CartLine[]; ticket: Ticket; missingRate: boolean } {
  const charges = draftCharges(ctx, chosenCharges)
  let missingRate = charges.missingRate
  const base = stored.map((l) => {
    const price = l.fixedPrice ? l : priceWithList(ctx, priceListId, l.variantId, l)
    const unit = unitWithModifiers(ctx, price.priceMinor, price.priceCurrency, l.modifiers)
    if (unit === null) missingRate = true
    const unitPriceMinor = unit ?? 0
    const gross = lineTotal(l.qtyMilli, unitPriceMinor)
    return { l, unitPriceMinor, gross, own: l.discount ? discountOf(ctx, l.discount, gross) : 0 }
  })
  const after = base.map((b) => b.gross - b.own)
  const pool = after.reduce((acc, n) => acc + n, 0)
  const wanted = saleDiscount ? discountOf(ctx, saleDiscount, pool) : 0
  const shares = after.map((n) =>
    pool > 0 ? Math.floor(new Big(wanted).times(n).div(pool).toNumber()) : 0,
  )
  let rest = wanted - shares.reduce((acc, n) => acc + n, 0)
  if (rest > 0) {
    // El redondeo hacia abajo deja unos céntimos: se le dan a la línea de mayor importe.
    const biggest = after.indexOf(Math.max(...after))
    shares[biggest] = (shares[biggest] ?? 0) + rest
    rest = 0
  }
  const lines: CartLine[] = base.map((b, i) => ({
    key: lineKey(b.l),
    variantId: b.l.variantId,
    name: b.l.name,
    qtyMilli: b.l.qtyMilli,
    unitPriceMinor: b.unitPriceMinor,
    discountMinor: b.own + (shares[i] ?? 0),
    taxId: b.l.taxId,
    ...(b.l.modifiers?.length ? { modifiers: b.l.modifiers } : {}),
    ...(b.l.note ? { note: b.l.note } : {}),
  }))
  return { lines, ticket: computeTicket(ctx, lines, charges.charges), missingRate }
}
