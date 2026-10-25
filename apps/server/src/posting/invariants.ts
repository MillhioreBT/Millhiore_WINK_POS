import {
  accountBalance,
  accountMove,
  allocation,
  cashShift,
  cashShiftAccount,
  currency,
  type Db,
  document,
  documentCharge,
  documentLine,
  documentSurcharge,
  documentTax,
  lotBalance,
  payment,
  stockBalance,
  stockMove,
  stockReason,
} from "@millhiore/db"
import {
  type CurrencyBook,
  commissionMinor,
  computeSurcharges,
  computeTaxes,
  inDocumentCurrency,
  isCashMovement,
  isValidLineTax,
  legalConverter,
  lineTotal,
  type PlannedCharge,
  planCharges,
  roundToInteger,
  type SurchargeGroup,
  settle,
  type TaxGroup,
  type ToLegal,
  taxEntries,
} from "@millhiore/domain"
import { asc, eq, isNotNull, sql } from "drizzle-orm"

export interface Violation {
  /** Número de invariante según PLAN.md §6. */
  invariant: 1 | 2 | 3 | 4 | 5 | 6
  message: string
}

const IMMUTABLE_TABLES = [
  "document",
  "document_line",
  "document_tax",
  "document_surcharge",
  "document_charge",
  "payment",
  "stock_move",
  "account_move",
  "allocation",
]

/** Compara dos mapas clave → número; un lado ausente cuenta como 0. */
function diffMaps(expected: Map<string, number>, actual: Map<string, number>): string[] {
  const out: string[] = []
  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    const want = expected.get(key) ?? 0
    const got = actual.get(key) ?? 0
    if (want !== got) out.push(`${key}: movimientos=${want}, saldo=${got}`)
  }
  return out
}

/**
 * Verifica los invariantes del modelo documento → libros (PLAN.md §6). Pensada para tests,
 * para la tarea nocturna de auditoría y para diagnosticar una base sospechosa.
 * Devuelve la lista de violaciones; vacía significa que todo cuadra.
 */
export function checkInvariants(db: Db): Violation[] {
  const violations: Violation[] = []
  const add = (invariant: Violation["invariant"], message: string) =>
    violations.push({ invariant, message })

  // 1. stock_balance = Σ stock_move por (variante, ubicación)
  const moved = new Map<string, number>()
  for (const r of db
    .select({
      v: stockMove.variantId,
      l: stockMove.locationId,
      q: sql<number>`sum(${stockMove.qtyMilli})`,
    })
    .from(stockMove)
    .groupBy(stockMove.variantId, stockMove.locationId)
    .all()) {
    moved.set(`${r.v}@${r.l}`, r.q)
  }
  const balances = new Map(
    db
      .select()
      .from(stockBalance)
      .all()
      .map((b) => [`${b.variantId}@${b.locationId}`, b.qtyMilli]),
  )
  for (const m of diffMaps(moved, balances)) add(1, `stock ${m}`)

  // 1b. lot_balance = Σ stock_move por (lote, ubicación), y cada lote es del producto que mueve
  const movedLots = new Map<string, number>()
  for (const r of db
    .select({
      lot: stockMove.lotId,
      l: stockMove.locationId,
      q: sql<number>`sum(${stockMove.qtyMilli})`,
    })
    .from(stockMove)
    .where(isNotNull(stockMove.lotId))
    .groupBy(stockMove.lotId, stockMove.locationId)
    .all()) {
    movedLots.set(`${r.lot}@${r.l}`, r.q)
  }
  const lotBalances = new Map(
    db
      .select()
      .from(lotBalance)
      .all()
      .map((b) => [`${b.lotId}@${b.locationId}`, b.qtyMilli]),
  )
  for (const m of diffMaps(movedLots, lotBalances)) add(1, `lote ${m}`)
  const strays = db.all<{ n: number }>(
    sql`select count(*) as n from stock_move m join lot on lot.id = m.lot_id
        where lot.variant_id <> m.variant_id`,
  )[0]?.n
  if (strays) add(1, `${strays} movimientos con un lote de otro producto`)

  // 2. account_balance = Σ account_move por cuenta
  const flows = new Map<string, number>()
  for (const r of db
    .select({ a: accountMove.accountId, s: sql<number>`sum(${accountMove.amountMinor})` })
    .from(accountMove)
    .groupBy(accountMove.accountId)
    .all()) {
    flows.set(r.a, r.s)
  }
  const accounts = new Map(
    db
      .select()
      .from(accountBalance)
      .all()
      .map((b) => [b.accountId, b.amountMinor]),
  )
  for (const m of diffMaps(flows, accounts)) add(2, `cuenta ${m}`)

  // 3. No existe ningún movimiento sin documento (ni sin su línea o pago)
  // (db.get con SQL crudo devuelve un array, no un objeto: por eso se usa all()[0].)
  const orphanStock = db.all<{ n: number }>(
    sql`select count(*) as n from stock_move m
        where not exists (select 1 from document d where d.id = m.document_id)
           or not exists (select 1 from document_line l where l.id = m.document_line_id)`,
  )[0]?.n
  if (orphanStock) add(3, `${orphanStock} movimientos de inventario sin documento o línea`)
  const orphanMoney = db.all<{ n: number }>(
    sql`select count(*) as n from account_move m
        where not exists (select 1 from document d where d.id = m.document_id)
           or not exists (select 1 from payment p where p.id = m.payment_id)`,
  )[0]?.n
  if (orphanMoney) add(3, `${orphanMoney} movimientos de dinero sin documento o pago`)

  // 4. Un documento contabilizado es inmutable: deben existir los triggers que lo imponen
  const triggers = new Set(
    db
      .all<{ name: string }>(sql`select name from sqlite_master where type = 'trigger'`)
      .map((t) => t.name),
  )
  for (const table of IMMUTABLE_TABLES) {
    for (const op of ["update", "delete"]) {
      if (!triggers.has(`${table}_no_${op}`)) add(4, `falta el trigger ${table}_no_${op}`)
    }
  }

  // 5. En cada documento: el desglose de IVA se deriva de sus líneas, el total es Σ (base + IVA),
  //    los recargos (IGTF) se derivan de sus pagos y Σ pagos − vuelto = total + recargos.
  const book: CurrencyBook = Object.fromEntries(
    db
      .select()
      .from(currency)
      .all()
      .map((c) => [c.code, { code: c.code, decimals: c.decimals }]),
  )
  const linesByDoc = byDocument(
    db.select().from(documentLine).orderBy(asc(documentLine.lineNo)).all(),
  )
  const taxesByDoc = byDocument(
    db.select().from(documentTax).orderBy(asc(documentTax.position)).all(),
  )
  const surchargesByDoc = byDocument(
    db.select().from(documentSurcharge).orderBy(asc(documentSurcharge.position)).all(),
  )
  const chargesByDoc = byDocument(
    db.select().from(documentCharge).orderBy(asc(documentCharge.position)).all(),
  )
  const stockByDoc = byDocument(db.select().from(stockMove).all())
  // El orden de los pagos importa para repartir la base del recargo: el de inserción.
  const paymentsByDoc = byDocument(db.select().from(payment).orderBy(sql`rowid`).all())
  const reasons = new Map(
    db
      .select()
      .from(stockReason)
      .all()
      .map((r) => [r.id, r]),
  )
  // Lo que movió cada pago en su cuenta (con signo).
  const movedByPayment = new Map<string, number>()
  for (const m of db.select().from(accountMove).all()) {
    movedByPayment.set(m.paymentId, (movedByPayment.get(m.paymentId) ?? 0) + m.amountMinor)
  }
  const collectedBy = new Map<string, number>()
  const appliedTo = new Map<string, number>()
  // Moneda en que se debe cada venta a crédito: la de las asignaciones que la pagan.
  const debtCurrency = new Map(
    db
      .select({ id: document.id, currency: document.creditCurrency })
      .from(document)
      .all()
      .map((r) => [r.id, r.currency]),
  )
  const allocatedBy = new Map<string, { saleId: string; amountMinor: number }[]>()
  for (const a of db.select().from(allocation).all()) {
    const rows = allocatedBy.get(a.paymentDocumentId) ?? []
    rows.push({ saleId: a.saleDocumentId, amountMinor: a.amountMinor })
    allocatedBy.set(a.paymentDocumentId, rows)
    collectedBy.set(
      a.paymentDocumentId,
      (collectedBy.get(a.paymentDocumentId) ?? 0) + a.amountMinor,
    )
    appliedTo.set(a.saleDocumentId, (appliedTo.get(a.saleDocumentId) ?? 0) + a.amountMinor)
  }

  for (const d of db.select().from(document).all()) {
    const rateOf = (r: {
      rateBase: string | null
      rateQuote: string | null
      rateValue: string | null
    }) =>
      r.rateBase && r.rateQuote && r.rateValue
        ? { base: r.rateBase, quote: r.rateQuote, value: r.rateValue }
        : null
    let toLegal: ToLegal
    try {
      toLegal = legalConverter(d.currency, d.legalCurrency, rateOf(d), book)
    } catch {
      add(5, `${d.number}: falta la tasa de su total legal`)
      continue
    }

    const storedTaxes = (taxesByDoc.get(d.id) ?? []).map(taxGroupOf)
    for (const t of storedTaxes) {
      if (t.taxId && !isValidLineTax({ taxId: t.taxId, kind: t.kind, rateBp: t.rateBp })) {
        add(5, `${d.number}: alícuota ${t.rateBp} incoherente con ${t.kind}`)
      }
    }
    const kindOf = (taxId: string, rateBp: number) =>
      storedTaxes.find((t) => t.taxId === taxId && t.rateBp === rateBp)?.kind ?? "taxed"
    const taxOf = (taxId: string | null, rateBp: number) =>
      taxId ? { taxId, kind: kindOf(taxId, rateBp), rateBp } : null
    const lineEntries = (linesByDoc.get(d.id) ?? []).map((l) => ({
      lineTotalMinor: l.lineTotalMinor,
      tax: taxOf(l.taxId, l.taxRateBp),
    }))
    // Los recargos de venta (delivery, servicio) suman al desglose como líneas, con su IVA.
    const docCharges = chargesByDoc.get(d.id) ?? []
    const expectedTaxes =
      d.type === "ADJUSTMENT" || d.type === "STOCK_TRANSFER" || d.type === "PRODUCTION"
        ? []
        : computeTaxes(
            taxEntries(
              lineEntries,
              docCharges.map((c) => ({
                amountMinor: c.amountMinor,
                tax: taxOf(c.taxId, c.taxRateBp),
              })),
            ),
            d.pricesIncludeTax,
            toLegal,
          )
    if (JSON.stringify(expectedTaxes) !== JSON.stringify(storedTaxes)) {
      add(5, `${d.number}: el desglose de IVA no coincide con sus líneas`)
    }
    if (docCharges.length && d.type !== "SALE") {
      add(5, `${d.number}: solo una venta lleva recargos`)
    }
    // Un reverso lleva los recargos del original con signo contrario; una venta, los que salen de
    // su configuración congelada: el porcentaje sobre el subtotal sin IVA de sus líneas.
    const chargeShape = (c: Omit<PlannedCharge, "position">) => ({
      chargeId: c.chargeId,
      name: c.name,
      kind: c.kind,
      rateBp: c.rateBp,
      baseMinor: c.baseMinor,
      amountMinor: c.amountMinor,
      amountLegalMinor: c.amountLegalMinor,
      taxId: c.taxId,
      taxRateBp: c.taxRateBp,
    })
    if (d.reversesDocumentId) {
      const expected = (chargesByDoc.get(d.reversesDocumentId) ?? []).map((c) => ({
        ...chargeShape(c),
        baseMinor: -c.baseMinor,
        amountMinor: -c.amountMinor,
        amountLegalMinor: -c.amountLegalMinor,
      }))
      if (JSON.stringify(expected) !== JSON.stringify(docCharges.map(chargeShape))) {
        add(5, `${d.number}: los recargos no son los del documento que anula`)
      }
    } else if (docCharges.length) {
      const replanned = planCharges(
        docCharges.map((c) => ({
          chargeId: c.chargeId,
          name: c.name,
          kind: c.kind,
          rateBp: c.rateBp,
          amountMinor: c.amountMinor,
          tax: taxOf(c.taxId, c.taxRateBp),
        })),
        computeTaxes(lineEntries, d.pricesIncludeTax, toLegal),
        d.pricesIncludeTax,
        toLegal,
      )
      if (
        JSON.stringify(replanned.map(chargeShape)) !== JSON.stringify(docCharges.map(chargeShape))
      ) {
        add(5, `${d.number}: los recargos no salen de su configuración y sus líneas`)
      }
    }
    // Traslados de inventario: sin precio, impuestos, pagos ni total; cada línea sale del origen y
    // entra al destino (en el reverso, al revés).
    if (d.type === "STOCK_TRANSFER") {
      const docLines = linesByDoc.get(d.id) ?? []
      const sign = d.reversesDocumentId ? -1 : 1
      if (!d.toLocationId || d.toLocationId === d.locationId) {
        add(5, `${d.number}: un traslado va de una ubicación a otra distinta`)
      }
      if (
        storedTaxes.length > 0 ||
        (paymentsByDoc.get(d.id) ?? []).length > 0 ||
        d.totalMinor !== 0 ||
        d.totalLegalMinor !== 0 ||
        d.creditMinor !== 0
      ) {
        add(5, `${d.number}: un traslado no lleva impuestos, pagos ni total`)
      }
      if (
        docLines.length === 0 ||
        docLines.some(
          (l) => Math.sign(l.qtyMilli) !== sign || l.unitPriceMinor !== 0 || l.lineTotalMinor !== 0,
        )
      ) {
        add(5, `${d.number}: las líneas del traslado no tienen cantidades válidas`)
      }
      const expected = docLines
        .flatMap((l) => [
          `${l.id}@${d.locationId}:${-l.qtyMilli}`,
          `${l.id}@${d.toLocationId}:${l.qtyMilli}`,
        ])
        .sort()
      // Un producto con lotes reparte cada lado en varios movimientos: se suman por línea y
      // ubicación, y cada lote que sale del origen entra igual al destino.
      const byPlace = new Map<string, number>()
      const byLot = new Map<string, number>()
      for (const m of stockByDoc.get(d.id) ?? []) {
        const place = `${m.documentLineId}@${m.locationId}`
        byPlace.set(place, (byPlace.get(place) ?? 0) + m.qtyMilli)
        const lotKey = `${m.documentLineId}#${m.lotId ?? "-"}`
        byLot.set(lotKey, (byLot.get(lotKey) ?? 0) + m.qtyMilli)
      }
      const actual = [...byPlace].map(([place, qty]) => `${place}:${qty}`).sort()
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        add(5, `${d.number}: lo que sale del origen no es lo que entra al destino`)
      }
      if ([...byLot.values()].some((qty) => qty !== 0)) {
        add(5, `${d.number}: al destino no llegan los mismos lotes que salen del origen`)
      }
      continue
    }
    if (d.toLocationId) add(5, `${d.number}: solo un traslado lleva ubicación de destino`)
    // Producción: sin precio, impuestos, pagos ni total; lo producido entra a la ubicación (en el
    // reverso, sale) y lo demás que mueve la línea son sus ingredientes, que salen (o vuelven).
    if (d.type === "PRODUCTION") {
      const docLines = linesByDoc.get(d.id) ?? []
      const sign = d.reversesDocumentId ? -1 : 1
      if (
        storedTaxes.length > 0 ||
        (paymentsByDoc.get(d.id) ?? []).length > 0 ||
        d.totalMinor !== 0 ||
        d.totalLegalMinor !== 0 ||
        d.creditMinor !== 0
      ) {
        add(5, `${d.number}: una producción no lleva impuestos, pagos ni total`)
      }
      if (
        docLines.length === 0 ||
        docLines.some(
          (l) => Math.sign(l.qtyMilli) !== sign || l.unitPriceMinor !== 0 || l.lineTotalMinor !== 0,
        )
      ) {
        add(5, `${d.number}: las líneas de la producción no tienen cantidades válidas`)
      }
      const moves = stockByDoc.get(d.id) ?? []
      for (const l of docLines) {
        const own = moves.filter((m) => m.documentLineId === l.id && m.variantId === l.variantId)
        if (
          own.some((m) => m.locationId !== d.locationId) ||
          own.reduce((acc, m) => acc + m.qtyMilli, 0) !== l.qtyMilli
        ) {
          add(5, `${d.number}: lo producido no entra a la existencia de su ubicación`)
        }
        if (
          moves.some(
            (m) =>
              m.documentLineId === l.id &&
              m.variantId !== l.variantId &&
              Math.sign(m.qtyMilli) !== -sign,
          )
        ) {
          add(5, `${d.number}: los ingredientes de la producción no salen de la existencia`)
        }
      }
    }
    if (d.discountCodeId && d.type !== "SALE") {
      add(5, `${d.number}: solo una venta lleva código de descuento`)
    }
    // Ingresos y retiros de caja: sin líneas ni impuestos; el total es la suma de sus montos.
    if (isCashMovement(d.type)) {
      const list = paymentsByDoc.get(d.id) ?? []
      if (
        list.some((p) => p.currency !== d.currency) ||
        list.reduce((acc, p) => acc + p.amountMinor, 0) !== d.totalMinor ||
        toLegal(d.totalMinor) !== d.totalLegalMinor
      ) {
        add(5, `${d.number}: el total no coincide con sus montos`)
      }
      continue
    }
    // Lo que queda a deber (una venta fiada, o una compra o un gasto a deber): nunca más que el
    // total, y los pagos que se le aplican no lo superan. Un pago reparte exactamente su total
    // entre las facturas que paga.
    // Lo fiado cuenta como un pago en su moneda (normalmente dólares sobre un documento en Bs).
    const creditPayment =
      d.creditMinor !== 0 && d.creditCurrency
        ? { currency: d.creditCurrency, amountMinor: d.creditMinor, rate: rateOf(d) }
        : null
    let credit: ReturnType<typeof inDocumentCurrency> | null = null
    try {
      credit = creditPayment ? inDocumentCurrency(creditPayment, d.currency, book) : null
    } catch {
      add(5, `${d.number}: falta la tasa para llevar lo fiado a la moneda del documento`)
    }
    const creditDocMinor = credit ? roundToInteger(credit.amountMinor, "half-up") : 0
    // Motivo de ajuste: solo un ajuste de inventario lo lleva, y su sentido coincide con las
    // cantidades (una salida resta; en el reverso, al contrario).
    if (d.type !== "ADJUSTMENT") {
      if (d.stockReasonId) add(5, `${d.number}: solo un ajuste de inventario lleva motivo`)
    } else if (d.stockReasonId) {
      // Los ajustes anteriores a los motivos no tienen ninguno (el documento no se puede editar).
      const reason = reasons.get(d.stockReasonId)
      if (!reason) {
        add(5, `${d.number}: el ajuste no tiene un motivo válido`)
      } else {
        const wanted = (reason.direction === "in" ? 1 : -1) * (d.reversesDocumentId ? -1 : 1)
        if ((linesByDoc.get(d.id) ?? []).some((l) => Math.sign(l.qtyMilli) !== wanted)) {
          add(5, `${d.number}: las cantidades no coinciden con el sentido del motivo`)
        }
      }
    }
    // Comisiones: solo las pagan los cobros a clientes (ventas y abonos, y sus reversos). Cada una
    // es la tasa congelada aplicada al monto, con el signo del pago, y la cuenta recibe el cobro
    // menos la comisión.
    const collects = d.type === "SALE" || d.type === "PAYMENT_IN"
    for (const p of paymentsByDoc.get(d.id) ?? []) {
      if (!collects) {
        if (p.commissionMinor !== 0 || p.commissionRateBp !== 0) {
          add(5, `${d.number}: este documento no cobra comisión`)
        }
        continue
      }
      // En el original paga comisión lo que entra (pago positivo); en el reverso, lo que sale.
      const charged = d.reversesDocumentId ? p.amountMinor < 0 : p.amountMinor > 0
      const expected = charged
        ? Math.sign(p.amountMinor) * commissionMinor(Math.abs(p.amountMinor), p.commissionRateBp)
        : 0
      if (p.commissionMinor !== expected) {
        add(5, `${d.number}: la comisión del pago no es la tasa aplicada al monto`)
      }
      if (movedByPayment.get(p.id) !== p.amountMinor - p.commissionMinor) {
        add(5, `${d.number}: la cuenta no recibió el cobro menos la comisión`)
      }
    }
    // Transferencias: sin líneas ni impuestos; el primer pago es el origen (sale) y el segundo el
    // destino (entra); en la misma moneda, lo mismo que se envía. El total es lo que sale del origen.
    if (d.type === "TRANSFER") {
      const list = paymentsByDoc.get(d.id) ?? []
      const [from, to] = list
      if ((linesByDoc.get(d.id) ?? []).length > 0 || storedTaxes.length > 0) {
        add(5, `${d.number}: una transferencia no lleva líneas ni impuestos`)
      }
      if (!(from && to) || list.length !== 2) {
        add(5, `${d.number}: una transferencia lleva exactamente un origen y un destino`)
      } else {
        if (movedByPayment.get(from.id) !== -from.amountMinor) {
          add(5, `${d.number}: lo que sale de la cuenta de origen no es el monto`)
        }
        if (movedByPayment.get(to.id) !== to.amountMinor) {
          add(5, `${d.number}: lo que entra a la cuenta de destino no es el monto`)
        }
        if (from.accountId === to.accountId) {
          add(5, `${d.number}: el origen y el destino son la misma cuenta`)
        }
        if (from.currency === to.currency && from.amountMinor !== to.amountMinor) {
          add(5, `${d.number}: en la misma moneda se debe recibir lo mismo que se envía`)
        }
        if (d.totalMinor !== from.amountMinor || toLegal(d.totalMinor) !== d.totalLegalMinor) {
          add(5, `${d.number}: el total no es lo que sale del origen`)
        }
      }
      continue
    }
    // Deudas manuales: sin líneas ni impuestos; todo el total queda a crédito en su moneda y, si
    // fue un préstamo, lo que movieron las cuentas es el monto (sale si le prestamos a un cliente,
    // entra si nos prestó un proveedor).
    if (d.type === "DEBT_IN" || d.type === "DEBT_OUT") {
      const list = paymentsByDoc.get(d.id) ?? []
      if ((linesByDoc.get(d.id) ?? []).length > 0 || storedTaxes.length > 0) {
        add(5, `${d.number}: una deuda no lleva líneas ni impuestos`)
      }
      if (d.creditMinor !== d.totalMinor || d.creditCurrency !== d.currency) {
        add(5, `${d.number}: toda la deuda queda a crédito en su moneda`)
      }
      if (
        toLegal(d.totalMinor) !== d.totalLegalMinor ||
        toLegal(d.creditMinor) !== d.creditLegalMinor
      ) {
        add(5, `${d.number}: la deuda en moneda legal no coincide con su conversión`)
      }
      const applied = appliedTo.get(d.id) ?? 0
      if (!d.reversesDocumentId && (applied < 0 || applied > d.creditMinor)) {
        add(5, `${d.number}: lo pagado (${applied}) no cabe en la deuda (${d.creditMinor})`)
      }
      // El reverso niega tanto el pago como el movimiento, así que el signo es el mismo.
      const sign = d.type === "DEBT_IN" ? -1 : 1
      for (const p of list) {
        if (movedByPayment.get(p.id) !== sign * p.amountMinor) {
          add(5, `${d.number}: la cuenta no movió lo prestado`)
        }
      }
      if (list.length > 0) {
        const s = settle(
          d.currency,
          Math.abs(d.totalMinor),
          list.map((p) => ({
            currency: p.currency,
            amountMinor: Math.abs(p.amountMinor),
            rate: rateOf(p),
          })),
          book,
        )
        if (!s.settled) add(5, `${d.number}: lo prestado no es el monto de la deuda`)
      }
      continue
    }
    // Gastos: sin líneas ni impuestos; los pagos cubren el total (con la tolerancia de siempre) y
    // un gasto original dice en qué se gastó.
    if (d.type === "EXPENSE") {
      if ((linesByDoc.get(d.id) ?? []).length > 0 || storedTaxes.length > 0) {
        add(5, `${d.number}: un gasto no lleva líneas ni impuestos`)
      }
      if (!d.reversesDocumentId && !d.expenseCategoryId) {
        add(5, `${d.number}: el gasto no tiene categoría`)
      }
      if (toLegal(d.totalMinor) !== d.totalLegalMinor) {
        add(5, `${d.number}: el total legal no coincide con su conversión`)
      }
      if (toLegal(creditDocMinor) !== d.creditLegalMinor) {
        add(5, `${d.number}: lo que queda a deber en moneda legal no coincide con su conversión`)
      }
      if (d.creditMinor !== 0 && !d.creditCurrency) {
        add(5, `${d.number}: lo que queda a deber no dice en qué moneda`)
      }
      if (!d.reversesDocumentId) {
        const tooMuch = credit?.amountMinor.minus(d.totalMinor).gt(credit.tolerance)
        const applied = appliedTo.get(d.id) ?? 0
        if (d.creditMinor < 0 || tooMuch || applied < 0 || applied > d.creditMinor) {
          add(5, `${d.number}: lo que queda a deber no cabe en el total o ya se pagó de más`)
        }
      }
      const s = settle(
        d.currency,
        d.totalMinor,
        [
          ...(paymentsByDoc.get(d.id) ?? []).map((p) => ({
            currency: p.currency,
            amountMinor: p.amountMinor,
            rate: rateOf(p),
          })),
          ...(creditPayment ? [creditPayment] : []),
        ],
        book,
      )
      if (!s.settled) {
        add(5, `${d.number}: los pagos no cubren el gasto (dif. ${s.difference.toFixed()})`)
      }
      continue
    }
    // Descuentos: cada línea vale cantidad × precio menos su descuento (sin pasarse del importe),
    //   y el documento guarda la suma de los de sus líneas, también en moneda legal.
    const docLines = linesByDoc.get(d.id) ?? []
    for (const l of docLines) {
      if (d.reversesDocumentId) continue
      const gross = lineTotal(l.qtyMilli, l.unitPriceMinor)
      if (l.discountMinor < 0 || l.discountMinor > Math.abs(gross)) {
        add(5, `${d.number}: el descuento de la línea ${l.lineNo} no cabe en su importe`)
      } else if (gross - l.discountMinor !== l.lineTotalMinor) {
        add(5, `${d.number}: el total de la línea ${l.lineNo} no es cantidad × precio − descuento`)
      }
    }
    if (docLines.reduce((acc, l) => acc + l.discountMinor, 0) !== d.discountMinor) {
      add(5, `${d.number}: el descuento del documento no es la suma de los de sus líneas`)
    }
    if (toLegal(d.discountMinor) !== d.discountLegalMinor) {
      add(5, `${d.number}: el descuento en moneda legal no coincide con su conversión`)
    }
    if (d.type !== "SALE" && d.type !== "RETURN" && d.discountMinor !== 0) {
      add(5, `${d.number}: solo una venta o una devolución admite descuentos`)
    }
    if (d.type === "RETURN" || d.type === "PURCHASE_RETURN") {
      const original = d.returnsDocumentId
        ? db
            .select({ type: document.type })
            .from(document)
            .where(eq(document.id, d.returnsDocumentId))
            .get()
        : undefined
      const of = d.type === "RETURN" ? "SALE" : "PURCHASE"
      if (!d.reversesDocumentId && original?.type !== of) {
        add(5, `${d.number}: una devolución debe ser de una ${of === "SALE" ? "venta" : "compra"}`)
      }
    }
    if (d.type !== "SALE" && d.type !== "PURCHASE" && d.creditMinor !== 0) {
      add(5, `${d.number}: solo una venta, una compra o un gasto pueden quedar a crédito`)
    }
    if (d.creditMinor !== 0 && !d.creditCurrency) {
      add(5, `${d.number}: lo fiado no dice en qué moneda se debe`)
    }
    if (toLegal(creditDocMinor) !== d.creditLegalMinor) {
      add(5, `${d.number}: lo fiado en moneda legal no coincide con su conversión`)
    }
    if ((d.type === "SALE" || d.type === "PURCHASE") && !d.reversesDocumentId) {
      const tooMuch = credit?.amountMinor.minus(d.totalMinor).gt(credit.tolerance)
      if (d.creditMinor < 0 || tooMuch) {
        add(5, `${d.number}: el monto a crédito no cabe en el total`)
      }
      const applied = appliedTo.get(d.id) ?? 0
      if (applied < 0 || applied > d.creditMinor) {
        add(
          5,
          `${d.number}: los abonos aplicados (${applied}) no caben en lo fiado (${d.creditMinor})`,
        )
      }
    }
    if (
      (d.type === "PAYMENT_IN" || d.type === "PAYMENT_OUT") &&
      (collectedBy.get(d.id) ?? 0) !== d.totalMinor
    ) {
      add(5, `${d.number}: el total del pago no es la suma de lo que aplica a las facturas`)
    }
    if (
      d.type !== "PAYMENT_IN" &&
      d.type !== "PAYMENT_OUT" &&
      storedTaxes.reduce((acc, t) => acc + t.baseMinor + t.taxMinor, 0) !== d.totalMinor
    ) {
      add(5, `${d.number}: el total no es la suma de base + IVA`)
    }
    if (
      d.type !== "PAYMENT_IN" &&
      d.type !== "PAYMENT_OUT" &&
      storedTaxes.reduce((acc, t) => acc + t.baseLegalMinor + t.taxLegalMinor, 0) !==
        d.totalLegalMinor
    ) {
      add(5, `${d.number}: el total legal no es la suma de base + IVA en moneda legal`)
    }
    if (d.type === "ADJUSTMENT") continue

    const payments = (paymentsByDoc.get(d.id) ?? []).map((p) => ({
      currency: p.currency,
      amountMinor: p.amountMinor,
      rate: rateOf(p),
      surcharge: p.surchargeId ? { surchargeId: p.surchargeId, rateBp: p.surchargeRateBp } : null,
    }))
    const storedSurcharges = (surchargesByDoc.get(d.id) ?? []).map(surchargeGroupOf)
    // Un reverso lleva los recargos del original con signo contrario; los demás se recalculan.
    const expectedSurcharges = d.reversesDocumentId
      ? (surchargesByDoc.get(d.reversesDocumentId) ?? []).map(surchargeGroupOf).map((s) => ({
          ...s,
          baseMinor: -s.baseMinor,
          amountMinor: -s.amountMinor,
          baseLegalMinor: -s.baseLegalMinor,
          amountLegalMinor: -s.amountLegalMinor,
        }))
      : d.type === "SALE" || d.type === "PAYMENT_IN"
        ? computeSurcharges(
            d.totalMinor - creditDocMinor,
            payments.map((p) => ({
              amountMinor: inDocumentCurrency(p, d.currency, book).amountMinor,
              surcharge: p.surcharge,
            })),
            toLegal,
          )
        : []
    if (JSON.stringify(expectedSurcharges) !== JSON.stringify(storedSurcharges)) {
      add(5, `${d.number}: los recargos no coinciden con sus pagos`)
    }
    if (
      storedSurcharges.reduce((acc, s) => acc + s.amountMinor, 0) !== d.surchargeMinor ||
      storedSurcharges.reduce((acc, s) => acc + s.amountLegalMinor, 0) !== d.surchargeLegalMinor
    ) {
      add(5, `${d.number}: el total de recargos no es la suma de su desglose`)
    }

    // Una devolución puede descontarse de la deuda: esas asignaciones cuentan como un reembolso
    // en la moneda de la deuda.
    const applied = (allocatedBy.get(d.id) ?? []).map((a) => ({
      currency: debtCurrency.get(a.saleId) ?? d.currency,
      amountMinor: a.amountMinor,
      rate: rateOf(d),
    }))
    // La propina: solo en ventas (y su reverso), con su equivalente legal a la tasa del documento;
    // los pagos la cubren además del total.
    if (d.tipMinor !== 0 && d.type !== "SALE") add(5, `${d.number}: solo una venta lleva propina`)
    if (
      d.tipMinor !== 0 &&
      Math.sign(d.tipMinor) * toLegal(Math.abs(d.tipMinor)) !== d.tipLegalMinor
    ) {
      add(5, `${d.number}: la propina en moneda legal no sale de la tasa del documento`)
    }
    if (d.tipUserId && d.tipMinor === 0)
      add(5, `${d.number}: dice para quién es una propina que no hay`)
    const s = settle(
      d.currency,
      d.totalMinor + d.surchargeMinor + d.tipMinor,
      [
        ...payments,
        ...(creditPayment ? [creditPayment] : []),
        ...(d.type === "RETURN" || d.type === "PURCHASE_RETURN" ? applied : []),
      ],
      book,
    )
    if (!s.settled)
      add(5, `${d.number}: los pagos no cubren el total (dif. ${s.difference.toFixed()})`)
  }

  // 6. En cada turno cerrado y cuenta de efectivo: esperado = apertura contada + movimientos del
  //    turno (sin contar los ajustes de diferencia), y cada diferencia quedó asentada.
  const moves = db
    .select({
      documentId: accountMove.documentId,
      accountId: accountMove.accountId,
      amountMinor: accountMove.amountMinor,
      shiftId: document.shiftId,
    })
    .from(accountMove)
    .innerJoin(document, eq(document.id, accountMove.documentId))
    .all()
  const flowOf = (accountId: string, filter: (m: (typeof moves)[number]) => boolean) =>
    moves
      .filter((m) => m.accountId === accountId && filter(m))
      .reduce((acc, m) => acc + m.amountMinor, 0)
  for (const { cash_shift: shift, cash_shift_account: row } of db
    .select()
    .from(cashShiftAccount)
    .innerJoin(cashShift, eq(cashShift.id, cashShiftAccount.shiftId))
    .all()) {
    const label = `turno ${shift.id.slice(0, 8)} cuenta ${row.accountId}`
    const adjustments = new Set([row.openingAdjustmentId, row.closingAdjustmentId])
    const openingDiff = row.openingAdjustmentId
      ? flowOf(row.accountId, (m) => m.documentId === row.openingAdjustmentId)
      : 0
    if (row.openingCountedMinor - row.openingExpectedMinor !== openingDiff) {
      add(6, `${label}: la diferencia de apertura no quedó asentada`)
    }
    if (shift.status !== "closed") continue
    const during = flowOf(
      row.accountId,
      (m) => m.shiftId === shift.id && !adjustments.has(m.documentId),
    )
    if (row.closingExpectedMinor !== row.openingCountedMinor + during) {
      add(6, `${label}: esperado ≠ apertura + entradas − salidas`)
    }
    const closingDiff = row.closingAdjustmentId
      ? flowOf(row.accountId, (m) => m.documentId === row.closingAdjustmentId)
      : 0
    if ((row.closingCountedMinor ?? 0) - (row.closingExpectedMinor ?? 0) !== closingDiff) {
      add(6, `${label}: la diferencia de cierre no quedó asentada`)
    }
  }

  return violations
}

function byDocument<T extends { documentId: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const r of rows) {
    const list = out.get(r.documentId) ?? []
    list.push(r)
    out.set(r.documentId, list)
  }
  return out
}

/** Fila de `document_tax` en la forma (y orden de campos) de `computeTaxes`. */
function taxGroupOf(r: typeof documentTax.$inferSelect): TaxGroup {
  return {
    taxId: r.taxId,
    kind: r.kind,
    rateBp: r.rateBp,
    baseMinor: r.baseMinor,
    taxMinor: r.taxMinor,
    baseLegalMinor: r.baseLegalMinor,
    taxLegalMinor: r.taxLegalMinor,
  }
}

/** Fila de `document_surcharge` en la forma (y orden de campos) de `computeSurcharges`. */
function surchargeGroupOf(r: typeof documentSurcharge.$inferSelect): SurchargeGroup {
  return {
    surchargeId: r.surchargeId,
    rateBp: r.rateBp,
    baseMinor: r.baseMinor,
    amountMinor: r.amountMinor,
    baseLegalMinor: r.baseLegalMinor,
    amountLegalMinor: r.amountLegalMinor,
  }
}
