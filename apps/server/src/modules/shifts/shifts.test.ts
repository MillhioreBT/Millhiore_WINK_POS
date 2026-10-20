import { beforeEach, describe, expect, test } from "bun:test"
import type { Shift, ShiftReport } from "@millhiore/contracts"
import { auditLog } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { sql } from "drizzle-orm"
import { checkInvariants } from "../../posting/invariants"
import {
  cashAccountIds,
  type Harness,
  harness,
  openShiftFor,
  saleBody,
  setUp,
} from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const RATE = { base: "USD", quote: "VES", value: "36.5" }

async function close(cookie: string, shiftId: string, counts: Record<string, number>) {
  return h.call(`/api/shifts/${shiftId}/close`, {
    cookie,
    body: {
      counts: Object.entries(cashAccountIds(h)).map(([name, accountId]) => ({
        accountId,
        countedMinor: counts[name] ?? 0,
        ...(name === "Efectivo USD" ? { denominations: { "1000": 1, "500": 1, "100": 2 } } : {}),
      })),
      note: "cierre de prueba",
    },
  })
}

async function cashOut(cookie: string, terminalId: string, methodId: string, amount: number) {
  return h.call("/api/documents", {
    cookie,
    body: {
      id: uuidv7(),
      type: "CASH_OUT",
      terminalId,
      currency: "USD",
      rate: RATE,
      payments: [{ id: uuidv7(), paymentMethodId: methodId, currency: "USD", amountMinor: amount }],
      note: "Pago del hielo",
    },
  })
}

describe("turnos de caja", () => {
  test("sin turno abierto no se vende", async () => {
    const { owner, terminalId, methodUsd, shiftId } = await setUp(h)
    expect((await close(owner, shiftId, {})).status).toBe(200)
    const sale = await h.call("/api/documents", {
      cookie: owner,
      body: saleBody(terminalId, methodUsd),
    })
    expect(sale.status).toBe(409)
    expect(((await sale.json()) as { error: { code: string } }).error.code).toBe("SHIFT_CLOSED")
  })

  test("ciclo completo: apertura con sobrante, venta, retiro y cierre con faltante", async () => {
    const { owner, terminalId, methodUsd, shiftId: first } = await setUp(h)
    await close(owner, first, {})

    // Abre contando 20 $ que no estaban en libros: sobrante asentado como ingreso.
    const shift = await openShiftFor(h, owner, terminalId, { "Efectivo USD": 2000 })
    const current = (await (
      await h.call(`/api/shifts/current?terminalId=${terminalId}`, { cookie: owner })
    ).json()) as Shift
    expect(current.id).toBe(shift.id)
    expect(current.accounts.find((a) => a.accountName === "Efectivo USD")).toMatchObject({
      openingExpectedMinor: 0,
      openingCountedMinor: 2000,
    })

    expect(
      (await h.call("/api/documents", { cookie: owner, body: saleBody(terminalId, methodUsd) }))
        .status,
    ).toBe(201)
    expect((await cashOut(owner, terminalId, methodUsd, 500)).status).toBe(201)

    // Esperado: 20 + 3 − 5 = 18 $. Se cuentan 17 $: faltante de 1 $.
    const closed = await close(owner, shift.id, { "Efectivo USD": 1700 })
    expect(closed.status).toBe(200)
    const body = (await closed.json()) as Shift
    expect(body.status).toBe("closed")
    expect(body.accounts.find((a) => a.accountName === "Efectivo USD")).toMatchObject({
      closingExpectedMinor: 1800,
      closingCountedMinor: 1700,
      differenceMinor: -100,
      closingDenominations: { "1000": 1, "500": 1, "100": 2 },
    })

    const report = (await (
      await h.call(`/api/shifts/${shift.id}/report`, { cookie: owner })
    ).json()) as ShiftReport
    expect(report.sales).toMatchObject({ count: 1, voided: 0, totalLegalMinor: 10950 })
    expect(report.byMethod).toEqual([
      {
        methodId: methodUsd,
        methodName: "Efectivo USD",
        currency: "USD",
        amountMinor: 300,
        commissionMinor: 0,
      },
    ])
    expect(report.cashMovements.map((m) => [m.type, m.totalMinor, m.adjustment])).toEqual([
      ["CASH_IN", 2000, true],
      ["CASH_OUT", 500, false],
      ["CASH_OUT", 100, true],
    ])

    expect(checkInvariants(h.db)).toEqual([])
    expect(
      h.db
        .select()
        .from(auditLog)
        .all()
        .filter((a) => a.action.startsWith("shift.")),
    ).toHaveLength(4) // dos aperturas y dos cierres
  })

  test("no se abren dos turnos en la misma caja; reintentar el mismo id es seguro", async () => {
    const { owner, terminalId, shiftId } = await setUp(h)
    const again = await h.call("/api/shifts", {
      cookie: owner,
      body: { id: uuidv7(), terminalId, counts: [] },
    })
    expect(again.status).toBe(409)
    const accounts = cashAccountIds(h)
    const retry = await h.call("/api/shifts", {
      cookie: owner,
      body: {
        id: shiftId,
        terminalId,
        counts: Object.values(accounts).map((accountId) => ({ accountId, countedMinor: 0 })),
      },
    })
    expect(((await retry.json()) as Shift).id).toBe(shiftId)
  })

  test("el conteo debe cubrir cada cuenta de efectivo y el cierre es único e inmutable", async () => {
    const { owner, shiftId } = await setUp(h)
    const missing = await h.call(`/api/shifts/${shiftId}/close`, {
      cookie: owner,
      body: { counts: [] },
    })
    expect(missing.status).toBe(422)
    expect((await close(owner, shiftId, {})).status).toBe(200)
    expect((await close(owner, shiftId, {})).status).toBe(409)
    let message = ""
    try {
      h.db.run(sql`update cash_shift set closing_note = 'x'`)
    } catch (e) {
      message = String((e as Error).cause ?? e)
    }
    expect(message).toMatch(/inmutable/)
  })

  test("los ingresos y retiros son solo de efectivo y exigen shift.manage", async () => {
    const { owner, terminalId } = await setUp(h)
    const methods = (await (await h.call("/api/bootstrap", { cookie: owner })).json()) as {
      paymentMethods: { id: string; name: string }[]
    }
    const zelleId = methods.paymentMethods.find((m) => m.name === "Zelle")?.id ?? ""
    const res = await cashOut(owner, terminalId, zelleId, 100)
    expect(res.status).toBe(422)

    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Ana", username: "ana", password: "otra-clave-1", roleId: "warehouse" },
    })
    const warehouse = await h.login("ana", "otra-clave-1")
    const usd = methods.paymentMethods.find((m) => m.name === "Efectivo USD")?.id ?? ""
    expect((await cashOut(warehouse, terminalId, usd, 100)).status).toBe(403)
  })

  test("checkInvariants detecta un arqueo manipulado", async () => {
    const { owner, terminalId, methodUsd, shiftId } = await setUp(h)
    await h.call("/api/documents", { cookie: owner, body: saleBody(terminalId, methodUsd) })
    await close(owner, shiftId, { "Efectivo USD": 300 })
    expect(checkInvariants(h.db)).toEqual([])
    h.db.run(sql`drop trigger cash_shift_account_closed_no_update`)
    h.db.run(sql`update cash_shift_account set closing_expected_minor = 999`)
    expect(checkInvariants(h.db).some((v) => v.invariant === 6)).toBe(true)
  })
})
