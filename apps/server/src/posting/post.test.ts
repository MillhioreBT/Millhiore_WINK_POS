import { beforeEach, describe, expect, test } from "bun:test"
import {
  accountBalance,
  auditLog,
  type Db,
  document,
  documentLine,
  documentSequence,
  documentTax,
  outbox,
  payment,
  stockBalance,
  tax,
} from "@millhiore/db"
import { PostingError, uuidv7 } from "@millhiore/domain"
import { eq, sql } from "drizzle-orm"
import { createTestDb, ctx, ids, RATE } from "./fixtures"
import { checkInvariants } from "./invariants"
import { type PostDocumentInput, postDocument, voidDocument } from "./post"

let db: Db

beforeEach(() => {
  db = createTestDb()
})

const breadLine = (qty = 2000, price = 150) => ({
  variantId: ids.bread,
  qtyMilli: qty,
  unitPriceMinor: price,
})

const usdPayment = (amountMinor: number) => ({
  id: uuidv7(),
  paymentMethodId: ids.methodUsd,
  currency: "USD",
  amountMinor,
  rate: null,
})

const sale = (over: Partial<PostDocumentInput> = {}): PostDocumentInput => ({
  id: uuidv7(),
  type: "SALE",
  terminalId: ids.terminal,
  currency: "USD",
  rate: RATE,
  lines: [breadLine()],
  payments: [usdPayment(300)],
  ...over,
})

const stock = (variantId: string) =>
  db
    .select()
    .from(stockBalance)
    .all()
    .find((b) => b.variantId === variantId)?.qtyMilli ?? 0
const money = (accountId: string) =>
  db
    .select()
    .from(accountBalance)
    .all()
    .find((b) => b.accountId === accountId)?.amountMinor ?? 0
const count = (table: string) =>
  db.all<{ n: number }>(sql.raw(`select count(*) as n from ${table}`))[0]?.n

/** drizzle envuelve el error de SQLite: el mensaje del trigger viaja en `cause`. */
const expectImmutable = (statement: ReturnType<typeof sql>) => {
  let message = ""
  try {
    db.run(statement)
  } catch (e) {
    message = String((e as Error).cause ?? (e as Error).message)
  }
  expect(message).toMatch(/inmutable/)
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    if (e instanceof PostingError) return e.code
    throw e
  }
}

describe("postDocument", () => {
  test("una venta escribe documento, libros, proyecciones, auditoría y evento", () => {
    const posted = postDocument(db, sale(), ctx())
    expect(posted).toMatchObject({ number: "C1-000001", totalMinor: 300, totalLegalMinor: 10950 })
    expect(posted.duplicate).toBe(false)

    expect(stock(ids.bread)).toBe(-2000)
    expect(money(ids.cashUsd)).toBe(300)
    expect(count("document_line")).toBe(1)
    expect(count("payment")).toBe(1)
    expect(count("stock_move")).toBe(1)
    expect(count("account_move")).toBe(1)
    expect(db.select().from(auditLog).all()).toHaveLength(1)
    expect(db.select().from(outbox).all()[0]?.type).toBe("document.posted")
    expect(checkInvariants(db)).toEqual([])
  })

  test("numera por terminal y tipo", () => {
    postDocument(db, sale(), ctx())
    expect(postDocument(db, sale(), ctx()).number).toBe("C1-000002")
    const purchase = sale({ type: "PURCHASE" })
    expect(postDocument(db, purchase, ctx()).number).toBe("C1-CM-000001")
  })

  test("pago mixto con vuelto en otra moneda", () => {
    // total 3,00 USD; paga 10 USD y recibe de vuelto 255,50 Bs por efectivo en Bs
    const posted = postDocument(
      db,
      sale({
        payments: [
          usdPayment(1000),
          {
            id: uuidv7(),
            paymentMethodId: ids.methodVes,
            currency: "VES",
            amountMinor: -25550,
            rate: RATE,
          },
        ],
      }),
      ctx(),
    )
    expect(posted.totalMinor).toBe(300)
    expect(money(ids.cashUsd)).toBe(1000)
    expect(money(ids.cashVes)).toBe(-25550)
    expect(checkInvariants(db)).toEqual([])
  })

  test("los servicios no mueven existencias", () => {
    postDocument(
      db,
      sale({ lines: [{ variantId: ids.delivery, qtyMilli: 1000, unitPriceMinor: 300 }] }),
      ctx(),
    )
    expect(count("stock_move")).toBe(0)
    expect(checkInvariants(db)).toEqual([])
  })

  test("reenviar el mismo id es idempotente", () => {
    const input = sale()
    const first = postDocument(db, input, ctx())
    const again = postDocument(db, input, ctx({ now: 1_760_000_999_999 }))
    expect(again).toEqual({ ...first, duplicate: true })
    expect(count("document")).toBe(1)
    expect(stock(ids.bread)).toBe(-2000)
    expect(count("audit_log")).toBe(1)
  })

  test("el mismo id con otro contenido de tipo es un conflicto", () => {
    const input = sale()
    postDocument(db, input, ctx())
    expect(codeOf(() => postDocument(db, { ...input, type: "PURCHASE" }, ctx()))).toBe(
      "ID_CONFLICT",
    )
  })

  test("un fallo no deja nada escrito (rollback total)", () => {
    const bad = sale({ payments: [usdPayment(100)] }) // no cubre el total
    expect(codeOf(() => postDocument(db, bad, ctx()))).toBe("UNSETTLED")
    for (const table of [
      "document",
      "document_line",
      "document_tax",
      "document_surcharge",
      "payment",
      "stock_move",
      "account_move",
      "audit_log",
      "outbox",
      "document_sequence",
    ]) {
      expect(count(table)).toBe(0)
    }
  })

  test("un fallo tardío (stock) también revierte lo ya escrito", () => {
    const input = sale({ lines: [breadLine(5000)], payments: [usdPayment(750)] })
    expect(codeOf(() => postDocument(db, input, ctx({ allowNegativeStock: false })))).toBe(
      "INSUFFICIENT_STOCK",
    )
    expect(count("document")).toBe(0)
    expect(count("document_sequence")).toBe(0)
    expect(db.select().from(stockBalance).all()).toEqual([])
    // con stock suficiente sí pasa
    postDocument(
      db,
      sale({ type: "PURCHASE", lines: [breadLine(10_000, 100)], payments: [usdPayment(1000)] }),
      ctx(),
    )
    postDocument(db, input, ctx({ allowNegativeStock: false }))
    expect(stock(ids.bread)).toBe(5000)
  })

  test("valida referencias y métodos de pago", () => {
    const unknownVariant = sale({
      lines: [{ variantId: "nope", qtyMilli: 1000, unitPriceMinor: 1 }],
    })
    expect(codeOf(() => postDocument(db, unknownVariant, ctx()))).toBe("UNKNOWN_REFERENCE")
    expect(codeOf(() => postDocument(db, sale({ terminalId: "nope" }), ctx()))).toBe(
      "UNKNOWN_REFERENCE",
    )
    expect(codeOf(() => postDocument(db, sale({ id: "no-es-uuid" }), ctx()))).toBe(
      "UNKNOWN_REFERENCE",
    )

    const wrongCurrency = sale({ payments: [{ ...usdPayment(300), currency: "VES", rate: RATE }] })
    expect(codeOf(() => postDocument(db, wrongCurrency, ctx()))).toBe("CURRENCY_MISMATCH")

    const noReference = sale({
      payments: [
        {
          id: uuidv7(),
          paymentMethodId: ids.methodMobile,
          currency: "VES",
          amountMinor: 10950,
          rate: RATE,
        },
      ],
    })
    expect(codeOf(() => postDocument(db, noReference, ctx()))).toBe("INVALID_PAYMENT")
    const withReference = sale({
      payments: [
        {
          id: uuidv7(),
          paymentMethodId: ids.methodMobile,
          currency: "VES",
          amountMinor: 10950,
          rate: RATE,
          reference: "0123",
        },
      ],
    })
    postDocument(db, withReference, ctx())
    expect(money(ids.mobileVes)).toBe(10950)
  })

  test("compra y ajuste mueven el inventario en el sentido correcto", () => {
    postDocument(
      db,
      sale({ type: "PURCHASE", lines: [breadLine(10_000, 100)], payments: [usdPayment(1000)] }),
      ctx(),
    )
    expect(stock(ids.bread)).toBe(10_000)
    expect(money(ids.cashUsd)).toBe(-1000)
    postDocument(
      db,
      sale({
        type: "ADJUSTMENT",
        lines: [{ variantId: ids.bread, qtyMilli: -2500, unitPriceMinor: 0 }],
        payments: [],
      }),
      ctx(),
    )
    expect(stock(ids.bread)).toBe(7500)
    expect(checkInvariants(db)).toEqual([])
  })
})

describe("IVA e IGTF", () => {
  const waterLine = (price = 1160) => ({
    variantId: ids.water,
    qtyMilli: 1000,
    unitPriceMinor: price,
  })
  const zellePayment = (amountMinor: number) => ({
    id: uuidv7(),
    paymentMethodId: ids.methodZelle,
    currency: "USD",
    amountMinor,
    rate: null,
    reference: "zelle-1",
  })
  const taxRows = (documentId: string) =>
    db
      .select()
      .from(documentTax)
      .all()
      .filter((t) => t.documentId === documentId)

  test("precio con IVA incluido: el servidor desglosa base e IVA y los guarda", () => {
    const posted = postDocument(
      db,
      sale({ lines: [waterLine(), breadLine()], payments: [usdPayment(1460)] }),
      ctx(),
    )
    expect(posted.totalMinor).toBe(1460)
    expect(posted.taxes.map((t) => [t.taxId, t.baseMinor, t.taxMinor])).toEqual([
      ["iva-general", 1000, 160],
      ["exento", 300, 0],
    ])
    expect(taxRows(posted.id)).toHaveLength(2)
    const line = db
      .select()
      .from(documentLine)
      .all()
      .find((l) => l.variantId === ids.water)
    expect(line).toMatchObject({ taxId: "iva-general", taxRateBp: 1600 })
    expect(checkInvariants(db)).toEqual([])
  })

  test("precio sin IVA: se suma aparte", () => {
    const input = sale({ lines: [waterLine(1000)], payments: [usdPayment(1160)] })
    const posted = postDocument(db, input, ctx({ fiscal: { pricesIncludeTax: false } }))
    expect(posted.totalMinor).toBe(1160)
    expect(checkInvariants(db)).toEqual([])
  })

  test("las compras van sin IVA incluido salvo que el documento diga otra cosa", () => {
    const purchase = sale({
      type: "PURCHASE",
      lines: [waterLine(1000)],
      payments: [usdPayment(1160)],
    })
    expect(postDocument(db, purchase, ctx()).totalMinor).toBe(1160)
    const included = sale({
      type: "PURCHASE",
      pricesIncludeTax: true,
      lines: [waterLine(1160)],
      payments: [usdPayment(1160)],
    })
    expect(postDocument(db, included, ctx()).taxes[0]).toMatchObject({ baseMinor: 1000 })
    expect(checkInvariants(db)).toEqual([])
  })

  test("quien no cobra IVA vende sin impuesto", () => {
    const posted = postDocument(
      db,
      sale({ lines: [waterLine()], payments: [usdPayment(1160)] }),
      ctx({ fiscal: { taxpayer: "none" } }),
    )
    expect(posted.taxes).toEqual([
      expect.objectContaining({ taxId: null, kind: "not_subject", baseMinor: 1160, taxMinor: 0 }),
    ])
    expect(checkInvariants(db)).toEqual([])
  })

  test("cambiar la alícuota no altera los documentos ya emitidos", () => {
    postDocument(db, sale({ lines: [waterLine()], payments: [usdPayment(1160)] }), ctx())
    db.update(tax).set({ rateBp: 1800 }).where(eq(tax.id, "iva-general")).run()
    expect(checkInvariants(db)).toEqual([])
    const after = postDocument(
      db,
      sale({ lines: [waterLine(1180)], payments: [usdPayment(1180)] }),
      ctx(),
    )
    expect(after.taxes[0]).toMatchObject({ rateBp: 1800, baseMinor: 1000, taxMinor: 180 })
  })

  test("Zelle cobra IGTF sobre la parte pagada en divisas; Bs no", () => {
    // 11,60 $: 5,00 $ en Bs (182,50) + 6,60 $ por Zelle → IGTF 3 % de 6,60 = 0,20 $
    const posted = postDocument(
      db,
      sale({
        lines: [waterLine()],
        payments: [
          {
            id: uuidv7(),
            paymentMethodId: ids.methodVes,
            currency: "VES",
            amountMinor: 18250,
            rate: RATE,
          },
          zellePayment(680),
        ],
      }),
      ctx(),
    )
    expect(posted).toMatchObject({ totalMinor: 1160, surchargeMinor: 20 })
    expect(posted.surcharges).toEqual([
      {
        surchargeId: "igtf",
        rateBp: 300,
        baseMinor: 660,
        amountMinor: 20,
        baseLegalMinor: 24090,
        amountLegalMinor: 723,
      },
    ])
    const pay = db
      .select()
      .from(payment)
      .all()
      .find((p) => p.paymentMethodId === ids.methodZelle)
    expect(pay).toMatchObject({ surchargeId: "igtf", surchargeRateBp: 300 })
    expect(money(ids.zelle)).toBe(680)
    expect(checkInvariants(db)).toEqual([])
  })

  test("sin el IGTF el pago por Zelle no cuadra", () => {
    const input = sale({ lines: [waterLine()], payments: [zellePayment(1160)] })
    expect(codeOf(() => postDocument(db, input, ctx()))).toBe("UNSETTLED")
  })

  test("en compras no se cobra IGTF aunque el método lo tenga", () => {
    const purchase = sale({ type: "PURCHASE", lines: [breadLine()], payments: [zellePayment(300)] })
    expect(postDocument(db, purchase, ctx()).surchargeMinor).toBe(0)
    expect(checkInvariants(db)).toEqual([])
  })

  test("anular revierte IVA e IGTF con signo contrario", () => {
    const original = postDocument(
      db,
      sale({ lines: [waterLine()], payments: [zellePayment(1195)] }),
      ctx(),
    )
    expect(original.surchargeMinor).toBe(35) // 3 % de 11,60 = 0,348 → 0,35
    const reversal = voidDocument(db, original.id, uuidv7(), ctx())
    expect(reversal).toMatchObject({ totalMinor: -1160, surchargeMinor: -35 })
    expect(reversal.taxes[0]).toMatchObject({ baseMinor: -1000, taxMinor: -160 })
    expect(reversal.surcharges[0]).toMatchObject({ baseMinor: -1160, amountMinor: -35 })
    expect(money(ids.zelle)).toBe(0)
    expect(checkInvariants(db)).toEqual([])
  })

  test("checkInvariants detecta un desglose manipulado", () => {
    postDocument(db, sale({ lines: [waterLine()], payments: [zellePayment(1195)] }), ctx())
    db.run(sql`drop trigger document_tax_no_update`)
    db.run(sql`drop trigger document_surcharge_no_update`)
    db.run(sql`update document_tax set tax_minor = 150, base_minor = 1010`)
    db.run(sql`update document_surcharge set amount_minor = 0`)
    const messages = checkInvariants(db)
      .filter((v) => v.invariant === 5)
      .map((v) => v.message)
    expect(messages.some((m) => m.includes("IVA"))).toBe(true)
    expect(messages.some((m) => m.includes("recargos"))).toBe(true)
  })
})

describe("voidDocument", () => {
  test("genera un reverso y deja los saldos como al inicio", () => {
    const original = postDocument(db, sale(), ctx())
    const reversal = voidDocument(db, original.id, uuidv7(), ctx(), "error de cajero")

    expect(reversal).toMatchObject({ number: "C1-000002", totalMinor: -300, duplicate: false })
    expect(stock(ids.bread)).toBe(0)
    expect(money(ids.cashUsd)).toBe(0)
    expect(count("stock_move")).toBe(2)
    expect(count("account_move")).toBe(2)
    expect(
      db
        .select()
        .from(document)
        .all()
        .find((d) => d.id === reversal.id)?.reversesDocumentId,
    ).toBe(original.id)
    expect(
      db
        .select()
        .from(outbox)
        .all()
        .map((o) => o.type),
    ).toEqual(["document.posted", "document.voided"])
    expect(checkInvariants(db)).toEqual([])
  })

  test("el original queda intacto y no se puede anular dos veces", () => {
    const original = postDocument(db, sale(), ctx())
    voidDocument(db, original.id, uuidv7(), ctx())
    const row = db
      .select()
      .from(document)
      .all()
      .find((d) => d.id === original.id)
    expect(row?.totalMinor).toBe(300)
    expect(codeOf(() => voidDocument(db, original.id, uuidv7(), ctx()))).toBe("ALREADY_REVERSED")
  })

  test("un reverso no se anula, y reintentar con el mismo id es idempotente", () => {
    const original = postDocument(db, sale(), ctx())
    const reversalId = uuidv7()
    const first = voidDocument(db, original.id, reversalId, ctx())
    expect(voidDocument(db, original.id, reversalId, ctx())).toEqual({ ...first, duplicate: true })
    expect(codeOf(() => voidDocument(db, reversalId, uuidv7(), ctx()))).toBe("NOT_REVERSIBLE")
    expect(codeOf(() => voidDocument(db, "nope", uuidv7(), ctx()))).toBe("UNKNOWN_REFERENCE")
    expect(count("document")).toBe(2)
  })

  test("anular una compra con el stock ya vendido respeta la regla de stock", () => {
    const purchase = postDocument(
      db,
      sale({ type: "PURCHASE", lines: [breadLine(2000, 100)], payments: [usdPayment(200)] }),
      ctx(),
    )
    postDocument(db, sale(), ctx()) // vende las 2 unidades
    expect(
      codeOf(() => voidDocument(db, purchase.id, uuidv7(), ctx({ allowNegativeStock: false }))),
    ).toBe("INSUFFICIENT_STOCK")
    expect(count("document")).toBe(2)
    voidDocument(db, purchase.id, uuidv7(), ctx({ allowNegativeStock: true }))
    expect(stock(ids.bread)).toBe(-2000)
    expect(checkInvariants(db)).toEqual([])
  })
})

describe("inmutabilidad", () => {
  test("no se puede editar ni borrar un documento contabilizado", () => {
    postDocument(db, sale(), ctx())
    expectImmutable(sql`update document set total_minor = 1`)
    expectImmutable(sql`delete from stock_move`)
    expectImmutable(sql`update account_move set amount_minor = 1`)
  })

  test("checkInvariants detecta una proyección manipulada", () => {
    postDocument(db, sale(), ctx())
    db.run(sql`update stock_balance set qty_milli = 999`)
    db.run(sql`update account_balance set amount_minor = 1`)
    const found = checkInvariants(db).map((v) => v.invariant)
    expect(found).toEqual(expect.arrayContaining([1, 2]))
  })

  test("checkInvariants detecta la falta de un trigger", () => {
    db.run(sql`drop trigger payment_no_update`)
    expect(checkInvariants(db).some((v) => v.invariant === 4)).toBe(true)
  })

  test("checkInvariants no marca falsos positivos tras varias operaciones", () => {
    for (let i = 0; i < 5; i++) postDocument(db, sale(), ctx())
    expect(db.select().from(documentSequence).all()[0]?.lastNumber).toBe(5)
    expect(checkInvariants(db)).toEqual([])
  })
})
