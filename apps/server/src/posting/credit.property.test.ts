import { describe, expect, test } from "bun:test"
import { accountBalance, contact } from "@millhiore/db"
import { PostingError, uuidv7 } from "@millhiore/domain"
import fc from "fast-check"
import { createTestDb, ctx, ids, RATE } from "./fixtures"
import { checkInvariants } from "./invariants"
import { postDocument, voidDocument } from "./post"
import { openSales } from "./receivables"

// Secuencias al azar de fiar, abonar y anular, contra un modelo propio muy simple: por cada venta
// fiada, cuánto se fió y cuánto se ha abonado (neto). Después de cada paso, lo que el motor dice
// que se debe tiene que coincidir con el modelo y los invariantes tienen que cumplirse.

type Op =
  | { kind: "fiar"; total: number; credit: number }
  | { kind: "abonar"; picks: { sale: number; percent: number }[] }
  | { kind: "anularAbono"; pick: number }
  | { kind: "anularVenta"; pick: number }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    arbitrary: fc.integer({ min: 1, max: 3000 }).chain((total) =>
      fc.record({
        kind: fc.constant("fiar" as const),
        total: fc.constant(total),
        credit: fc.integer({ min: 1, max: total }),
      }),
    ),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("abonar" as const),
      picks: fc.array(fc.record({ sale: fc.nat(20), percent: fc.integer({ min: 1, max: 100 }) }), {
        minLength: 1,
        maxLength: 4,
      }),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({ kind: fc.constant("anularAbono" as const), pick: fc.nat(20) }),
    weight: 1,
  },
  {
    arbitrary: fc.record({ kind: fc.constant("anularVenta" as const), pick: fc.nat(20) }),
    weight: 1,
  },
)

interface ModelSale {
  id: string
  total: number
  credit: number
  collected: number
  voided: boolean
}
interface ModelCollection {
  id: string
  allocations: { sale: ModelSale; amount: number }[]
  voided: boolean
}

function run(ops: readonly Op[]) {
  const db = createTestDb()
  db.insert(contact).values({ id: "ana", kind: "customer", name: "Ana", createdAt: 1 }).run()
  const sales: ModelSale[] = []
  const collections: ModelCollection[] = []

  for (const op of ops) {
    if (op.kind === "fiar") {
      const id = uuidv7()
      const paid = op.total - op.credit
      postDocument(
        db,
        {
          id,
          type: "SALE",
          terminalId: ids.terminal,
          currency: "USD",
          rate: RATE,
          contactId: "ana",
          lines: [{ variantId: ids.bread, qtyMilli: 1000, unitPriceMinor: op.total }],
          payments:
            paid > 0
              ? [
                  {
                    id: uuidv7(),
                    paymentMethodId: ids.methodUsd,
                    currency: "USD",
                    amountMinor: paid,
                    rate: null,
                  },
                ]
              : [],
          creditMinor: op.credit,
        },
        ctx(),
      )
      sales.push({ id, total: op.total, credit: op.credit, collected: 0, voided: false })
    } else if (op.kind === "abonar") {
      const open = sales.filter((s) => !s.voided && s.credit - s.collected > 0)
      const chosen = new Map<ModelSale, number>()
      for (const pick of op.picks) {
        const sale = open[pick.sale % Math.max(open.length, 1)]
        if (!sale || chosen.has(sale)) continue
        const owed = sale.credit - sale.collected
        chosen.set(sale, Math.max(1, Math.floor((owed * pick.percent) / 100)))
      }
      if (chosen.size === 0) continue
      const allocations = [...chosen].map(([sale, amount]) => ({ sale, amount }))
      const id = uuidv7()
      const total = allocations.reduce((acc, a) => acc + a.amount, 0)
      postDocument(
        db,
        {
          id,
          type: "PAYMENT_IN",
          terminalId: ids.terminal,
          currency: "USD",
          rate: RATE,
          contactId: "ana",
          lines: [],
          allocations: allocations.map((a) => ({
            saleDocumentId: a.sale.id,
            amountMinor: a.amount,
          })),
          payments: [
            {
              id: uuidv7(),
              paymentMethodId: ids.methodUsd,
              currency: "USD",
              amountMinor: total,
              rate: null,
            },
          ],
        },
        ctx(),
      )
      for (const a of allocations) a.sale.collected += a.amount
      collections.push({ id, allocations, voided: false })
    } else if (op.kind === "anularAbono") {
      const live = collections.filter((c) => !c.voided)
      const target = live[op.pick % Math.max(live.length, 1)]
      if (!target) continue
      voidDocument(db, target.id, uuidv7(), ctx())
      for (const a of target.allocations) a.sale.collected -= a.amount
      target.voided = true
    } else {
      const live = sales.filter((s) => !s.voided)
      const target = live[op.pick % Math.max(live.length, 1)]
      if (!target) continue
      if (target.collected !== 0) {
        // Con abonos aplicados el motor se niega y no cambia nada.
        try {
          voidDocument(db, target.id, uuidv7(), ctx())
          throw new Error("debió negarse a anular una venta con abonos")
        } catch (e) {
          if (!(e instanceof PostingError && e.code === "HAS_COLLECTIONS")) throw e
        }
      } else {
        voidDocument(db, target.id, uuidv7(), ctx())
        target.voided = true
      }
    }

    const owedByEngine = openSales(db, { contactId: "ana" })
    const expectedOwed = sales
      .filter((s) => !s.voided)
      .reduce((acc, s) => acc + (s.credit - s.collected), 0)
    expect(owedByEngine.reduce((acc, s) => acc + s.outstandingMinor, 0)).toBe(expectedOwed)

    // El efectivo en dólares: lo cobrado al vender más los abonos vigentes.
    const expectedCash =
      sales.filter((s) => !s.voided).reduce((acc, s) => acc + (s.total - s.credit), 0) +
      collections
        .filter((c) => !c.voided)
        .reduce((acc, c) => acc + c.allocations.reduce((n, a) => n + a.amount, 0), 0)
    const cash = db
      .select()
      .from(accountBalance)
      .all()
      .find((b) => b.accountId === ids.cashUsd)?.amountMinor
    expect(cash ?? 0).toBe(expectedCash)
    expect(checkInvariants(db)).toEqual([])
  }
}

describe("fiado: propiedades", () => {
  test("lo que se debe y el efectivo siempre cuadran con el modelo, y los invariantes se cumplen", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        run(ops)
      }),
      { numRuns: 60 },
    )
  })
})
