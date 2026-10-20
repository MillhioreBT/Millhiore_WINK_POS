import { describe, expect, test } from "bun:test"
import { accountBalance, stockBalance } from "@millhiore/db"
import { PostingError, uuidv7 } from "@millhiore/domain"
import fc from "fast-check"
import { createTestDb, ctx, ids, RATE } from "./fixtures"
import { checkInvariants } from "./invariants"
import { type PostDocumentInput, type PostPaymentInput, postDocument, voidDocument } from "./post"

// Modelo independiente del motor: aritmética entera propia, sin big.js ni el planificador.

type Op =
  | {
      kind: "sale"
      variant: 0 | 1
      qty: number
      price: number
      included: boolean
      pay: "usd" | "ves" | "mixed" | "zelle" | "split"
      extra: number
    }
  | { kind: "purchase"; variant: 0 | 1; qty: number; price: number; included: boolean }
  | { kind: "adjust"; variant: 0 | 1; qty: number }
  | { kind: "cash"; direction: "in" | "out"; amount: number }
  | { kind: "expense"; amount: number; pay: "usd" | "ves" | "zelle" | "split" }
  | { kind: "void"; pick: number }

const variantIds = [ids.bread, ids.water] as const
/** IVA de cada variante en centésimas de punto: pan exento, agua 16 %. */
const variantRates = [0, 1600] as const

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("sale" as const),
      variant: fc.constantFrom(0 as const, 1 as const),
      qty: fc.integer({ min: 1000, max: 9999 }),
      price: fc.integer({ min: 1, max: 3000 }),
      included: fc.boolean(),
      pay: fc.constantFrom(
        "usd" as const,
        "ves" as const,
        "mixed" as const,
        "zelle" as const,
        "split" as const,
      ),
      extra: fc.integer({ min: 1, max: 500 }),
    }),
    weight: 5,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("purchase" as const),
      variant: fc.constantFrom(0 as const, 1 as const),
      qty: fc.integer({ min: 1000, max: 9999 }),
      price: fc.integer({ min: 1, max: 3000 }),
      included: fc.boolean(),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("adjust" as const),
      variant: fc.constantFrom(0 as const, 1 as const),
      qty: fc.oneof(fc.integer({ min: -5000, max: -1 }), fc.integer({ min: 1, max: 5000 })),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("cash" as const),
      direction: fc.constantFrom("in" as const, "out" as const),
      amount: fc.integer({ min: 1, max: 50_000 }),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("expense" as const),
      amount: fc.integer({ min: 1, max: 50_000 }),
      pay: fc.constantFrom("usd" as const, "ves" as const, "zelle" as const, "split" as const),
    }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant("void" as const), pick: fc.nat(40) }), weight: 2 },
)

// Todo con montos positivos: x × p / 10 000 con mitad hacia arriba.
const lineTotal = (qty: number, price: number) => Math.floor((qty * price + 500) / 1000)
const toBs = (usdCents: number) => Math.floor((usdCents * 365 + 5) / 10) // × 36,5 con half-up
const pct = (amount: number, bp: number) => Math.floor((amount * bp + 5000) / 10_000)
const igtf = (base: number) => pct(base, 300)

interface Posted {
  id: string
  isReversal: boolean
  voided: boolean
  stock: [string, number][]
  money: [string, number][]
}

function buildInput(op: Exclude<Op, { kind: "void" }>): {
  input: PostDocumentInput
  posted: Omit<Posted, "id" | "isReversal" | "voided">
  expected: { totalMinor: number; surchargeMinor: number }
} {
  const base = { id: uuidv7(), terminalId: ids.terminal, currency: "USD", rate: RATE }

  if (op.kind === "cash") {
    // Ingreso o retiro de caja en USD: solo mueve la cuenta, sin líneas ni impuestos.
    const sign = op.direction === "in" ? 1 : -1
    return {
      input: {
        ...base,
        type: op.direction === "in" ? "CASH_IN" : "CASH_OUT",
        lines: [],
        payments: [
          {
            id: uuidv7(),
            paymentMethodId: ids.methodUsd,
            currency: "USD",
            amountMinor: op.amount,
            rate: null,
          },
        ],
      },
      posted: { stock: [], money: [[ids.cashUsd, sign * op.amount]] },
      expected: { totalMinor: op.amount, surchargeMinor: 0 },
    }
  }

  if (op.kind === "expense") {
    // Gasto en USD, sin IVA ni líneas. Pagado en dólares, en bolívares (a 36,5, dentro de la
    // tolerancia de redondeo) o repartido: la mitad en bolívares y el resto por Zelle (sin IGTF).
    const inBs = op.pay === "ves" ? op.amount : op.pay === "split" ? Math.floor(op.amount / 2) : 0
    const rest = op.amount - inBs
    const payments: PostPaymentInput[] = []
    const money: [string, number][] = []
    if (inBs > 0) {
      payments.push({
        id: uuidv7(),
        paymentMethodId: ids.methodVes,
        currency: "VES",
        amountMinor: toBs(inBs),
        rate: RATE,
      })
      money.push([ids.cashVes, -toBs(inBs)])
    }
    if (rest > 0) {
      const viaZelle = op.pay === "zelle" || op.pay === "split"
      payments.push({
        id: uuidv7(),
        paymentMethodId: viaZelle ? ids.methodZelle : ids.methodUsd,
        currency: "USD",
        amountMinor: rest,
        rate: null,
        ...(viaZelle ? { reference: "ZL-1" } : {}),
      })
      money.push([viaZelle ? ids.zelle : ids.cashUsd, -rest])
    }
    return {
      input: {
        ...base,
        type: "EXPENSE",
        lines: [],
        payments,
        amountMinor: op.amount,
        expenseCategoryId: "exp-otros",
      },
      posted: { stock: [], money },
      expected: { totalMinor: op.amount, surchargeMinor: 0 },
    }
  }

  const variantId = variantIds[op.variant]
  if (op.kind === "adjust") {
    return {
      input: {
        ...base,
        type: "ADJUSTMENT",
        lines: [{ variantId, qtyMilli: op.qty, unitPriceMinor: 0 }],
        payments: [],
      },
      posted: { stock: [[variantId, op.qty]], money: [] },
      expected: { totalMinor: 0, surchargeMinor: 0 },
    }
  }

  // Con IVA incluido el total es el de la línea; sin él, se le suma el IVA de la línea.
  const lineAmount = lineTotal(op.qty, op.price)
  const total = op.included ? lineAmount : lineAmount + pct(lineAmount, variantRates[op.variant])
  const sign = op.kind === "sale" ? 1 : -1 // dinero: la venta entra, la compra sale
  const pay = op.kind === "sale" ? op.pay : "usd"
  const extra = op.kind === "sale" ? op.extra : 0
  const payments: PostPaymentInput[] = []
  const money: [string, number][] = []
  let surcharge = 0

  if (pay === "zelle" || pay === "split") {
    // split: la mitad en Bs (sin IGTF), el resto por Zelle con IGTF sobre ese resto.
    const inBs = pay === "split" ? Math.floor(total / 2) : 0
    if (inBs > 0) {
      payments.push({
        id: uuidv7(),
        paymentMethodId: ids.methodVes,
        currency: "VES",
        amountMinor: toBs(inBs),
        rate: RATE,
      })
      money.push([ids.cashVes, sign * toBs(inBs)])
    }
    surcharge = igtf(total - inBs)
    const viaZelle = total - inBs + surcharge
    payments.push({
      id: uuidv7(),
      paymentMethodId: ids.methodZelle,
      currency: "USD",
      amountMinor: viaZelle,
      rate: null,
    })
    money.push([ids.zelle, sign * viaZelle])
  } else if (pay === "usd" || pay === "mixed") {
    const amount = pay === "mixed" ? total + extra : total
    payments.push({
      id: uuidv7(),
      paymentMethodId: ids.methodUsd,
      currency: "USD",
      amountMinor: amount,
      rate: null,
    })
    money.push([ids.cashUsd, sign * amount])
    if (pay === "mixed") {
      const change = -toBs(extra)
      payments.push({
        id: uuidv7(),
        paymentMethodId: ids.methodVes,
        currency: "VES",
        amountMinor: change,
        rate: RATE,
      })
      money.push([ids.cashVes, sign * change])
    }
  } else {
    const bs = toBs(total)
    payments.push({
      id: uuidv7(),
      paymentMethodId: ids.methodVes,
      currency: "VES",
      amountMinor: bs,
      rate: RATE,
    })
    money.push([ids.cashVes, sign * bs])
  }

  return {
    input: {
      ...base,
      type: op.kind === "sale" ? "SALE" : "PURCHASE",
      pricesIncludeTax: op.included,
      lines: [{ variantId, qtyMilli: op.qty, unitPriceMinor: op.price }],
      payments,
    },
    posted: {
      stock: [[variantId, (op.kind === "sale" ? -1 : 1) * op.qty]],
      money,
    },
    expected: { totalMinor: total, surchargeMinor: surcharge },
  }
}

function run(ops: readonly Op[], allowNegativeStock: boolean) {
  const db = createTestDb()
  const posted: Posted[] = []
  let failures = 0

  for (const op of ops) {
    try {
      if (op.kind === "void") {
        const target = posted[op.pick % Math.max(posted.length, 1)]
        if (!target) continue
        const reversalId = uuidv7()
        try {
          voidDocument(db, target.id, reversalId, ctx({ allowNegativeStock }))
        } catch (e) {
          if (
            e instanceof PostingError &&
            e.code === (target.isReversal ? "NOT_REVERSIBLE" : "ALREADY_REVERSED") &&
            (target.isReversal || target.voided)
          ) {
            continue
          }
          throw e
        }
        expect(target.isReversal || target.voided).toBe(false)
        target.voided = true
        posted.push({
          id: reversalId,
          isReversal: true,
          voided: false,
          stock: target.stock.map(([k, v]) => [k, -v]),
          money: target.money.map(([k, v]) => [k, -v]),
        })
      } else {
        const { input, posted: effects, expected } = buildInput(op)
        const result = postDocument(db, input, ctx({ allowNegativeStock }))
        expect({ totalMinor: result.totalMinor, surchargeMinor: result.surchargeMinor }).toEqual(
          expected,
        )
        posted.push({ id: input.id, isReversal: false, voided: false, ...effects })
      }
    } catch (e) {
      // Único fallo legítimo: stock insuficiente, y solo si la regla está activa.
      if (e instanceof PostingError && e.code === "INSUFFICIENT_STOCK" && !allowNegativeStock) {
        failures++
        continue
      }
      throw e
    }
  }
  return { db, posted, failures }
}

const sumBy = (entries: [string, number][]) => {
  const map = new Map<string, number>()
  for (const [k, v] of entries) map.set(k, (map.get(k) ?? 0) + v)
  return map
}

describe("propiedades del motor de contabilización", () => {
  test("cualquier secuencia de operaciones mantiene los libros y las proyecciones coherentes", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 25 }), fc.boolean(), (ops, allowNegativeStock) => {
        const { db, posted } = run(ops, allowNegativeStock)

        // 1. Los invariantes del plan se cumplen.
        expect(checkInvariants(db)).toEqual([])

        // 2. Las proyecciones coinciden con un modelo independiente.
        const expectedStock = sumBy(posted.flatMap((p) => p.stock))
        for (const b of db.select().from(stockBalance).all()) {
          expect(b.qtyMilli).toBe(expectedStock.get(b.variantId) ?? 0)
          expectedStock.delete(b.variantId)
        }
        for (const [variantId, qty] of expectedStock)
          expect([variantId, qty]).toEqual([variantId, 0])

        const expectedMoney = sumBy(posted.flatMap((p) => p.money))
        for (const b of db.select().from(accountBalance).all()) {
          expect(b.amountMinor).toBe(expectedMoney.get(b.accountId) ?? 0)
          expectedMoney.delete(b.accountId)
        }
        for (const [accountId, amount] of expectedMoney)
          expect([accountId, amount]).toEqual([accountId, 0])
      }),
      { numRuns: 150 },
    )
  }, 30_000)

  test("con stock negativo prohibido, ninguna proyección queda por debajo de cero", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
        const { db } = run(ops, false)
        for (const b of db.select().from(stockBalance).all()) {
          // Los ajustes negativos también pasan por la regla, así que el saldo nunca es negativo.
          expect(b.qtyMilli).toBeGreaterThanOrEqual(0)
        }
        expect(checkInvariants(db)).toEqual([])
      }),
      { numRuns: 100 },
    )
  }, 30_000)
})
