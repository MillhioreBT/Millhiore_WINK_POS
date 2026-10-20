import { beforeEach, describe, expect, test } from "bun:test"
import { accountBalance, type Db, document, documentLine, documentTax } from "@millhiore/db"
import { PostingError, uuidv7 } from "@millhiore/domain"
import { eq, sql } from "drizzle-orm"
import { createTestDb, ctx, ids, RATE } from "./fixtures"
import { checkInvariants } from "./invariants"
import { type PostDocumentInput, postDocument, voidDocument } from "./post"

let db: Db
beforeEach(() => {
  db = createTestDb()
})

const usd = (amountMinor: number) => ({
  id: uuidv7(),
  paymentMethodId: ids.methodUsd,
  currency: "USD",
  amountMinor,
  rate: null,
})

/** Agua a 11,60 $ con IVA general incluido. */
const sale = (discountMinor: number, pay: number): PostDocumentInput => ({
  id: uuidv7(),
  type: "SALE",
  terminalId: ids.terminal,
  currency: "USD",
  rate: RATE,
  lines: [{ variantId: ids.water, qtyMilli: 1000, unitPriceMinor: 1160, discountMinor }],
  payments: pay > 0 ? [usd(pay)] : [],
})

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    if (e instanceof PostingError) return e.code
    throw e
  }
}

describe("descuentos", () => {
  test("el descuento baja el total de la línea y el IVA se calcula sobre lo que queda", () => {
    // 11,60 $ − 1,60 $ = 10,00 $ (IVA 16 % incluido: base 8,62, IVA 1,38)
    const posted = postDocument(db, sale(160, 1000), ctx())
    expect(posted.totalMinor).toBe(1000)
    const line = db.select().from(documentLine).get()
    expect(line).toMatchObject({ unitPriceMinor: 1160, discountMinor: 160, lineTotalMinor: 1000 })
    const tax = db.select().from(documentTax).get()
    expect(tax).toMatchObject({ baseMinor: 862, taxMinor: 138 })
    expect(db.select().from(document).get()).toMatchObject({
      discountMinor: 160,
      discountLegalMinor: 5840, // 1,60 $ × 36,5
    })
    expect(db.select().from(accountBalance).get()?.amountMinor).toBe(1000)
    expect(checkInvariants(db)).toEqual([])
  })

  test("sin descuento todo sigue igual", () => {
    const posted = postDocument(db, sale(0, 1160), ctx())
    expect(posted.totalMinor).toBe(1160)
    expect(db.select().from(document).get()?.discountMinor).toBe(0)
    expect(checkInvariants(db)).toEqual([])
  })

  test("hay que cobrar lo descontado, no el precio de lista", () => {
    expect(codeOf(() => postDocument(db, sale(160, 1160), ctx()))).toBe("UNSETTLED")
  })

  test("un descuento total deja la línea en cero", () => {
    const posted = postDocument(db, sale(1160, 0), ctx())
    expect(posted.totalMinor).toBe(0)
    expect(checkInvariants(db)).toEqual([])
  })

  test("no se descuenta más que el importe, ni en negativo, ni en compras", () => {
    expect(codeOf(() => postDocument(db, sale(1161, 0), ctx()))).toBe("INVALID_LINE")
    expect(codeOf(() => postDocument(db, sale(-1, 1160), ctx()))).toBe("INVALID_LINE")
    const purchase: PostDocumentInput = { ...sale(100, 1060), type: "PURCHASE" }
    expect(codeOf(() => postDocument(db, purchase, ctx()))).toBe("INVALID_LINE")
    expect(db.select().from(document).all()).toHaveLength(0)
  })

  test("anular una venta con descuento lo revierte todo y los libros cuadran", () => {
    const posted = postDocument(db, sale(160, 1000), ctx())
    const reversal = voidDocument(db, posted.id, uuidv7(), ctx())
    const original = db.select().from(document).where(eq(document.id, posted.id)).get()
    const reverse = db.select().from(document).where(eq(document.id, reversal.id)).get()
    expect(original?.discountMinor).toBe(160)
    expect(reverse).toMatchObject({ discountMinor: -160, discountLegalMinor: -5840 })
    const lines = db.select().from(documentLine).all()
    expect(lines.map((l) => l.discountMinor).sort((a, b) => a - b)).toEqual([-160, 160])
    expect(db.select().from(accountBalance).get()?.amountMinor).toBe(0)
    expect(checkInvariants(db)).toEqual([])
  })

  test("checkInvariants nota un total de línea que no cuadra con su descuento", () => {
    postDocument(db, sale(160, 1000), ctx())
    db.run(sql`drop trigger document_line_no_update`)
    db.run(sql`update document_line set discount_minor = 100`)
    const messages = checkInvariants(db).map((v) => v.message)
    expect(messages.some((m) => m.includes("cantidad × precio − descuento"))).toBe(true)
    expect(messages.some((m) => m.includes("suma de los de sus líneas"))).toBe(true)
  })
})
