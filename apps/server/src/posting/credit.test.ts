import { beforeEach, describe, expect, test } from "bun:test"
import { accountBalance, allocation, contact, type Db, document } from "@millhiore/db"
import { PostingError, uuidv7 } from "@millhiore/domain"
import { eq, sql } from "drizzle-orm"
import { createTestDb, ctx, ids, RATE } from "./fixtures"
import { checkInvariants } from "./invariants"
import { type PostDocumentInput, postDocument, voidDocument } from "./post"
import { collectedOn, openSales, owedInReference } from "./receivables"

let db: Db

const NOW = 1_760_000_000_000
const DAY = 86_400_000

beforeEach(() => {
  db = createTestDb()
  db.insert(contact)
    .values([
      { id: "ana", kind: "customer", name: "Ana", creditDays: 7, createdAt: NOW },
      { id: "beto", kind: "both", name: "Beto", createdAt: NOW },
      { id: "prov", kind: "supplier", name: "Proveedor", createdAt: NOW },
      { id: "tope", kind: "customer", name: "Con tope", creditLimitMinor: 250, createdAt: NOW },
    ])
    .run()
})

const usd = (amountMinor: number) => ({
  id: uuidv7(),
  paymentMethodId: ids.methodUsd,
  currency: "USD",
  amountMinor,
  rate: null,
})
const zelle = (amountMinor: number) => ({
  id: uuidv7(),
  paymentMethodId: ids.methodZelle,
  currency: "USD",
  amountMinor,
  rate: null,
  reference: "z-1",
})
const bolivares = (amountMinor: number) => ({
  id: uuidv7(),
  paymentMethodId: ids.methodVes,
  currency: "VES",
  amountMinor,
  rate: RATE,
})

/** 2 panes a 1,50 $ = 3,00 $ (el pan está exento de IVA). */
const sale = (over: Partial<PostDocumentInput> = {}): PostDocumentInput => ({
  id: uuidv7(),
  type: "SALE",
  terminalId: ids.terminal,
  currency: "USD",
  rate: RATE,
  lines: [{ variantId: ids.bread, qtyMilli: 2000, unitPriceMinor: 150 }],
  payments: [],
  contactId: "ana",
  creditMinor: 300,
  ...over,
})

const collect = (
  allocations: { saleDocumentId: string; amountMinor: number }[],
  payments: PostDocumentInput["payments"],
  over: Partial<PostDocumentInput> = {},
): PostDocumentInput => ({
  id: uuidv7(),
  type: "PAYMENT_IN",
  terminalId: ids.terminal,
  currency: "USD",
  rate: RATE,
  lines: [],
  payments,
  contactId: "ana",
  allocations,
  ...over,
})

const cash = (accountId: string) =>
  db
    .select()
    .from(accountBalance)
    .all()
    .find((b) => b.accountId === accountId)?.amountMinor ?? 0
const owed = (contactId = "ana") =>
  openSales(db, { contactId }).reduce((acc, s) => acc + s.outstandingMinor, 0)
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    if (e instanceof PostingError) return e.code
    throw e
  }
}

describe("venta a crédito (fiado)", () => {
  test("todo fiado: sale la mercancía, no entra dinero y queda por cobrar", () => {
    const posted = postDocument(db, sale(), ctx())
    expect(posted).toMatchObject({ totalMinor: 300, creditMinor: 300, surchargeMinor: 0 })
    expect(cash(ids.cashUsd)).toBe(0)
    expect(owed()).toBe(300)
    expect(checkInvariants(db)).toEqual([])
  })

  test("pago parcial: se cobra una parte y el resto queda a deber", () => {
    postDocument(db, sale({ creditMinor: 200, payments: [usd(100)] }), ctx())
    expect(cash(ids.cashUsd)).toBe(100)
    expect(owed()).toBe(200)
    expect(checkInvariants(db)).toEqual([])
  })

  test("el plazo sale de los días de crédito del cliente al vender", () => {
    const posted = postDocument(db, sale(), ctx())
    expect(posted.dueAt).toBe(NOW + 7 * DAY)
    expect(postDocument(db, sale({ contactId: "beto" }), ctx()).dueAt).toBeNull()
  })

  test("los pagos más lo fiado deben igualar el total", () => {
    expect(codeOf(() => postDocument(db, sale({ creditMinor: 200 }), ctx()))).toBe("UNSETTLED")
    expect(
      codeOf(() => postDocument(db, sale({ creditMinor: 100, payments: [usd(300)] }), ctx())),
    ).toBe("UNSETTLED")
    expect(codeOf(() => postDocument(db, sale({ creditMinor: 301 }), ctx()))).toBe(
      "INVALID_PAYMENT",
    )
    // Una compra sí se puede dejar a deber, pero a un proveedor: sin él no hay a quién deberle.
    expect(
      codeOf(() => postDocument(db, sale({ type: "PURCHASE", creditMinor: 300 }), ctx())),
    ).toBe("CREDIT_DENIED")
  })

  test("exige un cliente, y no un proveedor ni nadie", () => {
    expect(codeOf(() => postDocument(db, sale({ contactId: null }), ctx()))).toBe("CREDIT_DENIED")
    expect(codeOf(() => postDocument(db, sale({ contactId: "prov" }), ctx()))).toBe("CREDIT_DENIED")
    expect(db.select().from(document).all()).toHaveLength(0)
  })

  test("se puede apagar el fiado en los ajustes", () => {
    expect(codeOf(() => postDocument(db, sale(), ctx({ creditEnabled: false })))).toBe(
      "CREDIT_DENIED",
    )
    // Las ventas normales siguen funcionando.
    const cashSale = sale({ creditMinor: 0, payments: [usd(300)], contactId: null })
    expect(() => postDocument(db, cashSale, ctx({ creditEnabled: false }))).not.toThrow()
  })

  test("el límite de crédito cuenta todo lo que ya debe", () => {
    const first = sale({ contactId: "tope", creditMinor: 200, payments: [usd(100)] })
    postDocument(db, first, ctx())
    // Debe 2,00 $ de 2,50 $: otros 3,00 $ fiados pasan el tope.
    expect(codeOf(() => postDocument(db, sale({ contactId: "tope" }), ctx()))).toBe("CREDIT_DENIED")
    // Con 0,50 $ fiados queda justo en el tope.
    const small = sale({
      contactId: "tope",
      lines: [{ variantId: ids.bread, qtyMilli: 1000, unitPriceMinor: 50 }],
      creditMinor: 50,
    })
    expect(() => postDocument(db, small, ctx())).not.toThrow()
    expect(owed("tope")).toBe(250)
  })

  test("el IGTF solo se cobra sobre lo que se paga ahora en divisas", () => {
    // 1,00 $ por Zelle + 2,00 $ fiados: IGTF 3 % de 1,00 = 0,03 $
    const posted = postDocument(db, sale({ creditMinor: 200, payments: [zelle(103)] }), ctx())
    expect(posted).toMatchObject({ totalMinor: 300, surchargeMinor: 3, creditMinor: 200 })
    expect(posted.surcharges[0]).toMatchObject({ baseMinor: 100, amountMinor: 3 })
    expect(checkInvariants(db)).toEqual([])
  })

  test("anular una venta fiada borra la deuda; sin movimiento de dinero", () => {
    const posted = postDocument(db, sale(), ctx())
    const reversal = voidDocument(db, posted.id, uuidv7(), ctx())
    expect(reversal.creditMinor).toBe(-300)
    expect(owed()).toBe(0)
    expect(checkInvariants(db)).toEqual([])
  })
})

describe("abonos", () => {
  test("un abono baja lo que se debe y mete el dinero en la caja", () => {
    const s = postDocument(db, sale(), ctx())
    const abono = postDocument(
      db,
      collect([{ saleDocumentId: s.id, amountMinor: 100 }], [usd(100)]),
      ctx(),
    )
    expect(abono).toMatchObject({ number: "C1-AB-000001", totalMinor: 100, creditMinor: 0 })
    expect(owed()).toBe(200)
    expect(cash(ids.cashUsd)).toBe(100)
    expect(collectedOn(db, s.id)).toBe(100)
    expect(checkInvariants(db)).toEqual([])
  })

  test("un abono puede pagar varias ventas y saldar una", () => {
    const a = postDocument(db, sale(), ctx())
    const b = postDocument(db, sale(), ctx())
    postDocument(
      db,
      collect(
        [
          { saleDocumentId: a.id, amountMinor: 300 },
          { saleDocumentId: b.id, amountMinor: 50 },
        ],
        [usd(350)],
      ),
      ctx(),
    )
    expect(openSales(db, { contactId: "ana" }).map((s) => [s.id, s.outstandingMinor])).toEqual([
      [b.id, 250],
    ])
    expect(checkInvariants(db)).toEqual([])
  })

  test("se puede pagar en bolívares con la tasa del día", () => {
    const s = postDocument(db, sale(), ctx())
    // 2,00 $ × 36,5 = 73,00 Bs
    postDocument(
      db,
      collect([{ saleDocumentId: s.id, amountMinor: 200 }], [bolivares(7300)]),
      ctx(),
    )
    expect(owed()).toBe(100)
    expect(cash(ids.cashVes)).toBe(7300)
    expect(checkInvariants(db)).toEqual([])
  })

  test("un abono en divisas por Zelle paga también el IGTF", () => {
    const s = postDocument(db, sale(), ctx())
    // abona 2,00 $ → IGTF 0,06 $ → entrega 2,06 $
    const abono = postDocument(
      db,
      collect([{ saleDocumentId: s.id, amountMinor: 200 }], [zelle(206)]),
      ctx(),
    )
    expect(abono).toMatchObject({ totalMinor: 200, surchargeMinor: 6 })
    expect(owed()).toBe(100)
    expect(cash(ids.zelle)).toBe(206)
    expect(checkInvariants(db)).toEqual([])
    expect(
      codeOf(() =>
        postDocument(
          db,
          collect([{ saleDocumentId: s.id, amountMinor: 100 }], [zelle(100)]),
          ctx(),
        ),
      ),
    ).toBe("UNSETTLED")
  })

  test("no se abona más de lo que se debe, ni a ventas ajenas o inexistentes", () => {
    const s = postDocument(db, sale(), ctx())
    const other = postDocument(db, sale({ contactId: "beto" }), ctx())
    const over = collect([{ saleDocumentId: s.id, amountMinor: 301 }], [usd(301)])
    expect(codeOf(() => postDocument(db, over, ctx()))).toBe("INVALID_ALLOCATION")
    const alien = collect([{ saleDocumentId: other.id, amountMinor: 100 }], [usd(100)])
    expect(codeOf(() => postDocument(db, alien, ctx()))).toBe("INVALID_ALLOCATION")
    const ghost = collect([{ saleDocumentId: uuidv7(), amountMinor: 100 }], [usd(100)])
    expect(codeOf(() => postDocument(db, ghost, ctx()))).toBe("INVALID_ALLOCATION")
    expect(codeOf(() => postDocument(db, collect([], [usd(100)]), ctx()))).toBe(
      "INVALID_ALLOCATION",
    )
    const twice = collect(
      [
        { saleDocumentId: s.id, amountMinor: 100 },
        { saleDocumentId: s.id, amountMinor: 100 },
      ],
      [usd(200)],
    )
    expect(codeOf(() => postDocument(db, twice, ctx()))).toBe("INVALID_ALLOCATION")
    expect(owed()).toBe(300)
  })

  test("un abono sin cliente o de un proveedor se rechaza", () => {
    const s = postDocument(db, sale(), ctx())
    const part = [{ saleDocumentId: s.id, amountMinor: 100 }]
    expect(
      codeOf(() => postDocument(db, collect(part, [usd(100)], { contactId: null }), ctx())),
    ).toBe("INVALID_ALLOCATION")
    expect(
      codeOf(() => postDocument(db, collect(part, [usd(100)], { contactId: "prov" }), ctx())),
    ).toBe("INVALID_ALLOCATION")
  })

  test("los pagos deben cubrir justo lo que se abona", () => {
    const s = postDocument(db, sale(), ctx())
    const part = [{ saleDocumentId: s.id, amountMinor: 100 }]
    expect(codeOf(() => postDocument(db, collect(part, [usd(50)]), ctx()))).toBe("UNSETTLED")
    expect(codeOf(() => postDocument(db, collect(part, [usd(150)]), ctx()))).toBe("UNSETTLED")
  })

  test("reenviar el mismo abono es idempotente", () => {
    const s = postDocument(db, sale(), ctx())
    const input = collect([{ saleDocumentId: s.id, amountMinor: 100 }], [usd(100)])
    postDocument(db, input, ctx())
    expect(postDocument(db, input, ctx()).duplicate).toBe(true)
    expect(owed()).toBe(200)
    expect(db.select().from(allocation).all()).toHaveLength(1)
  })

  test("anular un abono devuelve la deuda y saca el dinero", () => {
    const s = postDocument(db, sale(), ctx())
    const abono = postDocument(
      db,
      collect([{ saleDocumentId: s.id, amountMinor: 300 }], [usd(300)]),
      ctx(),
    )
    expect(owed()).toBe(0)
    voidDocument(db, abono.id, uuidv7(), ctx())
    expect(owed()).toBe(300)
    expect(cash(ids.cashUsd)).toBe(0)
    expect(checkInvariants(db)).toEqual([])
  })

  test("una venta con abonos no se anula hasta anular sus abonos", () => {
    const s = postDocument(db, sale(), ctx())
    const abono = postDocument(
      db,
      collect([{ saleDocumentId: s.id, amountMinor: 100 }], [usd(100)]),
      ctx(),
    )
    expect(codeOf(() => voidDocument(db, s.id, uuidv7(), ctx()))).toBe("HAS_COLLECTIONS")
    voidDocument(db, abono.id, uuidv7(), ctx())
    expect(() => voidDocument(db, s.id, uuidv7(), ctx())).not.toThrow()
    expect(owed()).toBe(0)
    expect(checkInvariants(db)).toEqual([])
  })

  test("las asignaciones son inmutables y checkInvariants nota si no cuadran", () => {
    const s = postDocument(db, sale(), ctx())
    postDocument(db, collect([{ saleDocumentId: s.id, amountMinor: 100 }], [usd(100)]), ctx())
    let message = ""
    try {
      db.run(sql`update allocation set amount_minor = 5`)
    } catch (e) {
      message = String((e as Error).cause ?? (e as Error).message)
    }
    expect(message).toMatch(/inmutable/)

    // Saltándose el trigger a propósito: la auditoría debe notarlo.
    db.run(sql`drop trigger allocation_no_update`)
    db.run(sql`update allocation set amount_minor = 5`)
    const messages = checkInvariants(db).map((v) => v.message)
    expect(messages.some((m) => m.includes("no es la suma de lo que aplica"))).toBe(true)
    expect(messages.some((m) => m.includes("allocation_no_update"))).toBe(true)
  })

  test("la deuda en otra moneda se lleva a la referencia con la tasa de su venta", () => {
    const s = postDocument(db, sale(), ctx())
    const rows = openSales(db, { contactId: "ana" })
    expect(rows[0]?.id).toBe(s.id)
    const book = {
      USD: { code: "USD", decimals: 2 },
      VES: { code: "VES", decimals: 2 },
    }
    // Una deuda de 36,50 Bs a 36,5 Bs/$ vale 1,00 $.
    expect(
      owedInReference([{ currency: "VES", outstandingMinor: 3650, rate: RATE }], "USD", book),
    ).toBe(100)
    // Sin tasa que sirva no se puede convertir y no suma.
    expect(
      owedInReference([{ currency: "VES", outstandingMinor: 3650, rate: null }], "USD", book),
    ).toBe(0)
  })
})

describe("el fiado no rompe lo demás", () => {
  test("un documento normal sigue con crédito cero", () => {
    const cashSale = sale({ creditMinor: 0, payments: [usd(300)], contactId: null })
    const posted = postDocument(db, cashSale, ctx())
    expect(posted.creditMinor).toBe(0)
    expect(posted.dueAt).toBeNull()
    expect(db.select().from(document).where(eq(document.id, posted.id)).get()?.creditMinor).toBe(0)
  })
})

describe("la caja real: ventas en bolívares con la deuda en dólares", () => {
  // 2 panes a 54,75 Bs (1,50 $ a 36,5) = 109,50 Bs. Se pagan 36,50 Bs y 2,00 $ (73,00 Bs) se fían.
  const vesSale = (over: Partial<PostDocumentInput> = {}): PostDocumentInput =>
    sale({
      currency: "VES",
      lines: [{ variantId: ids.bread, qtyMilli: 2000, unitPriceMinor: 5475 }],
      payments: [bolivares(3650)],
      creditMinor: 200,
      ...over,
    })

  test("la deuda queda en dólares aunque la factura sea en bolívares", () => {
    const posted = postDocument(db, vesSale(), ctx())
    expect(posted).toMatchObject({ totalMinor: 10950, creditMinor: 200, creditCurrency: "USD" })
    expect(db.select().from(document).get()?.creditLegalMinor).toBe(7300)
    expect(cash(ids.cashVes)).toBe(3650)
    expect(openSales(db, { contactId: "ana" })[0]).toMatchObject({
      currency: "USD",
      outstandingMinor: 200,
    })
    expect(checkInvariants(db)).toEqual([])
  })

  test("el redondeo de la deuda en dólares tiene la holgura de medio centavo", () => {
    // 2,00 $ son 73,00 Bs: 0,05 Bs de más o de menos es redondeo; 0,50 Bs no.
    expect(() => postDocument(db, vesSale({ payments: [bolivares(3655)] }), ctx())).not.toThrow()
    expect(codeOf(() => postDocument(db, vesSale({ payments: [bolivares(3700)] }), ctx()))).toBe(
      "UNSETTLED",
    )
    expect(codeOf(() => postDocument(db, vesSale({ creditMinor: 400 }), ctx()))).toBe(
      "INVALID_PAYMENT",
    )
  })

  test("sin tasa no se puede llevar una deuda en dólares a una factura en bolívares", () => {
    expect(codeOf(() => postDocument(db, vesSale({ rate: null }), ctx()))).toBe("MISSING_RATE")
  })

  test("el abono se hace en dólares y se paga con bolívares a la tasa del día", () => {
    const s = postDocument(db, vesSale(), ctx())
    postDocument(
      db,
      collect([{ saleDocumentId: s.id, amountMinor: 100 }], [bolivares(3650)]),
      ctx(),
    )
    expect(owed()).toBe(100)
    expect(cash(ids.cashVes)).toBe(3650 + 3650)
    // Un abono en bolívares no cuadra con una deuda en dólares.
    const inVes = collect([{ saleDocumentId: s.id, amountMinor: 100 }], [bolivares(3650)], {
      currency: "VES",
    })
    expect(codeOf(() => postDocument(db, inVes, ctx()))).toBe("CURRENCY_MISMATCH")
    expect(checkInvariants(db)).toEqual([])
  })

  test("el límite de crédito (en dólares) cuenta las ventas hechas en bolívares", () => {
    postDocument(db, vesSale({ contactId: "tope" }), ctx())
    // Debe 2,00 $ de 2,50 $: otros 2,00 $ pasan el tope.
    expect(codeOf(() => postDocument(db, vesSale({ contactId: "tope" }), ctx()))).toBe(
      "CREDIT_DENIED",
    )
    expect(owed("tope")).toBe(200)
  })

  test("anular la venta borra la deuda y deja los libros cuadrados", () => {
    const s = postDocument(db, vesSale(), ctx())
    const reversal = voidDocument(db, s.id, uuidv7(), ctx())
    expect(reversal).toMatchObject({ creditMinor: -200, creditCurrency: "USD" })
    expect(owed()).toBe(0)
    expect(cash(ids.cashVes)).toBe(0)
    expect(checkInvariants(db)).toEqual([])
  })
})
