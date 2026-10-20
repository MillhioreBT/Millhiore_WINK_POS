import { beforeEach, describe, expect, test } from "bun:test"
import type {
  Bootstrap,
  Contact,
  DaySummary,
  PostedDocumentBody,
  Receivables,
  ShiftReport,
  Statement,
} from "@millhiore/contracts"
import { paymentMethod, role } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

async function newCustomer(cookie: string, extra: Record<string, unknown> = {}) {
  const res = await h.call("/api/contacts", {
    cookie,
    body: { kind: "customer", name: "Doña Rosa", creditDays: 7, ...extra },
  })
  expect(res.status).toBe(201)
  return (await res.json()) as Contact
}

async function fiar(
  cookie: string,
  s: { terminalId: string; methodUsd: string },
  contactId: string,
  over: Record<string, unknown> = {},
) {
  const body = saleBody(s.terminalId, s.methodUsd, {
    contactId,
    creditMinor: 300,
    payments: [],
    ...over,
  })
  const res = await h.call("/api/documents", { cookie, body })
  return { res, body }
}

async function abonar(
  cookie: string,
  s: { terminalId: string; methodUsd: string },
  contactId: string,
  allocations: { saleDocumentId: string; amountMinor: number }[],
  amountMinor: number,
) {
  return h.call("/api/documents", {
    cookie,
    body: {
      id: uuidv7(),
      type: "PAYMENT_IN",
      terminalId: s.terminalId,
      currency: "USD",
      rate: { base: "USD", quote: "VES", value: "36.5" },
      contactId,
      allocations,
      payments: [{ id: uuidv7(), paymentMethodId: s.methodUsd, currency: "USD", amountMinor }],
    },
  })
}

describe("fiado por la API", () => {
  test("fiar, ver la deuda, abonar y saldar", async () => {
    const s = await setUp(h)
    const rosa = await newCustomer(s.owner, { creditLimitMinor: 5000 })
    expect(rosa).toMatchObject({ creditDays: 7, creditLimitMinor: 5000 })

    const { res, body } = await fiar(s.owner, s, rosa.id)
    expect(res.status).toBe(201)
    const posted = (await res.json()) as PostedDocumentBody
    expect(posted).toMatchObject({ totalMinor: 300, creditMinor: 300 })
    expect(posted.dueAt).toBe(1_760_000_000_000 + 7 * 86_400_000)

    const owed = (await (
      await h.call("/api/receivables", { cookie: s.owner })
    ).json()) as Receivables
    // Fiada a 7 días: todavía sin vencer.
    expect(owed.totals).toEqual([
      {
        currency: "USD",
        outstandingMinor: 300,
        overdueMinor: 0,
        customers: 1,
        aging: { current: 300, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 },
      },
    ])
    expect(owed.customers[0]).toMatchObject({ contactId: rosa.id, name: "Doña Rosa", openCount: 1 })

    // Abona 1,00 $ y luego salda.
    expect(
      (await abonar(s.owner, s, rosa.id, [{ saleDocumentId: body.id, amountMinor: 100 }], 100))
        .status,
    ).toBe(201)
    let statement = (await (
      await h.call(`/api/contacts/${rosa.id}/statement`, { cookie: s.owner })
    ).json()) as Statement
    expect(statement.balances).toEqual([
      { currency: "USD", outstandingMinor: 200, overdueMinor: 0 },
    ])
    expect(statement.owedReferenceMinor).toBe(200)
    expect(statement.open[0]).toMatchObject({
      paidMinor: 100,
      outstandingMinor: 200,
      overdue: false,
    })
    expect(statement.movements.map((m) => m.type)).toEqual(["PAYMENT_IN", "SALE"])

    expect(
      (await abonar(s.owner, s, rosa.id, [{ saleDocumentId: body.id, amountMinor: 200 }], 200))
        .status,
    ).toBe(201)
    statement = (await (
      await h.call(`/api/contacts/${rosa.id}/statement`, { cookie: s.owner })
    ).json()) as Statement
    expect(statement.open).toEqual([])
    expect(
      ((await (await h.call("/api/receivables", { cookie: s.owner })).json()) as Receivables)
        .customers,
    ).toEqual([])
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("la caja vende en bolívares y la deuda se ve en dólares", async () => {
    const s = await setUp(h)
    const rosa = await newCustomer(s.owner)
    const ves = h.db
      .select()
      .from(paymentMethod)
      .all()
      .find((m) => m.name === "Efectivo VES")
    const { res, body } = await fiar(s.owner, s, rosa.id, {
      currency: "VES",
      lines: [{ variantId: "v1", qtyMilli: 2000, unitPriceMinor: 5475 }],
      // 109,50 Bs: se pagan 36,50 Bs y 2,00 $ (73,00 Bs) quedan a deber
      payments: [
        {
          id: uuidv7(),
          paymentMethodId: ves?.id,
          currency: "VES",
          amountMinor: 3650,
          rate: { base: "USD", quote: "VES", value: "36.5" },
        },
      ],
      creditMinor: 200,
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      totalMinor: 10950,
      creditMinor: 200,
      creditCurrency: "USD",
    })
    const statement = (await (
      await h.call(`/api/contacts/${rosa.id}/statement`, { cookie: s.owner })
    ).json()) as Statement
    expect(statement.balances).toEqual([
      { currency: "USD", outstandingMinor: 200, overdueMinor: 0 },
    ])
    expect(statement.movements[0]).toMatchObject({
      type: "SALE",
      currency: "USD",
      amountMinor: 200,
    })
    // El abono se hace en dólares aunque la venta fuera en bolívares.
    const abono = await abonar(
      s.owner,
      s,
      rosa.id,
      [{ saleDocumentId: body.id, amountMinor: 200 }],
      200,
    )
    expect(abono.status).toBe(201)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("lo vencido se marca cuando pasa el plazo", async () => {
    const s = await setUp(h)
    const rosa = await newCustomer(s.owner)
    await fiar(s.owner, s, rosa.id)
    h.clock.now += 8 * 86_400_000
    const owed = (await (
      await h.call("/api/receivables", { cookie: s.owner })
    ).json()) as Receivables
    expect(owed.totals[0]).toMatchObject({ outstandingMinor: 300, overdueMinor: 300 })
    expect(owed.customers[0]?.nextDueAt).toBe(1_760_000_000_000 + 7 * 86_400_000)
  })

  test("sin permiso de fiar, el cajero cobra todo en el momento", async () => {
    const s = await setUp(h)
    const rosa = await newCustomer(s.owner)
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    // De fábrica el cajero fía; si el dueño le quita el permiso, ya no.
    expect((await fiar(cashier, s, rosa.id)).res.status).toBe(201)
    const perms = h.db.select().from(role).where(eq(role.id, "cashier")).get()?.permissions ?? []
    h.db
      .update(role)
      .set({ permissions: perms.filter((p) => p !== "sale.credit") })
      .where(eq(role.id, "cashier"))
      .run()
    const denied = await fiar(cashier, s, rosa.id)
    expect(denied.res.status).toBe(403)
    const cash = await h.call("/api/documents", {
      cookie: cashier,
      body: saleBody(s.terminalId, s.methodUsd, { contactId: rosa.id }),
    })
    expect(cash.status).toBe(201)
  })

  test("el almacenista no ve lo que deben los clientes", async () => {
    const s = await setUp(h)
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Luis", username: "luis", password: "otra-clave-2", roleId: "warehouse" },
    })
    const warehouse = await h.login("luis", "otra-clave-2")
    expect((await h.call("/api/receivables", { cookie: warehouse })).status).toBe(403)
    expect((await h.call("/api/contacts/x/statement", { cookie: warehouse })).status).toBe(403)
    expect((await h.call("/api/receivables")).status).toBe(401)
  })

  test("errores claros: sin cliente, de más y sin fiado activado", async () => {
    const s = await setUp(h)
    const rosa = await newCustomer(s.owner, { creditLimitMinor: 200 })
    const none = await fiar(s.owner, s, rosa.id, { contactId: null })
    expect(none.res.status).toBe(409)
    expect(await errorCode(none.res)).toBe("CREDIT_DENIED")

    const over = await fiar(s.owner, s, rosa.id)
    expect(over.res.status).toBe(409)
    expect(await errorCode(over.res)).toBe("CREDIT_DENIED")

    const free = await newCustomer(s.owner, { name: "Sin tope" })
    const sale = await fiar(s.owner, s, free.id)
    expect(sale.res.status).toBe(201)
    const tooMuch = await abonar(
      s.owner,
      s,
      free.id,
      [{ saleDocumentId: sale.body.id, amountMinor: 400 }],
      400,
    )
    expect(tooMuch.status).toBe(422)
    expect(await errorCode(tooMuch)).toBe("INVALID_ALLOCATION")

    expect(
      (
        await h.call("/api/settings/credit", {
          cookie: s.owner,
          method: "PUT",
          body: { enabled: false },
        })
      ).status,
    ).toBe(200)
    const off = await fiar(s.owner, s, free.id)
    expect(off.res.status).toBe(409)
    const boot = (await (await h.call("/api/bootstrap", { cookie: s.owner })).json()) as Bootstrap
    expect(boot.credit).toEqual({ enabled: false })
    // Lo ya fiado sigue a deber y se puede abonar.
    const rest = (await (
      await h.call("/api/receivables", { cookie: s.owner })
    ).json()) as Receivables
    expect(rest.totals[0]?.outstandingMinor).toBe(300)
  })

  test("anular una venta con abonos exige anular antes el abono", async () => {
    const s = await setUp(h)
    const rosa = await newCustomer(s.owner)
    const { body } = await fiar(s.owner, s, rosa.id)
    const abono = await abonar(
      s.owner,
      s,
      rosa.id,
      [{ saleDocumentId: body.id, amountMinor: 100 }],
      100,
    )
    const abonoId = ((await abono.json()) as PostedDocumentBody).id

    const blocked = await h.call(`/api/documents/${body.id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7(), reason: "error" },
    })
    expect(blocked.status).toBe(409)
    expect(await errorCode(blocked)).toBe("HAS_COLLECTIONS")

    expect(
      (
        await h.call(`/api/documents/${abonoId}/void`, {
          cookie: s.owner,
          body: { reversalId: uuidv7() },
        })
      ).status,
    ).toBe(201)
    expect(
      (
        await h.call(`/api/documents/${body.id}/void`, {
          cookie: s.owner,
          body: { reversalId: uuidv7() },
        })
      ).status,
    ).toBe(201)
    expect(
      ((await (await h.call("/api/receivables", { cookie: s.owner })).json()) as Receivables)
        .totals,
    ).toEqual([])
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("el resumen del día y el reporte del turno separan lo fiado y los abonos", async () => {
    const s = await setUp(h)
    const rosa = await newCustomer(s.owner)
    await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.terminalId, s.methodUsd),
    })
    const { body } = await fiar(s.owner, s, rosa.id)
    await abonar(s.owner, s, rosa.id, [{ saleDocumentId: body.id, amountMinor: 100 }], 100)

    const day = (await (await h.call("/api/reports/day", { cookie: s.owner })).json()) as DaySummary
    expect(day.sales.count).toBe(2)
    // 3,00 $ fiados × 36,5
    expect(day.sales.creditLegalMinor).toBe(10950)
    expect(day.collections).toEqual({ count: 1, totalLegalMinor: 3650 })
    // Lo cobrado por método suma la venta de contado y el abono: 3,00 + 1,00 $
    expect(day.byMethod.find((m) => m.currency === "USD")?.amountMinor).toBe(400)

    const report = (await (
      await h.call(`/api/shifts/${s.shiftId}/report`, { cookie: s.owner })
    ).json()) as ShiftReport
    expect(report.sales.creditLegalMinor).toBe(10950)
    expect(report.collections).toEqual({ count: 1, totalLegalMinor: 3650 })
    expect(report.byMethod.find((m) => m.currency === "USD")?.amountMinor).toBe(400)
  })
})
