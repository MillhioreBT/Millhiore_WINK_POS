import { beforeEach, describe, expect, test } from "bun:test"
import type {
  DaySummary,
  DocumentDetail,
  ExpenseCategory,
  Expenses,
  ShiftReport,
} from "@millhiore/contracts"
import { account, accountBalance, auditLog, paymentMethod } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { checkInvariants } from "../../posting/invariants"
import { cashAccountIds, type Harness, harness, openShiftFor, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const RATE = { base: "USD", quote: "VES", value: "36.5" }
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

async function categories(cookie: string, all = false) {
  const res = await h.call(`/api/expense-categories${all ? "?all=true" : ""}`, { cookie })
  expect(res.status).toBe(200)
  return (await res.json()) as ExpenseCategory[]
}

const expenseBody = (
  terminalId: string,
  categoryId: string,
  pay: { method: string; currency: string; amountMinor: number; reference?: string },
  over: Record<string, unknown> = {},
) => ({
  id: uuidv7(),
  terminalId,
  currency: pay.currency,
  rate: RATE,
  amountMinor: pay.amountMinor,
  categoryId,
  note: "Recibo de la luz",
  payments: [
    {
      id: uuidv7(),
      paymentMethodId: pay.method,
      currency: pay.currency,
      amountMinor: pay.amountMinor,
      rate: null,
      ...(pay.reference ? { reference: pay.reference } : {}),
    },
  ],
  ...over,
})

describe("categorías de gasto", () => {
  test("vienen las de fábrica y cada comercio agrega, renombra y desactiva las suyas", async () => {
    const { owner } = await setUp(h)
    const initial = await categories(owner)
    expect(initial.map((c) => c.name)).toEqual([
      "Alquiler",
      "Servicios (luz, agua, internet, teléfono)",
      "Sueldos y comisiones",
      "Transporte y fletes",
      "Mantenimiento y reparaciones",
      "Impuestos y tasas",
      "Publicidad",
      "Papelería y limpieza",
      "Otros gastos",
    ])

    const created = await h.call("/api/expense-categories", {
      cookie: owner,
      body: { name: "Comisión del punto" },
    })
    expect(created.status).toBe(201)
    const cat = (await created.json()) as ExpenseCategory
    expect(cat).toMatchObject({ name: "Comisión del punto", position: 10, expenseCount: 0 })
    const dup = await h.call("/api/expense-categories", {
      cookie: owner,
      body: { name: "Comisión del punto" },
    })
    expect(dup.status).toBe(409)

    const renamed = await h.call(`/api/expense-categories/${cat.id}`, {
      cookie: owner,
      method: "PATCH",
      body: { name: "Comisiones bancarias" },
    })
    expect(((await renamed.json()) as ExpenseCategory).name).toBe("Comisiones bancarias")

    await h.call(`/api/expense-categories/${cat.id}`, {
      cookie: owner,
      method: "PATCH",
      body: { active: false },
    })
    expect((await categories(owner)).some((c) => c.id === cat.id)).toBe(false)
    expect((await categories(owner, true)).some((c) => c.id === cat.id)).toBe(true)
    expect(
      (
        await h.call("/api/expense-categories/no-existe", {
          cookie: owner,
          method: "PATCH",
          body: { active: true },
        })
      ).status,
    ).toBe(404)
  })

  test("el cajero ni las ve ni las cambia; el administrador sí", async () => {
    const { owner } = await setUp(h)
    for (const [username, roleId] of [
      ["pedro", "cashier"],
      ["ana", "manager"],
    ] as const) {
      await h.call("/api/users", {
        cookie: owner,
        body: { name: username, username, password: "otra-clave-1", roleId },
      })
    }
    const cashier = await h.login("pedro", "otra-clave-1")
    const manager = await h.login("ana", "otra-clave-1")
    expect((await h.call("/api/expense-categories", { cookie: cashier })).status).toBe(403)
    expect(
      (await h.call("/api/expense-categories", { cookie: cashier, body: { name: "X" } })).status,
    ).toBe(403)
    expect((await h.call("/api/expense-categories", { cookie: manager })).status).toBe(200)
    expect(
      (await h.call("/api/expense-categories", { cookie: manager, body: { name: "Seguridad" } }))
        .status,
    ).toBe(201)
  })
})

describe("registrar un gasto", () => {
  test("pagado en efectivo baja la caja, se ve en el listado y deja todo cuadrado", async () => {
    const s = await setUp(h)
    const [rent, services] = await categories(s.owner)
    if (!(rent && services)) throw new Error("faltan categorías")
    await h.call("/api/documents", {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        type: "CASH_IN",
        terminalId: s.terminalId,
        currency: "USD",
        rate: RATE,
        payments: [
          { id: uuidv7(), paymentMethodId: s.methodUsd, currency: "USD", amountMinor: 5000 },
        ],
      },
    })
    expect(balanceOf("Efectivo USD")).toBe(5000)

    const res = await h.call("/api/expenses", {
      cookie: s.owner,
      body: expenseBody(s.terminalId, services.id, {
        method: s.methodUsd,
        currency: "USD",
        amountMinor: 1250,
      }),
    })
    expect(res.status).toBe(201)
    const posted = (await res.json()) as { id: string; number: string; totalMinor: number }
    expect(posted).toMatchObject({ number: "C1-GA-000001", totalMinor: 1250 })
    expect(balanceOf("Efectivo USD")).toBe(3750)

    const detail = (await (
      await h.call(`/api/documents/${posted.id}`, { cookie: s.owner })
    ).json()) as DocumentDetail
    expect(detail).toMatchObject({
      type: "EXPENSE",
      totalMinor: 1250,
      totalLegalMinor: 45_625, // 12,50 $ a 36,5
      expenseCategoryId: services.id,
      expenseCategoryName: services.name,
      note: "Recibo de la luz",
      lines: [],
      taxes: [],
    })
    expect(detail.payments).toHaveLength(1)

    await h.call("/api/expenses", {
      cookie: s.owner,
      body: expenseBody(s.terminalId, rent.id, {
        method: s.methodUsd,
        currency: "USD",
        amountMinor: 20_000 / 100,
      }),
    })
    const list = (await (await h.call("/api/expenses", { cookie: s.owner })).json()) as Expenses
    expect(list.rows).toHaveLength(2)
    expect(list.totalLegalMinor).toBe(45_625 + 7300)
    expect(list.byCategory).toEqual([
      { categoryId: services.id, name: services.name, count: 1, totalLegalMinor: 45_625 },
      { categoryId: rent.id, name: rent.name, count: 1, totalLegalMinor: 7300 },
    ])
    // Por categoría.
    const only = (await (
      await h.call(`/api/expenses?categoryId=${rent.id}`, { cookie: s.owner })
    ).json()) as Expenses
    expect(only.rows).toHaveLength(1)
    expect(only.totalLegalMinor).toBe(7300)
    expect((await categories(s.owner)).find((c) => c.id === rent.id)?.expenseCount).toBe(1)

    expect(checkInvariants(h.db)).toEqual([])
    const audit = h.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.action === "document.posted" && a.entityType === "document")
    expect(audit.some((a) => (a.data as { type: string }).type === "EXPENSE")).toBe(true)
  })

  test("un gasto en dólares pagado en bolívares usa la tasa y respeta la tolerancia", async () => {
    const s = await setUp(h)
    const [, services] = await categories(s.owner)
    if (!services) throw new Error("falta la categoría")
    const mobile = methodId("Pago móvil")
    const body = (vesAmount: number) =>
      expenseBody(
        s.terminalId,
        services.id,
        { method: mobile, currency: "VES", amountMinor: vesAmount, reference: "0012345678" },
        {
          currency: "USD",
          amountMinor: 1000, // 10 $
          payments: [
            {
              id: uuidv7(),
              paymentMethodId: mobile,
              currency: "VES",
              amountMinor: vesAmount,
              rate: RATE,
              reference: "0012345678",
            },
          ],
        },
      )
    // 10 $ × 36,5 = Bs 365,00
    const short = await h.call("/api/expenses", { cookie: s.owner, body: body(36_000) })
    expect(short.status).toBe(422)
    expect(await errorCode(short)).toBe("UNSETTLED")
    const exact = await h.call("/api/expenses", { cookie: s.owner, body: body(36_500) })
    expect(exact.status).toBe(201)
    expect(balanceOf("Pago móvil")).toBe(-36_500)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("pagado por pago móvil no exige turno; en efectivo sí", async () => {
    const s = await setUp(h)
    const [, services] = await categories(s.owner)
    if (!services) throw new Error("falta la categoría")
    const shift = (await (
      await h.call(`/api/shifts/current?terminalId=${s.terminalId}`, { cookie: s.owner })
    ).json()) as {
      id: string
    }
    const close = await h.call(`/api/shifts/${shift.id}/close`, {
      cookie: s.owner,
      body: {
        counts: Object.values(cashAccountIds(h)).map((accountId) => ({
          accountId,
          countedMinor: 0,
        })),
      },
    })
    expect(close.status).toBe(200)

    const cash = await h.call("/api/expenses", {
      cookie: s.owner,
      body: expenseBody(s.terminalId, services.id, {
        method: s.methodUsd,
        currency: "USD",
        amountMinor: 500,
      }),
    })
    expect(cash.status).toBe(409)
    expect(await errorCode(cash)).toBe("SHIFT_CLOSED")

    const bank = await h.call("/api/expenses", {
      cookie: s.owner,
      body: expenseBody(s.terminalId, services.id, {
        method: methodId("Zelle"),
        currency: "USD",
        amountMinor: 500,
        reference: "ZL-1",
      }),
    })
    expect(bank.status).toBe(201)
    // Y se puede volver a abrir y pagar en efectivo.
    await openShiftFor(h, s.owner, s.terminalId, {})
    expect(
      (
        await h.call("/api/expenses", {
          cookie: s.owner,
          body: expenseBody(s.terminalId, services.id, {
            method: s.methodUsd,
            currency: "USD",
            amountMinor: 500,
          }),
        })
      ).status,
    ).toBe(201)
  })

  test("rechaza lo que no tiene sentido y exige el permiso", async () => {
    const s = await setUp(h)
    const [, services] = await categories(s.owner)
    if (!services) throw new Error("falta la categoría")
    const pay = { method: s.methodUsd, currency: "USD", amountMinor: 500 }
    const post = (body: unknown, cookie = s.owner) => h.call("/api/expenses", { cookie, body })

    // Categoría desconocida o desactivada
    expect((await post(expenseBody(s.terminalId, "nada", pay))).status).toBe(422)
    const off = await h.call("/api/expense-categories", {
      cookie: s.owner,
      body: { name: "Vieja" },
    })
    const old = (await off.json()) as ExpenseCategory
    await h.call(`/api/expense-categories/${old.id}`, {
      cookie: s.owner,
      method: "PATCH",
      body: { active: false },
    })
    expect((await post(expenseBody(s.terminalId, old.id, pay))).status).toBe(422)

    // Monto cero, sin pagos, o un cliente como destinatario
    expect(
      (await post(expenseBody(s.terminalId, services.id, pay, { amountMinor: 0 }))).status,
    ).toBe(422)
    expect((await post(expenseBody(s.terminalId, services.id, pay, { payments: [] }))).status).toBe(
      422,
    )
    const customer = await h.call("/api/contacts", {
      cookie: s.owner,
      body: { kind: "customer", name: "Doña Rosa" },
    })
    const { id: customerId } = (await customer.json()) as { id: string }
    const toCustomer = await post(
      expenseBody(s.terminalId, services.id, pay, { contactId: customerId }),
    )
    expect(toCustomer.status).toBe(422)
    // Pagar de más no cuadra
    expect(
      (await post(expenseBody(s.terminalId, services.id, pay, { amountMinor: 300 }))).status,
    ).toBe(422)

    // Un proveedor sí
    const supplier = await h.call("/api/contacts", {
      cookie: s.owner,
      body: { kind: "supplier", name: "Corpoelec", taxId: "G-20000001-0" },
    })
    const { id: supplierId } = (await supplier.json()) as { id: string }
    const ok = await post(
      expenseBody(s.terminalId, services.id, pay, { contactId: supplierId, externalRef: "F-77" }),
    )
    expect(ok.status).toBe(201)
    const { id } = (await ok.json()) as { id: string }
    const detail = (await (
      await h.call(`/api/documents/${id}`, { cookie: s.owner })
    ).json()) as DocumentDetail
    expect(detail).toMatchObject({ contactName: "Corpoelec", externalRef: "F-77" })

    // El POST general no arma gastos
    const general = await h.call("/api/documents", {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        type: "EXPENSE",
        terminalId: s.terminalId,
        currency: "USD",
        payments: [],
      },
    })
    expect(general.status).toBe(422)

    // El cajero no registra gastos
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await post(expenseBody(s.terminalId, services.id, pay), cashier)).status).toBe(403)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("reenviar el mismo gasto no lo registra dos veces", async () => {
    const s = await setUp(h)
    const [, services] = await categories(s.owner)
    if (!services) throw new Error("falta la categoría")
    const body = expenseBody(s.terminalId, services.id, {
      method: s.methodUsd,
      currency: "USD",
      amountMinor: 500,
    })
    expect((await h.call("/api/expenses", { cookie: s.owner, body })).status).toBe(201)
    const again = await h.call("/api/expenses", { cookie: s.owner, body })
    expect(again.status).toBe(200)
    expect(((await again.json()) as { duplicate: boolean }).duplicate).toBe(true)
    expect(balanceOf("Efectivo USD")).toBe(-500)
  })
})

describe("anular un gasto", () => {
  test("devuelve el dinero a la cuenta y el gasto deja de contar", async () => {
    const s = await setUp(h)
    const [, services] = await categories(s.owner)
    if (!services) throw new Error("falta la categoría")
    const res = await h.call("/api/expenses", {
      cookie: s.owner,
      body: expenseBody(s.terminalId, services.id, {
        method: s.methodUsd,
        currency: "USD",
        amountMinor: 1200,
      }),
    })
    const { id } = (await res.json()) as { id: string }
    expect(balanceOf("Efectivo USD")).toBe(-1200)

    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    const denied = await h.call(`/api/documents/${id}/void`, {
      cookie: cashier,
      body: { reversalId: uuidv7(), reason: "x" },
    })
    expect(denied.status).toBe(403)

    const voided = await h.call(`/api/documents/${id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7(), reason: "Lo registré dos veces" },
    })
    expect(voided.status).toBe(201)
    expect(balanceOf("Efectivo USD")).toBe(0)

    const list = (await (await h.call("/api/expenses", { cookie: s.owner })).json()) as Expenses
    expect(list.rows).toHaveLength(2) // el gasto y su reverso
    expect(list.rows.find((r) => r.id === id)?.reversedBy).not.toBeNull()
    expect(list.totalLegalMinor).toBe(0)
    expect(list.byCategory).toEqual([])
    expect((await categories(s.owner)).find((c) => c.id === services.id)?.expenseCount).toBe(0)
    expect(checkInvariants(h.db)).toEqual([])

    const twice = await h.call(`/api/documents/${id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7() },
    })
    expect(twice.status).toBe(409)
  })
})

describe("gastos en el resumen del día y del turno", () => {
  test("suman en Inicio y en el reporte del turno, netos de anulaciones", async () => {
    const s = await setUp(h)
    const [, services] = await categories(s.owner)
    if (!services) throw new Error("falta la categoría")
    const post = async (amountMinor: number) => {
      const res = await h.call("/api/expenses", {
        cookie: s.owner,
        body: expenseBody(s.terminalId, services.id, {
          method: s.methodUsd,
          currency: "USD",
          amountMinor,
        }),
      })
      return ((await res.json()) as { id: string }).id
    }
    await post(1000)
    const second = await post(400)
    await h.call(`/api/documents/${second}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7() },
    })

    const day = (await (await h.call("/api/reports/day", { cookie: s.owner })).json()) as DaySummary
    expect(day.expenses).toEqual({ count: 1, totalLegalMinor: 36_500 })

    const report = (await (
      await h.call(`/api/shifts/${s.shiftId}/report`, { cookie: s.owner })
    ).json()) as ShiftReport
    expect(report.expenses).toEqual({ count: 1, totalLegalMinor: 36_500 })
    expect(checkInvariants(h.db)).toEqual([])
  })
})
