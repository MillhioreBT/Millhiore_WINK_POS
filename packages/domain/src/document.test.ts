import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { USD, VES } from "./currency"
import {
  type CurrencyBook,
  type DocumentDraft,
  type DraftLine,
  type DraftPayment,
  PostingError,
  planPosting,
  settle,
} from "./document"
import { exchangeRate } from "./rate"
import type { LineTax } from "./tax"
import { isUuidv7, uuidv7 } from "./uuid"

const book: CurrencyBook = { USD, VES }
const usdVes = exchangeRate("USD", "VES", "36.5")
const IVA: LineTax = { taxId: "iva-general", kind: "taxed", rateBp: 1600 }
const EXEMPT: LineTax = { taxId: "exento", kind: "exempt", rateBp: 0 }
const IGTF = { surchargeId: "igtf", rateBp: 300 }

const pay = (id: string, currency: string, amountMinor: number): DraftPayment => ({
  id,
  methodId: `m-${currency}`,
  accountId: `a-${currency}`,
  currency,
  amountMinor,
  rate: currency === "USD" ? null : usdVes,
  reference: null,
  surcharge: null,
})

const ln = (
  qtyMilli: number,
  unitPriceMinor: number,
  over: Partial<DraftLine> = {},
): DraftLine => ({
  variantId: "v1",
  qtyMilli,
  unitPriceMinor,
  tracksStock: true,
  tax: null,
  ...over,
})

const sale = (over: Partial<DocumentDraft> = {}): DocumentDraft => ({
  id: "d1",
  type: "SALE",
  currency: "USD",
  legalCurrency: "VES",
  rate: usdVes,
  locationId: "loc",
  pricesIncludeTax: true,
  lines: [ln(2000, 500)],
  payments: [pay("p1", "USD", 1000)],
  ...over,
})

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    if (e instanceof PostingError) return e.code
    throw e
  }
}

describe("planPosting · SALE", () => {
  test("calcula totales, descuenta stock y entra dinero", () => {
    const plan = planPosting(sale(), book)
    expect(plan.totalMinor).toBe(1000)
    expect(plan.totalLegalMinor).toBe(36500)
    expect(plan.stockMoves).toEqual([
      { lineNo: 1, variantId: "v1", locationId: "loc", qtyMilli: -2000 },
    ])
    expect(plan.accountMoves).toEqual([
      { paymentId: "p1", accountId: "a-USD", currency: "USD", amountMinor: 1000 },
    ])
  })

  test("pago mixto con vuelto en otra moneda (USD efectivo → vuelto en Bs)", () => {
    // total 10,00 USD; cliente da 20 USD y recibe 365,00 Bs de vuelto (−36500)
    const plan = planPosting(
      sale({ payments: [pay("p1", "USD", 2000), pay("p2", "VES", -36500)] }),
      book,
    )
    expect(plan.accountMoves.map((m) => m.amountMinor)).toEqual([2000, -36500])
  })

  test("tolera el redondeo de la moneda extranjera, pero no más", () => {
    // 10,01 USD = 365,365 Bs; pagar 365,37 queda a 0,005 Bs (media unidad menor)
    const draft = sale({ lines: [ln(1000, 1001)], payments: [pay("p1", "VES", 36537)] })
    expect(planPosting(draft, book).totalMinor).toBe(1001)
    const short = sale({ payments: [pay("p1", "VES", 36000)] })
    expect(codeOf(() => planPosting(short, book))).toBe("UNSETTLED")
  })

  test("no mueve stock de servicios", () => {
    const lines = [ln(1000, 1000, { variantId: "s", tracksStock: false })]
    expect(planPosting(sale({ lines }), book).stockMoves).toEqual([])
  })

  test("rechaza documentos inválidos con códigos estables", () => {
    expect(codeOf(() => planPosting(sale({ lines: [] }), book))).toBe("EMPTY_DOCUMENT")
    expect(codeOf(() => planPosting(sale({ type: "DESCONOCIDO" as never }), book))).toBe(
      "UNSUPPORTED_TYPE",
    )
    expect(codeOf(() => planPosting(sale({ payments: [] }), book))).toBe("UNSETTLED")
    expect(codeOf(() => planPosting(sale({ payments: [pay("p", "USD", 0)] }), book))).toBe(
      "INVALID_PAYMENT",
    )
    expect(codeOf(() => planPosting(sale({ lines: [ln(-1000, 5)] }), book))).toBe("INVALID_LINE")
    expect(codeOf(() => planPosting(sale({ rate: null, currency: "USD" }), book))).toBe(
      "MISSING_RATE",
    )
    const noRate = { ...pay("p", "VES", 36500), rate: null }
    expect(codeOf(() => planPosting(sale({ payments: [noRate] }), book))).toBe("MISSING_RATE")
    const badTax = ln(1000, 100, { tax: { taxId: "x", kind: "exempt", rateBp: 1600 } })
    expect(codeOf(() => planPosting(sale({ lines: [badTax] }), book))).toBe("INVALID_LINE")
  })
})

describe("planPosting · IVA", () => {
  test("precio con IVA incluido: el total no cambia y se desglosa base + IVA", () => {
    // 2 × 5,80 = 11,60 con IVA → base 10,00 + IVA 1,60
    const plan = planPosting(
      sale({ lines: [ln(2000, 580, { tax: IVA })], payments: [pay("p1", "USD", 1160)] }),
      book,
    )
    expect(plan.totalMinor).toBe(1160)
    expect(plan.taxes).toEqual([
      {
        taxId: "iva-general",
        kind: "taxed",
        rateBp: 1600,
        baseMinor: 1000,
        taxMinor: 160,
        // 11,60 $ × 36,5 = 423,40 Bs → base 365,00 + IVA 58,40
        baseLegalMinor: 36500,
        taxLegalMinor: 5840,
      },
    ])
    expect(plan.totalLegalMinor).toBe(42340)
    expect(plan.lines[0]).toMatchObject({ taxId: "iva-general", taxRateBp: 1600 })
  })

  test("precio sin IVA: se suma aparte y los pagos deben cubrirlo", () => {
    const draft = sale({
      pricesIncludeTax: false,
      lines: [ln(2000, 500, { tax: IVA })],
      payments: [pay("p1", "USD", 1000)],
    })
    expect(codeOf(() => planPosting(draft, book))).toBe("UNSETTLED")
    const plan = planPosting({ ...draft, payments: [pay("p1", "USD", 1160)] }, book)
    expect(plan.totalMinor).toBe(1160)
    expect(plan.taxes[0]).toMatchObject({ baseMinor: 1000, taxMinor: 160 })
  })

  test("agrupa por alícuota: gravado y exento por separado", () => {
    const plan = planPosting(
      sale({
        lines: [
          ln(1000, 580, { tax: IVA }),
          ln(1000, 200, { tax: EXEMPT }),
          ln(1000, 580, { tax: IVA }),
        ],
        payments: [pay("p1", "USD", 1360)],
      }),
      book,
    )
    expect(plan.taxes.map((t) => [t.taxId, t.baseMinor, t.taxMinor])).toEqual([
      ["iva-general", 1000, 160],
      ["exento", 200, 0],
    ])
  })

  test("el IVA en Bs se calcula sobre la base en Bs, no convirtiendo céntimos de dólar", () => {
    // 0,03 $ sin IVA a 879,1225 Bs/$: IVA en dólares = 0,0048 → 0,00 $, pero en Bs la base es
    // 26,37 y su IVA 4,22 Bs. Convertir el IVA ya redondeado lo perdería.
    const rate = exchangeRate("USD", "VES", "879.1225")
    const plan = planPosting(
      sale({
        rate,
        pricesIncludeTax: false,
        lines: [ln(1000, 3, { tax: IVA })],
        payments: [pay("p1", "USD", 3)],
      }),
      book,
    )
    expect(plan.taxes[0]).toMatchObject({
      baseMinor: 3,
      taxMinor: 0,
      baseLegalMinor: 2637,
      taxLegalMinor: 422,
    })
  })

  test("un ajuste no lleva impuesto aunque el producto lo tenga", () => {
    const plan = planPosting(
      sale({ type: "ADJUSTMENT", payments: [], lines: [ln(-1000, 0, { tax: IVA })] }),
      book,
    )
    expect(plan.taxes).toEqual([])
    expect(plan.lines[0]).toMatchObject({ taxId: null, taxRateBp: 0 })
  })
})

describe("planPosting · IGTF", () => {
  const usdIgtf = (id: string, amountMinor: number): DraftPayment => ({
    ...pay(id, "USD", amountMinor),
    surcharge: IGTF,
  })

  test("pago total en divisas: 3 % sobre el total con IVA", () => {
    // 116,00 $ → IGTF 3,48 $ (criterio de Gálac: el cliente paga el total en divisas)
    const plan = planPosting(
      sale({ lines: [ln(1000, 11600, { tax: IVA })], payments: [usdIgtf("p1", 11948)] }),
      book,
    )
    expect(plan.totalMinor).toBe(11600)
    expect(plan.surcharges).toEqual([
      {
        surchargeId: "igtf",
        rateBp: 300,
        baseMinor: 11600,
        amountMinor: 348,
        baseLegalMinor: 423400,
        amountLegalMinor: 12702,
      },
    ])
    expect(plan.surchargeMinor).toBe(348)
  })

  test("pago mixto: solo la parte en divisas paga IGTF", () => {
    // 20,00 $: 8,00 $ en Bs (292,00) + 12,00 $ en divisas → IGTF 0,36 $
    const plan = planPosting(
      sale({
        lines: [ln(1000, 2000)],
        payments: [pay("p1", "VES", 29200), usdIgtf("p2", 1236)],
      }),
      book,
    )
    expect(plan.surcharges[0]).toMatchObject({ baseMinor: 1200, amountMinor: 36 })
  })

  test("el vuelto no cambia la base: paga de más en divisas y recibe Bs", () => {
    // Cuenta de 15,00 $ + IGTF 0,45 $; entrega 20,45 $ y recibe 5,00 $ en Bs (182,50).
    // El IGTF es sobre 15,00 $, no sobre los 20,45 $ entregados.
    const plan = planPosting(
      sale({
        lines: [ln(1000, 1500)],
        payments: [usdIgtf("p1", 2045), pay("p2", "VES", -18250)],
      }),
      book,
    )
    expect(plan.surcharges[0]).toMatchObject({ baseMinor: 1500, amountMinor: 45 })
  })

  test("sin el IGTF, el pago en divisas no cuadra", () => {
    const draft = sale({ lines: [ln(1000, 1000)], payments: [usdIgtf("p1", 1000)] })
    expect(codeOf(() => planPosting(draft, book))).toBe("UNSETTLED")
  })

  test("en compras no se aplica (lo percibe quien vende)", () => {
    const plan = planPosting(sale({ type: "PURCHASE", payments: [usdIgtf("p1", 1000)] }), book)
    expect(plan.surcharges).toEqual([])
  })
})

describe("planPosting · ingresos y retiros de caja", () => {
  const cash = (type: "CASH_IN" | "CASH_OUT", amounts: number[], currency = "USD") =>
    sale({
      type,
      currency,
      lines: [],
      payments: amounts.map((a, i) => ({ ...pay(`p${i}`, currency, a), rate: null })),
    })

  test("un ingreso suma a la cuenta y un retiro resta, sin impuestos", () => {
    const inPlan = planPosting(cash("CASH_IN", [2000, 500]), book)
    expect(inPlan.totalMinor).toBe(2500)
    expect(inPlan.totalLegalMinor).toBe(91250)
    expect(inPlan.taxes).toEqual([])
    expect(inPlan.accountMoves.map((m) => m.amountMinor)).toEqual([2000, 500])
    const outPlan = planPosting(cash("CASH_OUT", [700]), book)
    expect(outPlan.accountMoves[0]?.amountMinor).toBe(-700)
  })

  test("rechaza líneas, montos no positivos, otra moneda o ningún monto", () => {
    expect(codeOf(() => planPosting(cash("CASH_IN", []), book))).toBe("EMPTY_DOCUMENT")
    expect(codeOf(() => planPosting(cash("CASH_OUT", [-5]), book))).toBe("INVALID_PAYMENT")
    expect(codeOf(() => planPosting({ ...cash("CASH_IN", [5]), lines: [ln(1000, 1)] }, book))).toBe(
      "INVALID_LINE",
    )
    const mixed = cash("CASH_IN", [5])
    expect(codeOf(() => planPosting({ ...mixed, payments: [pay("x", "VES", 100)] }, book))).toBe(
      "CURRENCY_MISMATCH",
    )
  })
})

describe("planPosting · deudas anotadas a mano", () => {
  const debt = (
    type: "DEBT_IN" | "DEBT_OUT",
    amountMinor: number,
    over: Partial<DocumentDraft> = {},
  ) =>
    sale({
      type,
      lines: [],
      payments: [],
      amountMinor,
      creditMinor: amountMinor,
      creditCurrency: "USD",
      ...over,
    })

  test("un saldo de antes queda todo a crédito, sin IVA ni mover dinero", () => {
    const plan = planPosting(debt("DEBT_IN", 2500), book)
    expect(plan).toMatchObject({
      totalMinor: 2500,
      totalLegalMinor: 91250,
      creditMinor: 2500,
      creditCurrency: "USD",
      creditLegalMinor: 91250,
      taxes: [],
      stockMoves: [],
      accountMoves: [],
    })
  })

  test("un préstamo a un cliente saca dinero; uno de un proveedor lo mete", () => {
    const lent = planPosting(debt("DEBT_IN", 1000, { payments: [pay("p1", "USD", 1000)] }), book)
    expect(lent.accountMoves.map((m) => m.amountMinor)).toEqual([-1000])
    const borrowed = planPosting(
      debt("DEBT_OUT", 1000, { payments: [pay("p1", "USD", 600), pay("p2", "VES", 14600)] }),
      book,
    )
    expect(borrowed.accountMoves.map((m) => m.amountMinor)).toEqual([600, 14600])
  })

  test("rechaza productos, montos no positivos, crédito parcial o lo prestado distinto", () => {
    expect(codeOf(() => planPosting(debt("DEBT_IN", 100, { lines: [ln(1000, 100)] }), book))).toBe(
      "INVALID_LINE",
    )
    expect(codeOf(() => planPosting(debt("DEBT_OUT", 0), book))).toBe("INVALID_PAYMENT")
    expect(codeOf(() => planPosting(debt("DEBT_IN", 100, { creditMinor: 50 }), book))).toBe(
      "INVALID_PAYMENT",
    )
    expect(
      codeOf(() => planPosting(debt("DEBT_IN", 100, { payments: [pay("p1", "USD", 90)] }), book)),
    ).toBe("UNSETTLED")
  })
})

describe("planPosting · traslados de inventario", () => {
  const transfer = (over: Partial<DocumentDraft> = {}) =>
    sale({
      type: "STOCK_TRANSFER",
      rate: null,
      currency: "VES",
      payments: [],
      lines: [ln(3000, 0), ln(500, 0, { variantId: "v2" })],
      locationId: "tienda",
      toLocationId: "deposito",
      ...over,
    })

  test("cada línea sale del origen y entra al destino, sin dinero ni total", () => {
    const plan = planPosting(transfer(), book)
    expect(plan.stockMoves).toEqual([
      { lineNo: 1, variantId: "v1", locationId: "tienda", qtyMilli: -3000 },
      { lineNo: 1, variantId: "v1", locationId: "deposito", qtyMilli: 3000 },
      { lineNo: 2, variantId: "v2", locationId: "tienda", qtyMilli: -500 },
      { lineNo: 2, variantId: "v2", locationId: "deposito", qtyMilli: 500 },
    ])
    expect(plan).toMatchObject({ totalMinor: 0, totalLegalMinor: 0, taxes: [], accountMoves: [] })
    expect(plan.lines.map((l) => l.lineTotalMinor)).toEqual([0, 0])
  })

  test("rechaza el mismo destino, cantidades no positivas, precios, servicios y pagos", () => {
    expect(codeOf(() => planPosting(transfer({ toLocationId: "tienda" }), book))).toBe(
      "INVALID_LINE",
    )
    const { toLocationId: _, ...noDestination } = transfer()
    expect(codeOf(() => planPosting(noDestination, book))).toBe("INVALID_LINE")
    expect(codeOf(() => planPosting(transfer({ lines: [ln(-1000, 0)] }), book))).toBe(
      "INVALID_LINE",
    )
    expect(codeOf(() => planPosting(transfer({ lines: [ln(1000, 10)] }), book))).toBe(
      "INVALID_LINE",
    )
    expect(
      codeOf(() => planPosting(transfer({ lines: [ln(1000, 0, { tracksStock: false })] }), book)),
    ).toBe("INVALID_LINE")
    expect(codeOf(() => planPosting(transfer({ lines: [] }), book))).toBe("EMPTY_DOCUMENT")
    expect(codeOf(() => planPosting(transfer({ payments: [pay("p", "VES", 1)] }), book))).toBe(
      "INVALID_PAYMENT",
    )
  })
})

describe("planPosting · propina", () => {
  test("los pagos cubren la venta, su IGTF y la propina, que no paga IGTF ni suma al total", () => {
    // 116,00 $ pagados en divisas con 10,00 $ de propina: IGTF sobre 116,00 $ (3,48 $).
    const plan = planPosting(
      sale({
        lines: [ln(1000, 11600, { tax: IVA })],
        payments: [{ ...pay("p1", "USD", 12948), surcharge: IGTF }],
        tipMinor: 1000,
      }),
      book,
    )
    expect(plan.totalMinor).toBe(11600)
    expect(plan.surchargeMinor).toBe(348)
    expect(plan.surcharges[0]?.baseMinor).toBe(11600)
    expect(plan).toMatchObject({ tipMinor: 1000, tipLegalMinor: 36500 })
    expect(plan.accountMoves.map((m) => m.amountMinor)).toEqual([12948])
  })

  test("sin cubrir la propina no cuadra; solo una venta la lleva", () => {
    expect(codeOf(() => planPosting(sale({ tipMinor: 100 }), book))).toBe("UNSETTLED")
    expect(codeOf(() => planPosting(sale({ tipMinor: -1 }), book))).toBe("INVALID_PAYMENT")
    expect(
      codeOf(() =>
        planPosting(
          sale({ type: "PURCHASE", payments: [pay("p1", "USD", 1100)], tipMinor: 100 }),
          book,
        ),
      ),
    ).toBe("INVALID_PAYMENT")
    expect(planPosting(sale(), book)).toMatchObject({ tipMinor: 0, tipLegalMinor: 0 })
  })
})

describe("planPosting · producción por tandas", () => {
  const production = (over: Partial<DocumentDraft> = {}) =>
    sale({
      type: "PRODUCTION",
      payments: [],
      lines: [ln(12_000, 0)],
      locationId: "cocina",
      ...over,
    })

  test("lo producido entra a la ubicación, sin dinero ni total", () => {
    const plan = planPosting(production(), book)
    expect(plan.stockMoves).toEqual([
      { lineNo: 1, variantId: "v1", locationId: "cocina", qtyMilli: 12_000 },
    ])
    expect(plan).toMatchObject({ totalMinor: 0, totalLegalMinor: 0, taxes: [], accountMoves: [] })
  })

  test("rechaza cantidades no positivas, precios, servicios y pagos", () => {
    expect(codeOf(() => planPosting(production({ lines: [ln(-1000, 0)] }), book))).toBe(
      "INVALID_LINE",
    )
    expect(codeOf(() => planPosting(production({ lines: [ln(1000, 10)] }), book))).toBe(
      "INVALID_LINE",
    )
    expect(
      codeOf(() => planPosting(production({ lines: [ln(1000, 0, { tracksStock: false })] }), book)),
    ).toBe("INVALID_LINE")
    expect(codeOf(() => planPosting(production({ lines: [] }), book))).toBe("EMPTY_DOCUMENT")
    expect(codeOf(() => planPosting(production({ payments: [pay("p", "USD", 1)] }), book))).toBe(
      "INVALID_PAYMENT",
    )
  })
})

describe("planPosting · PURCHASE y ADJUSTMENT", () => {
  test("la compra suma stock y saca dinero", () => {
    const plan = planPosting(sale({ type: "PURCHASE" }), book)
    expect(plan.stockMoves[0]?.qtyMilli).toBe(2000)
    expect(plan.accountMoves[0]?.amountMinor).toBe(-1000)
  })

  test("el ajuste lleva signo, no lleva precio ni pagos", () => {
    const adj = sale({ type: "ADJUSTMENT", payments: [], lines: [ln(-3000, 0)] })
    const plan = planPosting(adj, book)
    expect(plan.stockMoves[0]?.qtyMilli).toBe(-3000)
    expect(plan.totalMinor).toBe(0)
    expect(codeOf(() => planPosting({ ...adj, payments: [pay("p", "USD", 1)] }, book))).toBe(
      "INVALID_PAYMENT",
    )
    const priced = sale({ ...adj, lines: [ln(1000, 1)] })
    expect(codeOf(() => planPosting(priced, book))).toBe("INVALID_LINE")
  })
})

describe("propiedades", () => {
  test("pagando exactamente el total en Bs, la venta siempre cuadra", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 100_000 }),
        // USD→VES realista: de 1 a 50 Bs por dólar. Con una tasa casi nula el total legal
        // redondea a 0 y no hay pago válido que lo cubra.
        fc.integer({ min: 100_000_000, max: 5_000_000_000 }),
        (qty, price, scaled) => {
          const rate = exchangeRate("USD", "VES", (scaled / 1e8).toFixed(8))
          const lines = [ln(qty * 1000, price, { variantId: "v" })]
          const inUsd = sale({ rate, lines, payments: [pay("p", "USD", qty * price)] })
          const { totalLegalMinor } = planPosting(inUsd, book)
          const inBs = sale({
            rate,
            lines,
            payments: [{ ...pay("p", "VES", totalLegalMinor), rate }],
          })
          expect(() => planPosting(inBs, book)).not.toThrow()
        },
      ),
    )
  })

  test("settle: la diferencia es exacta y simétrica respecto al vuelto", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (total, extra) => {
          const s = settle(
            "USD",
            total,
            [pay("a", "USD", total + extra), pay("b", "USD", -extra)].map((p) => ({
              currency: p.currency,
              amountMinor: p.amountMinor,
              rate: p.rate,
            })),
            book,
          )
          expect(s.settled).toBe(true)
          expect(s.difference.toNumber()).toBe(0)
        },
      ),
    )
  })
})

describe("uuidv7", () => {
  test("tiene formato v7 y se ordena por tiempo", () => {
    const a = uuidv7(1_700_000_000_000)
    const b = uuidv7(1_700_000_000_001)
    expect(isUuidv7(a)).toBe(true)
    expect(a < b).toBe(true)
    expect(a.slice(0, 13)).toBe("018bcfe5-6800") // 1.7e12 ms en hex: 018bcfe56800
  })

  test("rechaza lo que no es v7", () => {
    expect(isUuidv7("not-a-uuid")).toBe(false)
    expect(isUuidv7(crypto.randomUUID())).toBe(false) // v4
  })
})

describe("planPosting · recargos de venta", () => {
  const delivery = { chargeId: "delivery", name: "Delivery", kind: "fixed" as const, rateBp: 0 }
  const service = {
    chargeId: "servicio",
    name: "Servicio",
    kind: "percent" as const,
    amountMinor: 0,
  }

  test("un recargo fijo sin IVA suma al total como no sujeto", () => {
    // 2 × 5,00 $ con IVA incluido + 2,00 $ de delivery.
    const plan = planPosting(
      sale({
        lines: [ln(2000, 500, { tax: IVA })],
        charges: [{ ...delivery, amountMinor: 200, tax: null }],
        payments: [pay("p1", "USD", 1200)],
      }),
      book,
    )
    expect(plan.totalMinor).toBe(1200)
    expect(plan.charges).toEqual([
      {
        position: 1,
        chargeId: "delivery",
        name: "Delivery",
        kind: "fixed",
        rateBp: 0,
        baseMinor: 0,
        amountMinor: 200,
        amountLegalMinor: 7300,
        taxId: null,
        taxRateBp: 0,
      },
    ])
    expect(plan.taxes.map((t) => [t.kind, t.baseMinor, t.taxMinor])).toEqual([
      ["taxed", 862, 138],
      ["not_subject", 200, 0],
    ])
  })

  test("un porcentaje se calcula sobre el subtotal sin IVA de los productos", () => {
    // Base 8,62 $ (10,00 con IVA): 10 % = 0,86 $ sin IVA.
    const plan = planPosting(
      sale({
        lines: [ln(2000, 500, { tax: IVA })],
        charges: [{ ...service, rateBp: 1000, tax: null }],
        payments: [pay("p1", "USD", 1086)],
      }),
      book,
    )
    expect(plan.charges[0]).toMatchObject({ baseMinor: 862, amountMinor: 86 })
    expect(plan.totalMinor).toBe(1086)
  })

  test("un porcentaje con IVA le suma su IVA si los precios lo incluyen", () => {
    const included = planPosting(
      sale({
        lines: [ln(2000, 500, { tax: IVA })],
        charges: [{ ...service, rateBp: 1000, tax: IVA }],
        payments: [pay("p1", "USD", 1100)],
      }),
      book,
    )
    // 0,86 + 16 % = 1,00 (0,9976 → 1,00 con el IVA redondeado aparte: 0,86 + 0,14).
    expect(included.charges[0]?.amountMinor).toBe(100)
    expect(included.taxes).toHaveLength(1)
    expect(included.totalMinor).toBe(1100)

    const excluded = planPosting(
      sale({
        pricesIncludeTax: false,
        lines: [ln(2000, 500, { tax: IVA })],
        charges: [{ ...service, rateBp: 1000, tax: IVA }],
        // Base 10,00 + recargo 1,00 = 11,00; IVA 16 % = 1,76.
        payments: [pay("p1", "USD", 1276)],
      }),
      book,
    )
    expect(excluded.charges[0]?.amountMinor).toBe(100)
    expect(excluded.taxes[0]).toMatchObject({ baseMinor: 1100, taxMinor: 176 })
  })

  test("el IGTF también cubre el recargo pagado en divisas", () => {
    const plan = planPosting(
      sale({
        lines: [ln(1000, 1000, { tax: EXEMPT })],
        charges: [{ ...delivery, amountMinor: 300, tax: null }],
        payments: [{ ...pay("p1", "USD", 1339), surcharge: IGTF }],
      }),
      book,
    )
    expect(plan.surcharges[0]).toMatchObject({ baseMinor: 1300, amountMinor: 39 })
  })

  test("los de monto cero no se guardan; repetidos, inválidos o fuera de una venta se rechazan", () => {
    const zero = planPosting(sale({ charges: [{ ...delivery, amountMinor: 0, tax: null }] }), book)
    expect(zero.charges).toEqual([])
    const twice = { ...delivery, amountMinor: 100, tax: null }
    expect(codeOf(() => planPosting(sale({ charges: [twice, twice] }), book))).toBe("INVALID_LINE")
    expect(
      codeOf(() =>
        planPosting(sale({ charges: [{ ...service, rateBp: 20_000, tax: null }] }), book),
      ),
    ).toBe("INVALID_LINE")
    expect(
      codeOf(() =>
        planPosting(sale({ charges: [{ ...delivery, amountMinor: -1, tax: null }] }), book),
      ),
    ).toBe("INVALID_LINE")
    expect(
      codeOf(() =>
        planPosting(
          sale({
            type: "PURCHASE",
            charges: [{ ...delivery, amountMinor: 100, tax: null }],
            payments: [{ ...pay("p1", "USD", 1100) }],
          }),
          book,
        ),
      ),
    ).toBe("INVALID_LINE")
  })
})
