import { describe, expect, test } from "bun:test"
import { uuidv7 } from "@millhiore/domain"
import {
  exchangeRateSchema,
  postDocumentSchema,
  postPaymentSchema,
  setupSchema,
  voidDocumentSchema,
} from "./index"

const validSale = () => ({
  id: uuidv7(),
  type: "SALE",
  terminalId: "t1",
  currency: "USD",
  lines: [{ variantId: "v1", qtyMilli: 1000, unitPriceMinor: 150 }],
  payments: [{ id: uuidv7(), paymentMethodId: "m1", currency: "USD", amountMinor: 150 }],
})

const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((i) => i.path.join(".")) ?? []

describe("postDocumentSchema", () => {
  test("acepta una venta válida y rellena los valores por defecto", () => {
    const parsed = postDocumentSchema.parse(validSale())
    expect(parsed.rate).toBeNull()
    expect(parsed.payments[0]?.rate).toBeNull()
  })

  test("los ajustes no llevan pagos y por eso `payments` es opcional", () => {
    const { payments: _omit, ...adjustment } = validSale()
    const parsed = postDocumentSchema.parse({ ...adjustment, type: "ADJUSTMENT" })
    expect(parsed.payments).toEqual([])
  })

  test("exige UUIDv7 en el documento y en cada pago", () => {
    const bad = { ...validSale(), id: crypto.randomUUID() } // v4
    expect(issuePaths(postDocumentSchema.safeParse(bad))).toContain("id")
    const badPayment = validSale()
    badPayment.payments[0] = { ...badPayment.payments[0], id: "x" } as never
    expect(issuePaths(postDocumentSchema.safeParse(badPayment))).toContain("payments.0.id")
  })

  test("rechaza tipos que el motor aún no contabiliza", () => {
    expect(postDocumentSchema.safeParse({ ...validSale(), type: "QUOTE" }).success).toBe(false)
  })

  test("rechaza decimales, cero y enteros inseguros en cantidades y montos", () => {
    const line = (qtyMilli: number, unitPriceMinor = 1) => ({
      ...validSale(),
      lines: [{ variantId: "v", qtyMilli, unitPriceMinor }],
    })
    expect(postDocumentSchema.safeParse(line(1.5)).success).toBe(false)
    expect(postDocumentSchema.safeParse(line(0)).success).toBe(false)
    expect(postDocumentSchema.safeParse(line(Number.MAX_SAFE_INTEGER + 1)).success).toBe(false)
    expect(postDocumentSchema.safeParse(line(1000, -1)).success).toBe(false)
    expect(
      postPaymentSchema.safeParse({ ...validSale().payments[0], amountMinor: 0 }).success,
    ).toBe(false)
    // el vuelto es un pago negativo y es válido
    expect(
      postPaymentSchema.safeParse({ ...validSale().payments[0], amountMinor: -500 }).success,
    ).toBe(true)
  })

  test("limita el tamaño del documento", () => {
    const line = { variantId: "v", qtyMilli: 1000, unitPriceMinor: 1 }
    // Sin líneas es válido como forma (ingresos y retiros de caja); el dominio rechaza una venta vacía.
    expect(postDocumentSchema.safeParse({ ...validSale(), lines: [] }).success).toBe(true)
    expect(
      postDocumentSchema.safeParse({ ...validSale(), lines: Array(501).fill(line) }).success,
    ).toBe(false)
  })
})

describe("exchangeRateSchema", () => {
  const rate = (value: string) =>
    exchangeRateSchema.safeParse({ base: "USD", quote: "VES", value }).success

  test("solo admite decimales con punto y hasta 8 cifras", () => {
    expect(rate("879.1225")).toBe(true)
    expect(rate("879.12250000")).toBe(true)
    expect(rate("879,1225")).toBe(false)
    expect(rate("879.122500001")).toBe(false)
    expect(rate("-1")).toBe(false)
    expect(rate("abc")).toBe(false)
  })

  test("valida el código de moneda", () => {
    expect(exchangeRateSchema.safeParse({ base: "usd", quote: "VES", value: "1" }).success).toBe(
      false,
    )
    expect(exchangeRateSchema.safeParse({ base: "USDT", quote: "VES", value: "1" }).success).toBe(
      true,
    )
  })
})

describe("setupSchema", () => {
  const body = {
    business: { name: "Bodega" },
    owner: { name: "Ana", username: "ana", password: "clave-segura-1" },
  }

  test("aplica los valores por defecto del negocio venezolano", () => {
    const parsed = setupSchema.parse(body)
    expect(parsed).toMatchObject({
      referenceCurrency: "USD",
      legalCurrency: "VES",
      timezone: "America/Caracas",
      locationName: "Tienda",
      terminalCode: "C1",
    })
  })

  test("valida usuario, contraseña y código de caja", () => {
    const owner = (o: object) =>
      setupSchema.safeParse({ ...body, owner: { ...body.owner, ...o } }).success
    expect(owner({ password: "corta" })).toBe(false)
    expect(owner({ username: "Ana" })).toBe(false) // mayúsculas
    expect(owner({ username: "a" })).toBe(false)
    expect(owner({ username: "ana.perez_2" })).toBe(true)
    expect(setupSchema.safeParse({ ...body, terminalCode: "caja1" }).success).toBe(false)
    expect(setupSchema.safeParse({ ...body, initialRate: "36,5" }).success).toBe(false)
  })
})

describe("voidDocumentSchema", () => {
  test("exige el id del reverso (UUIDv7) para que reintentar sea idempotente", () => {
    expect(voidDocumentSchema.safeParse({ reason: "error" }).success).toBe(false)
    expect(voidDocumentSchema.safeParse({ reversalId: uuidv7() }).success).toBe(true)
  })
})
