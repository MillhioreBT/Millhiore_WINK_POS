import { beforeEach, describe, expect, test } from "bun:test"
import type {
  Contact,
  Payables,
  PostedDocumentBody,
  Receivables,
  Statement,
} from "@millhiore/contracts"
import { account, accountBalance } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const RATE = { base: "USD", quote: "VES", value: "36.5" }
const DAY = 86_400_000
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

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

async function contactOf(cookie: string, kind: "customer" | "supplier", extra = {}) {
  const res = await h.call("/api/contacts", {
    cookie,
    body: { kind, name: kind === "customer" ? "María Pérez" : "Distribuidora Andina", ...extra },
  })
  expect(res.status).toBe(201)
  return (await res.json()) as Contact
}

const debt = (
  s: { terminalId: string },
  type: "DEBT_IN" | "DEBT_OUT",
  contactId: string,
  amountMinor: number,
  over: Record<string, unknown> = {},
) => ({
  id: uuidv7(),
  type,
  terminalId: s.terminalId,
  contactId,
  currency: "USD",
  rate: RATE,
  amountMinor,
  note: "Saldo anterior",
  ...over,
})

const loan = (methodId: string, amountMinor: number) => [
  { id: uuidv7(), paymentMethodId: methodId, currency: "USD", amountMinor, rate: null },
]

describe("deudas anotadas a mano", () => {
  test("lo que un cliente ya debía sale en Fiado, se cobra con un abono y no mueve dinero", async () => {
    const s = await setUp(h)
    const maria = await contactOf(s.owner, "customer", { creditDays: 10 })
    const res = await h.call("/api/debts", {
      cookie: s.owner,
      body: debt(s, "DEBT_IN", maria.id, 2500),
    })
    expect(res.status).toBe(201)
    const posted = (await res.json()) as PostedDocumentBody
    expect(posted).toMatchObject({
      totalMinor: 2500,
      creditMinor: 2500,
      creditCurrency: "USD",
      totalLegalMinor: 91250,
    })
    expect(posted.number).toStartWith("C1-CC-")
    expect(posted.dueAt).toBe(1_760_000_000_000 + 10 * DAY)
    expect(balanceOf("Efectivo USD")).toBeUndefined()

    const owed = (await (
      await h.call("/api/receivables", { cookie: s.owner })
    ).json()) as Receivables
    expect(owed.customers).toMatchObject([{ contactId: maria.id, outstandingMinor: 2500 }])
    const st = (await (
      await h.call(`/api/contacts/${maria.id}/statement`, { cookie: s.owner })
    ).json()) as Statement
    expect(st.open).toMatchObject([{ id: posted.id, kind: "DEBT_IN", label: "Saldo anterior" }])
    expect(st.movements).toMatchObject([{ type: "DEBT_IN", amountMinor: 2500 }])

    const abono = await h.call("/api/documents", {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        type: "PAYMENT_IN",
        terminalId: s.terminalId,
        currency: "USD",
        rate: RATE,
        contactId: maria.id,
        allocations: [{ saleDocumentId: posted.id, amountMinor: 1000 }],
        payments: loan(s.methodUsd, 1000),
      },
    })
    expect(abono.status).toBe(201)
    expect(balanceOf("Efectivo USD")).toBe(1000)
    const after = (await (
      await h.call(`/api/contacts/${maria.id}/statement`, { cookie: s.owner })
    ).json()) as Statement
    expect(after.open).toMatchObject([{ outstandingMinor: 1500 }])
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("un préstamo a un cliente saca el dinero de la gaveta; uno de un proveedor lo mete", async () => {
    const s = await setUp(h)
    const maria = await contactOf(s.owner, "customer")
    const andina = await contactOf(s.owner, "supplier")
    const prestamo = await h.call("/api/debts", {
      cookie: s.owner,
      body: debt(s, "DEBT_OUT", andina.id, 5000, {
        note: "Préstamo",
        payments: loan(s.methodUsd, 5000),
      }),
    })
    expect(prestamo.status).toBe(201)
    expect(balanceOf("Efectivo USD")).toBe(5000)
    const adelanto = await h.call("/api/debts", {
      cookie: s.owner,
      body: debt(s, "DEBT_IN", maria.id, 2000, {
        note: "Adelanto",
        payments: loan(s.methodUsd, 2000),
      }),
    })
    expect(adelanto.status).toBe(201)
    expect(balanceOf("Efectivo USD")).toBe(3000)

    const owed = (await (await h.call("/api/payables", { cookie: s.owner })).json()) as Payables
    expect(owed.suppliers[0]?.open).toMatchObject([
      { kind: "DEBT_OUT", label: "Préstamo", outstandingMinor: 5000 },
    ])
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("lo prestado debe ser el monto de la deuda", async () => {
    const s = await setUp(h)
    const maria = await contactOf(s.owner, "customer")
    const res = await h.call("/api/debts", {
      cookie: s.owner,
      body: debt(s, "DEBT_IN", maria.id, 2000, { payments: loan(s.methodUsd, 1500) }),
    })
    expect(res.status).toBe(422)
    expect(await errorCode(res)).toBe("UNSETTLED")
  })

  test("la deuda de un cliente no se anota a un proveedor ni al revés", async () => {
    const s = await setUp(h)
    const maria = await contactOf(s.owner, "customer")
    const andina = await contactOf(s.owner, "supplier")
    for (const [type, id] of [
      ["DEBT_IN", andina.id],
      ["DEBT_OUT", maria.id],
    ] as const) {
      const res = await h.call("/api/debts", { cookie: s.owner, body: debt(s, type, id, 100) })
      expect(res.status).toBe(409)
      expect(await errorCode(res)).toBe("CREDIT_DENIED")
    }
  })

  test("no se anota por /api/documents ni sin permiso; reintentar no la duplica", async () => {
    const s = await setUp(h)
    const maria = await contactOf(s.owner, "customer")
    const generic = await h.call("/api/documents", {
      cookie: s.owner,
      body: { ...debt(s, "DEBT_IN", maria.id, 100), lines: [], payments: [] },
    })
    expect(generic.status).toBe(422)

    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    const denied = await h.call("/api/debts", {
      cookie: cashier,
      body: debt(s, "DEBT_IN", maria.id, 100),
    })
    expect(denied.status).toBe(403)

    const body = debt(s, "DEBT_IN", maria.id, 100)
    expect((await h.call("/api/debts", { cookie: s.owner, body })).status).toBe(201)
    expect((await h.call("/api/debts", { cookie: s.owner, body })).status).toBe(200)
  })

  test("se anula mientras no tenga abonos, y el préstamo devuelve el dinero", async () => {
    const s = await setUp(h)
    const maria = await contactOf(s.owner, "customer")
    const res = await h.call("/api/debts", {
      cookie: s.owner,
      body: debt(s, "DEBT_IN", maria.id, 2000, { payments: loan(s.methodUsd, 2000) }),
    })
    const posted = (await res.json()) as PostedDocumentBody
    expect(balanceOf("Efectivo USD")).toBe(-2000)

    const abono = await h.call("/api/documents", {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        type: "PAYMENT_IN",
        terminalId: s.terminalId,
        currency: "USD",
        rate: RATE,
        contactId: maria.id,
        allocations: [{ saleDocumentId: posted.id, amountMinor: 500 }],
        payments: loan(s.methodUsd, 500),
      },
    })
    const abonoDoc = (await abono.json()) as PostedDocumentBody
    const blocked = await h.call(`/api/documents/${posted.id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7() },
    })
    expect(blocked.status).toBe(409)

    expect(
      (
        await h.call(`/api/documents/${abonoDoc.id}/void`, {
          cookie: s.owner,
          body: { reversalId: uuidv7() },
        })
      ).status,
    ).toBe(201)
    const voided = await h.call(`/api/documents/${posted.id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7(), reason: "Mal anotada" },
    })
    expect(voided.status).toBe(201)
    expect(balanceOf("Efectivo USD")).toBe(0)
    const owed = (await (
      await h.call("/api/receivables", { cookie: s.owner })
    ).json()) as Receivables
    expect(owed.customers).toEqual([])
    expect(checkInvariants(h.db)).toEqual([])
  })
})
