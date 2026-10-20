import { beforeEach, describe, expect, test } from "bun:test"
import type {
  Contact,
  ExpenseCategory,
  Expenses,
  Payables,
  PostedDocumentBody,
  ShiftReport,
} from "@millhiore/contracts"
import { account, accountBalance, paymentMethod } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { checkInvariants } from "../../posting/invariants"
import { cashAccountIds, type Harness, harness, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const RATE = { base: "USD", quote: "VES", value: "36.5" }
const DAY = 86_400_000
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

const methodId = (name: string) => {
  const m = h.db
    .select()
    .from(paymentMethod)
    .all()
    .find((x) => x.name === name)
  if (!m) throw new Error(`no hay método ${name}`)
  return m.id
}
const balanceOf = (name: string) => {
  const a = h.db
    .select()
    .from(account)
    .all()
    .find((x) => x.name === name)
  if (!a) throw new Error(`no hay cuenta ${name}`)
  return h.db.select().from(accountBalance).where(eq(accountBalance.accountId, a.id)).get()
    ?.amountMinor
}

async function supplier(cookie: string, extra: Record<string, unknown> = {}) {
  const res = await h.call("/api/contacts", {
    cookie,
    body: { kind: "supplier", name: "Distribuidora Andina", creditDays: 15, ...extra },
  })
  expect(res.status).toBe(201)
  return (await res.json()) as Contact
}

async function firstCategory(cookie: string) {
  const res = await h.call("/api/expense-categories", { cookie })
  return ((await res.json()) as ExpenseCategory[])[0] as ExpenseCategory
}

/** Un gasto en USD; lo que no se paga ahora queda a deber. */
const debtBody = (
  s: { terminalId: string; methodUsd: string },
  categoryId: string,
  contactId: string | null,
  amountMinor: number,
  over: { creditMinor?: number; paidNow?: number; dueAt?: number } = {},
) => ({
  id: uuidv7(),
  terminalId: s.terminalId,
  currency: "USD",
  rate: RATE,
  amountMinor,
  categoryId,
  contactId,
  note: "Mercancía de la semana",
  creditMinor: over.creditMinor ?? amountMinor,
  ...(over.dueAt ? { dueAt: over.dueAt } : {}),
  payments: over.paidNow
    ? [
        {
          id: uuidv7(),
          paymentMethodId: s.methodUsd,
          currency: "USD",
          amountMinor: over.paidNow,
          rate: null,
        },
      ]
    : [],
})

const pay = (
  s: { terminalId: string },
  contactId: string,
  allocations: { saleDocumentId: string; amountMinor: number }[],
  payments: { method: string; currency: string; amountMinor: number; reference?: string }[],
  over: Record<string, unknown> = {},
) => ({
  id: uuidv7(),
  type: "PAYMENT_OUT",
  terminalId: s.terminalId,
  currency: "USD",
  rate: RATE,
  contactId,
  allocations,
  lines: [],
  payments: payments.map((p) => ({
    id: uuidv7(),
    paymentMethodId: p.method,
    currency: p.currency,
    amountMinor: p.amountMinor,
    rate: p.currency === "USD" ? null : RATE,
    ...(p.reference ? { reference: p.reference } : {}),
  })),
  ...over,
})

const payables = async (cookie: string) =>
  (await (await h.call("/api/payables", { cookie })).json()) as Payables

describe("gastos y compras a deber", () => {
  test("un gasto a deber no mueve dinero, aparece por pagar y toma los días del proveedor", async () => {
    const s = await setUp(h)
    const cat = await firstCategory(s.owner)
    const acme = await supplier(s.owner)
    const res = await h.call("/api/expenses", {
      cookie: s.owner,
      body: debtBody(s, cat.id, acme.id, 1000),
    })
    expect(res.status).toBe(201)
    const posted = (await res.json()) as PostedDocumentBody
    expect(posted).toMatchObject({ totalMinor: 1000, creditMinor: 1000, creditCurrency: "USD" })
    expect(posted.dueAt).toBe(1_760_000_000_000 + 15 * DAY)
    expect(balanceOf("Efectivo USD")).toBeUndefined()

    const owed = await payables(s.owner)
    expect(owed.totals).toEqual([
      {
        currency: "USD",
        outstandingMinor: 1000,
        overdueMinor: 0,
        suppliers: 1,
        aging: { current: 1000, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 },
      },
    ])
    expect(owed.suppliers[0]).toMatchObject({
      contactId: acme.id,
      name: "Distribuidora Andina",
      openCount: 1,
      outstandingMinor: 1000,
    })
    expect(owed.suppliers[0]?.open[0]).toMatchObject({
      id: posted.id,
      kind: "EXPENSE",
      label: "Mercancía de la semana",
      outstandingMinor: 1000,
    })
    // El gasto cuenta completo el día en que se registra, aunque todavía no se haya pagado.
    const list = (await (await h.call("/api/expenses", { cookie: s.owner })).json()) as Expenses
    expect(list.totalLegalMinor).toBe(36_500)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("pagar una parte ahora y dejar el resto a deber, con fecha límite propia", async () => {
    const s = await setUp(h)
    const cat = await firstCategory(s.owner)
    const acme = await supplier(s.owner, { creditDays: 0 })
    const due = 1_760_000_000_000 + 40 * DAY
    const res = await h.call("/api/expenses", {
      cookie: s.owner,
      body: debtBody(s, cat.id, acme.id, 1000, { creditMinor: 600, paidNow: 400, dueAt: due }),
    })
    expect(res.status).toBe(201)
    expect(((await res.json()) as PostedDocumentBody).dueAt).toBe(due)
    expect(balanceOf("Efectivo USD")).toBe(-400)
    expect((await payables(s.owner)).totals[0]?.outstandingMinor).toBe(600)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("una compra también se puede dejar a deber", async () => {
    const s = await setUp(h)
    const acme = await supplier(s.owner)
    const res = await h.call("/api/documents", {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        type: "PURCHASE",
        terminalId: s.terminalId,
        currency: "USD",
        rate: RATE,
        contactId: acme.id,
        externalRef: "F-100",
        lines: [{ variantId: "v1", qtyMilli: 10_000, unitPriceMinor: 100 }],
        payments: [],
        // 10 u × 1,00 $ + 16 % de IVA = 11,60 $
        creditMinor: 1160,
        creditCurrency: "USD",
      },
    })
    expect(res.status).toBe(201)
    const owed = await payables(s.owner)
    expect(owed.suppliers[0]?.open[0]).toMatchObject({
      kind: "PURCHASE",
      label: "Compra",
      externalRef: "F-100",
      outstandingMinor: 1160,
    })
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("sin proveedor, o con un cliente, no se puede dejar a deber", async () => {
    const s = await setUp(h)
    const cat = await firstCategory(s.owner)
    const none = await h.call("/api/expenses", {
      cookie: s.owner,
      body: debtBody(s, cat.id, null, 1000),
    })
    expect(none.status).toBe(409)
    expect(await errorCode(none)).toBe("CREDIT_DENIED")
    const rosa = await h.call("/api/contacts", {
      cookie: s.owner,
      body: { kind: "customer", name: "Doña Rosa" },
    })
    const { id } = (await rosa.json()) as Contact
    const toCustomer = await h.call("/api/expenses", {
      cookie: s.owner,
      body: debtBody(s, cat.id, id, 1000),
    })
    // Un cliente ni siquiera puede ser el destinatario de un gasto.
    expect(toCustomer.status).toBe(422)
    // Ni más a deber que el total, ni un gasto sin pagos y sin deuda.
    const acme = await supplier(s.owner)
    expect(
      (
        await h.call("/api/expenses", {
          cookie: s.owner,
          body: debtBody(s, cat.id, acme.id, 1000, { creditMinor: 1500 }),
        })
      ).status,
    ).toBe(422)
    expect(
      (
        await h.call("/api/expenses", {
          cookie: s.owner,
          body: debtBody(s, cat.id, acme.id, 1000, { creditMinor: 0 }),
        })
      ).status,
    ).toBe(422)
    expect(checkInvariants(h.db)).toEqual([])
  })
})

describe("pagar a un proveedor", () => {
  async function owe(s: Awaited<ReturnType<typeof setUp>>, amount = 1000) {
    const cat = await firstCategory(s.owner)
    const acme = await supplier(s.owner)
    const res = await h.call("/api/expenses", {
      cookie: s.owner,
      body: debtBody(s, cat.id, acme.id, amount),
    })
    const { id } = (await res.json()) as { id: string }
    return { acme, debtId: id }
  }

  test("un pago parcial y luego el resto: sale el dinero y la deuda baja hasta desaparecer", async () => {
    const s = await setUp(h)
    const { acme, debtId } = await owe(s)

    const first = await h.call("/api/documents", {
      cookie: s.owner,
      body: pay(
        s,
        acme.id,
        [{ saleDocumentId: debtId, amountMinor: 400 }],
        [{ method: s.methodUsd, currency: "USD", amountMinor: 400 }],
      ),
    })
    expect(first.status).toBe(201)
    const posted = (await first.json()) as { number: string; totalMinor: number }
    expect(posted).toMatchObject({ number: "C1-PG-000001", totalMinor: 400 })
    expect(balanceOf("Efectivo USD")).toBe(-400)
    expect((await payables(s.owner)).suppliers[0]).toMatchObject({
      outstandingMinor: 600,
      openCount: 1,
    })

    // El resto, pagado en bolívares a la tasa del día (600 × 36,5 = Bs 219,00).
    const rest = await h.call("/api/documents", {
      cookie: s.owner,
      body: pay(
        s,
        acme.id,
        [{ saleDocumentId: debtId, amountMinor: 600 }],
        [
          {
            method: methodId("Pago móvil"),
            currency: "VES",
            amountMinor: 21_900,
            reference: "0099",
          },
        ],
      ),
    })
    expect(rest.status).toBe(201)
    expect(balanceOf("Pago móvil")).toBe(-21_900)
    expect((await payables(s.owner)).suppliers).toEqual([])
    // Los pagos a proveedores salen en el reporte del turno (dos pagos por 10,00 $ = Bs 365,00).
    const report = (await (
      await h.call(`/api/shifts/${s.shiftId}/report`, { cookie: s.owner })
    ).json()) as ShiftReport
    expect(report.supplierPayments).toEqual({ count: 2, totalLegalMinor: 36_500 })
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("no se paga más de lo que se debe, ni en otra moneda, ni a otro proveedor", async () => {
    const s = await setUp(h)
    const { acme, debtId } = await owe(s)
    const other = (await (
      await h.call("/api/contacts", {
        cookie: s.owner,
        body: { kind: "supplier", name: "Otro Proveedor" },
      })
    ).json()) as Contact
    const send = (body: unknown) => h.call("/api/documents", { cookie: s.owner, body })
    const usd = { method: s.methodUsd, currency: "USD", amountMinor: 1100 }

    const over = await send(pay(s, acme.id, [{ saleDocumentId: debtId, amountMinor: 1100 }], [usd]))
    expect(over.status).toBe(422)
    expect(await errorCode(over)).toBe("INVALID_ALLOCATION")

    const wrongSupplier = await send(
      pay(
        s,
        other.id,
        [{ saleDocumentId: debtId, amountMinor: 100 }],
        [{ ...usd, amountMinor: 100 }],
      ),
    )
    expect(wrongSupplier.status).toBe(422)

    const vesDoc = await send(
      pay(
        s,
        acme.id,
        [{ saleDocumentId: debtId, amountMinor: 100 }],
        [{ ...usd, amountMinor: 100 }],
        {
          currency: "VES",
        },
      ),
    )
    expect(vesDoc.status).toBe(422)
    expect(await errorCode(vesDoc)).toBe("CURRENCY_MISMATCH")

    // Pagos que no cubren lo que se aplica
    const short = await send(
      pay(
        s,
        acme.id,
        [{ saleDocumentId: debtId, amountMinor: 500 }],
        [{ ...usd, amountMinor: 300 }],
      ),
    )
    expect(short.status).toBe(422)
    expect(await errorCode(short)).toBe("UNSETTLED")
    expect(balanceOf("Efectivo USD")).toBeUndefined()
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("pide el permiso y, en efectivo, el turno abierto", async () => {
    const s = await setUp(h)
    const { acme, debtId } = await owe(s)
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    const body = () =>
      pay(
        s,
        acme.id,
        [{ saleDocumentId: debtId, amountMinor: 100 }],
        [{ method: s.methodUsd, currency: "USD", amountMinor: 100 }],
      )
    expect((await h.call("/api/documents", { cookie: cashier, body: body() })).status).toBe(403)
    expect((await h.call("/api/payables", { cookie: cashier })).status).toBe(403)

    const shift = (await (
      await h.call(`/api/shifts/current?terminalId=${s.terminalId}`, { cookie: s.owner })
    ).json()) as { id: string }
    await h.call(`/api/shifts/${shift.id}/close`, {
      cookie: s.owner,
      body: {
        counts: Object.values(cashAccountIds(h)).map((accountId) => ({
          accountId,
          countedMinor: 0,
        })),
      },
    })
    const cash = await h.call("/api/documents", { cookie: s.owner, body: body() })
    expect(cash.status).toBe(409)
    expect(await errorCode(cash)).toBe("SHIFT_CLOSED")
    // Por Zelle no hace falta turno.
    const zelle = await h.call("/api/documents", {
      cookie: s.owner,
      body: pay(
        s,
        acme.id,
        [{ saleDocumentId: debtId, amountMinor: 100 }],
        [{ method: methodId("Zelle"), currency: "USD", amountMinor: 100, reference: "ZL-1" }],
      ),
    })
    expect(zelle.status).toBe(201)
  })

  test("anular: un gasto con pagos no se anula; anular el pago vuelve a dejar la deuda", async () => {
    const s = await setUp(h)
    const { acme, debtId } = await owe(s)
    const paid = await h.call("/api/documents", {
      cookie: s.owner,
      body: pay(
        s,
        acme.id,
        [{ saleDocumentId: debtId, amountMinor: 1000 }],
        [{ method: s.methodUsd, currency: "USD", amountMinor: 1000 }],
      ),
    })
    const { id: paymentId } = (await paid.json()) as { id: string }
    expect((await payables(s.owner)).suppliers).toEqual([])

    const blocked = await h.call(`/api/documents/${debtId}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7() },
    })
    expect(blocked.status).toBe(409)
    expect(await errorCode(blocked)).toBe("HAS_PAYMENTS")

    const undo = await h.call(`/api/documents/${paymentId}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7(), reason: "Me equivoqué de proveedor" },
    })
    expect(undo.status).toBe(201)
    expect(balanceOf("Efectivo USD")).toBe(0)
    expect((await payables(s.owner)).suppliers[0]?.outstandingMinor).toBe(1000)
    expect(checkInvariants(h.db)).toEqual([])

    // Ahora sí: se anula el gasto y ya no se debe nada.
    const voided = await h.call(`/api/documents/${debtId}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7() },
    })
    expect(voided.status).toBe(201)
    expect((await payables(s.owner)).suppliers).toEqual([])
    expect(checkInvariants(h.db)).toEqual([])
  })
})

describe("antigüedad de saldos", () => {
  test("cada factura cae en su tramo según los días que lleva vencida", async () => {
    const s = await setUp(h)
    const cat = await firstCategory(s.owner)
    const acme = await supplier(s.owner, { creditDays: 0 })
    const base = h.clock.now
    // Vencimientos: dentro de 10 días, hace 5, hace 45, hace 75 y hace 120 días.
    const dues = [10, -5, -45, -75, -120].map((d) => base + d * DAY)
    for (const dueAt of dues) {
      const res = await h.call("/api/expenses", {
        cookie: s.owner,
        body: debtBody(s, cat.id, acme.id, 100, { dueAt }),
      })
      expect(res.status).toBe(201)
    }
    const owed = await payables(s.owner)
    expect(owed.totals[0]).toMatchObject({
      outstandingMinor: 500,
      overdueMinor: 400,
      aging: { current: 100, d1_30: 100, d31_60: 100, d61_90: 100, d90plus: 100 },
    })
    expect(owed.suppliers[0]?.aging).toEqual(owed.totals[0]?.aging)
    // El tiempo pasa: la que estaba por vencer entra al primer tramo.
    h.clock.now += 11 * DAY
    expect((await payables(s.owner)).totals[0]?.aging).toMatchObject({ current: 0, d1_30: 200 })
  })
})
