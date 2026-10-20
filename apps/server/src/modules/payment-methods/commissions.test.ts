import { beforeEach, describe, expect, test } from "bun:test"
import type { Account, Contact, PaymentMethodRow, PostedDocumentBody } from "@millhiore/contracts"
import { payment } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const RATE = { base: "USD", quote: "VES", value: "36.5" }
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

const methods = async (cookie: string) =>
  (await (await h.call("/api/payment-methods", { cookie })).json()) as PaymentMethodRow[]
const method = async (cookie: string, name: string) => {
  const m = (await methods(cookie)).find((x) => x.name === name)
  if (!m) throw new Error(`no hay método ${name}`)
  return m
}
const balance = async (cookie: string, name: string) =>
  ((await (await h.call("/api/accounts", { cookie })).json()) as Account[]).find(
    (a) => a.name === name,
  )?.balanceMinor
const setCommission = (cookie: string, id: string, commissionBp: number) =>
  h.call(`/api/payment-methods/${id}`, { cookie, method: "PATCH", body: { commissionBp } })

/** Una venta de 3,00 $ pagada en bolívares con tarjeta (109,50 Bs a 36,5 = 10.950 unidades menores). */
const cardSale = (terminalId: string, methodId: string, over: Record<string, unknown> = {}) =>
  saleBody(terminalId, methodId, {
    payments: [
      {
        id: uuidv7(),
        paymentMethodId: methodId,
        currency: "VES",
        amountMinor: 10_950,
        rate: RATE,
        reference: "REF-1",
      },
    ],
    ...over,
  })

describe("métodos de pago y su comisión", () => {
  test("se lista cada método con su cuenta y se le pone comisión", async () => {
    const { owner } = await setUp(h)
    const list = await methods(owner)
    expect(list.map((m) => m.name).sort()).toEqual([
      "Efectivo USD",
      "Efectivo VES",
      "Pago móvil",
      "Punto de venta",
      "Zelle",
    ])
    const card = await method(owner, "Punto de venta")
    expect(card).toMatchObject({
      accountName: "Punto de venta",
      currency: "VES",
      kind: "bank",
      requiresReference: true,
      commissionBp: 0,
      active: true,
    })
    const res = await setCommission(owner, card.id, 250)
    expect(res.status).toBe(200)
    expect(((await res.json()) as PaymentMethodRow).commissionBp).toBe(250)
    expect((await method(owner, "Punto de venta")).commissionBp).toBe(250)
  })

  test("valida el rango, existencia, cuenta inactiva y permisos", async () => {
    const { owner } = await setUp(h)
    const card = await method(owner, "Punto de venta")
    expect((await setCommission(owner, card.id, 10_001)).status).toBe(422)
    expect((await setCommission(owner, card.id, -1)).status).toBe(422)
    expect((await setCommission(owner, card.id, 2.5)).status).toBe(422)
    expect((await setCommission(owner, "no-existe", 100)).status).toBe(404)

    // Una cuenta desactivada no deja activar su método.
    const accounts = (await (await h.call("/api/accounts", { cookie: owner })).json()) as Account[]
    const zelle = accounts.find((a) => a.name === "Zelle")
    await h.call(`/api/accounts/${zelle?.id}`, {
      cookie: owner,
      method: "PATCH",
      body: { active: false },
    })
    const zelleMethod = await method(owner, "Zelle")
    expect(zelleMethod.active).toBe(false)
    const reactivate = await h.call(`/api/payment-methods/${zelleMethod.id}`, {
      cookie: owner,
      method: "PATCH",
      body: { active: true },
    })
    expect(reactivate.status).toBe(409)
    expect(await errorCode(reactivate)).toBe("ACCOUNT_INACTIVE")

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
    expect((await h.call("/api/payment-methods", { cookie: cashier })).status).toBe(403)
    expect((await setCommission(cashier, card.id, 100)).status).toBe(403)
    expect((await h.call("/api/payment-methods", { cookie: manager })).status).toBe(200)
    expect((await setCommission(manager, card.id, 100)).status).toBe(200)
  })
})

describe("la comisión en las ventas", () => {
  test("la cuenta recibe el cobro menos la comisión y el pago la guarda congelada", async () => {
    const s = await setUp(h)
    const card = await method(s.owner, "Punto de venta")
    await setCommission(s.owner, card.id, 250)

    const res = await h.call("/api/documents", {
      cookie: s.owner,
      body: cardSale(s.terminalId, card.id),
    })
    expect(res.status).toBe(201)
    // 10.950 × 2,5 % = 273,75 → 274 (la mitad hacia arriba)
    const rows = h.db.select().from(payment).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      amountMinor: 10_950,
      commissionRateBp: 250,
      commissionMinor: 274,
    })
    expect(await balance(s.owner, "Punto de venta")).toBe(10_950 - 274)
    expect(checkInvariants(h.db)).toEqual([])

    // Cambiar la comisión después no toca lo ya cobrado.
    await setCommission(s.owner, card.id, 0)
    expect(h.db.select().from(payment).all()[0]?.commissionRateBp).toBe(250)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("anular la venta devuelve también la comisión", async () => {
    const s = await setUp(h)
    const card = await method(s.owner, "Punto de venta")
    await setCommission(s.owner, card.id, 300)
    const body = cardSale(s.terminalId, card.id)
    const posted = (await (
      await h.call("/api/documents", { cookie: s.owner, body })
    ).json()) as PostedDocumentBody
    expect((await balance(s.owner, "Punto de venta")) ?? 0).toBeGreaterThan(0)

    const voided = await h.call(`/api/documents/${posted.id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7(), reason: "Error de cobro" },
    })
    expect(voided.status).toBe(201)
    expect(await balance(s.owner, "Punto de venta")).toBe(0)
    const rows = h.db.select().from(payment).all()
    expect(rows).toHaveLength(2)
    expect(rows[0]?.commissionMinor).toBe(-(rows[1]?.commissionMinor ?? 0))
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("el efectivo sin comisión y el pago mixto solo pagan donde corresponde", async () => {
    const s = await setUp(h)
    const card = await method(s.owner, "Punto de venta")
    await setCommission(s.owner, card.id, 200)
    // 3,00 $: 1,00 $ en efectivo y el resto (2,00 $ = 7.300 Bs) con tarjeta
    const res = await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.terminalId, s.methodUsd, {
        payments: [
          { id: uuidv7(), paymentMethodId: s.methodUsd, currency: "USD", amountMinor: 100 },
          {
            id: uuidv7(),
            paymentMethodId: card.id,
            currency: "VES",
            amountMinor: 7_300,
            rate: RATE,
            reference: "REF-2",
          },
        ],
      }),
    })
    expect(res.status).toBe(201)
    expect(await balance(s.owner, "Efectivo USD")).toBe(100)
    // 7.300 × 2 % = 146
    expect(await balance(s.owner, "Punto de venta")).toBe(7_300 - 146)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("un abono también paga comisión y una devolución no la reembolsa", async () => {
    const s = await setUp(h)
    const card = await method(s.owner, "Punto de venta")
    await setCommission(s.owner, card.id, 100)
    const rosa = (await (
      await h.call("/api/contacts", {
        cookie: s.owner,
        body: { kind: "customer", name: "Doña Rosa", creditDays: 7 },
      })
    ).json()) as Contact
    const sale = (await (
      await h.call("/api/documents", {
        cookie: s.owner,
        body: saleBody(s.terminalId, s.methodUsd, {
          contactId: rosa.id,
          creditMinor: 300,
          payments: [],
        }),
      })
    ).json()) as PostedDocumentBody
    const abono = await h.call("/api/documents", {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        type: "PAYMENT_IN",
        terminalId: s.terminalId,
        currency: "USD",
        rate: RATE,
        contactId: rosa.id,
        allocations: [{ saleDocumentId: sale.id, amountMinor: 300 }],
        payments: [
          {
            id: uuidv7(),
            paymentMethodId: card.id,
            currency: "VES",
            amountMinor: 10_950,
            rate: RATE,
            reference: "ABONO-1",
          },
        ],
      },
    })
    expect(abono.status).toBe(201)
    // 10.950 × 1 % = 109,5 → 110 (la mitad sube)
    expect(await balance(s.owner, "Punto de venta")).toBe(10_950 - 110)
    expect(checkInvariants(h.db)).toEqual([])

    // Una compra o un gasto pagado por ese método no genera comisión.
    const expense = await h.call("/api/expenses", {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        terminalId: s.terminalId,
        currency: "VES",
        rate: null,
        amountMinor: 1_000,
        categoryId: (
          (await (await h.call("/api/expense-categories", { cookie: s.owner })).json()) as {
            id: string
          }[]
        )[0]?.id,
        note: "Flete",
        payments: [
          {
            id: uuidv7(),
            paymentMethodId: card.id,
            currency: "VES",
            amountMinor: 1_000,
            rate: null,
            reference: "G-1",
          },
        ],
      },
    })
    expect(expense.status).toBe(201)
    expect(await balance(s.owner, "Punto de venta")).toBe(10_950 - 110 - 1_000)
    expect(checkInvariants(h.db)).toEqual([])
  })
})
