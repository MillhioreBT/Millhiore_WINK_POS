import { beforeEach, describe, expect, test } from "bun:test"
import type {
  Contact,
  DaySummary,
  DocumentDetail,
  Lots,
  Payables,
  PostedDocumentBody,
  Returnable,
  ShiftReport,
  TaxBook,
} from "@millhiore/contracts"
import { accountBalance, stockBalance } from "@millhiore/db"
import { addDays, uuidv7 } from "@millhiore/domain"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

type Ctx = Awaited<ReturnType<typeof setUp>>

const RATE = { base: "USD", quote: "VES", value: "36.5" }
const DAY = 86_400_000
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

const stock = () => h.db.select().from(stockBalance).get()?.qtyMilli ?? 0
const cashUsd = () => h.db.select().from(accountBalance).get()?.amountMinor ?? 0
const cash = (s: Ctx, amountMinor: number) => [
  { id: uuidv7(), paymentMethodId: s.methodUsd, currency: "USD", amountMinor },
]

async function supplier(s: Ctx) {
  const res = await h.call("/api/contacts", {
    cookie: s.owner,
    body: { kind: "supplier", name: "Distribuidora Andina" },
  })
  expect(res.status).toBe(201)
  return (await res.json()) as Contact
}

/** Compra a 1 $ la unidad con IVA incluido: pagada en efectivo o, con `credit`, a deber. */
async function buy(
  s: Ctx,
  qtyMilli: number,
  over: { contactId?: string; credit?: boolean; lot?: { code: string; expiresOn: string } } = {},
) {
  const total = qtyMilli / 10
  const res = await h.call("/api/documents", {
    cookie: s.owner,
    body: {
      id: uuidv7(),
      type: "PURCHASE",
      terminalId: s.terminalId,
      currency: "USD",
      rate: RATE,
      pricesIncludeTax: true,
      contactId: over.contactId ?? null,
      lines: [
        { variantId: "v1", qtyMilli, unitPriceMinor: 100, ...(over.lot ? { lot: over.lot } : {}) },
      ],
      payments: over.credit ? [] : cash(s, total),
      ...(over.credit ? { creditMinor: total, creditCurrency: "USD" } : {}),
    },
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as PostedDocumentBody).id
}

function giveBack(
  s: Ctx,
  purchaseId: string,
  lines: { lineNo: number; qtyMilli: number }[],
  extra: Record<string, unknown> = {},
  cookie = s.owner,
) {
  return h.call(`/api/documents/${purchaseId}/return`, {
    cookie,
    body: { id: uuidv7(), terminalId: s.terminalId, rate: RATE, lines, payments: [], ...extra },
  })
}

const returnable = async (s: Ctx, id: string) =>
  (await (
    await h.call(`/api/documents/${id}/returnable`, { cookie: s.owner })
  ).json()) as Returnable

const payables = async (s: Ctx) =>
  (await (await h.call("/api/payables", { cookie: s.owner })).json()) as Payables

describe("devolución a proveedor", () => {
  test("devuelve parte de una compra: sale la mercancía, entra el reembolso y el IVA es el de la compra", async () => {
    const s = await setUp(h)
    const purchaseId = await buy(s, 10_000) // 10,00 $
    expect(stock()).toBe(10_000)
    expect(cashUsd()).toBe(-1000)
    const info = await returnable(s, purchaseId)
    expect(info).toMatchObject({ kind: "PURCHASE", currency: "USD", pricesIncludeTax: true })

    const res = await giveBack(s, purchaseId, [{ lineNo: 1, qtyMilli: 3000 }], {
      payments: cash(s, 300),
    })
    expect(res.status).toBe(201)
    const posted = (await res.json()) as PostedDocumentBody
    expect(posted).toMatchObject({ number: "C1-DC-000001", totalMinor: 300 })
    expect(stock()).toBe(7000)
    expect(cashUsd()).toBe(-1000 + 300)

    const detail = (await (
      await h.call(`/api/documents/${posted.id}`, { cookie: s.owner })
    ).json()) as DocumentDetail
    expect(detail.type).toBe("PURCHASE_RETURN")
    expect(detail.returnsNumber).toBe(info.number)
    // 3,00 $ con IVA 16 % incluido: base 2,59 e IVA 0,41
    expect(detail.taxes[0]).toMatchObject({ baseMinor: 259, taxMinor: 41 })
    expect((await returnable(s, purchaseId)).lines[0]).toMatchObject({
      returnedMilli: 3000,
      remainingMilli: 7000,
    })
    expect(checkInvariants(h.db)).toEqual([])

    // No se devuelve más de lo comprado, y la compra no se anula mientras tenga devoluciones.
    const tooMuch = await giveBack(s, purchaseId, [{ lineNo: 1, qtyMilli: 8000 }], {
      payments: cash(s, 800),
    })
    expect(await errorCode(tooMuch)).toBe("NOT_RETURNABLE")
    const voidPurchase = () =>
      h.call(`/api/documents/${purchaseId}/void`, {
        cookie: s.owner,
        body: { reversalId: uuidv7() },
      })
    const blocked = await voidPurchase()
    expect(blocked.status).toBe(409)
    expect(await errorCode(blocked)).toBe("HAS_RETURNS")
    const undo = await h.call(`/api/documents/${posted.id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7() },
    })
    expect(undo.status).toBe(201)
    expect(stock()).toBe(10_000)
    expect(cashUsd()).toBe(-1000)
    expect((await voidPurchase()).status).toBe(201)
    expect(stock()).toBe(0)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("una compra a deber: la devolución se descuenta de lo que se le debe al proveedor", async () => {
    const s = await setUp(h)
    const andina = await supplier(s)
    const purchaseId = await buy(s, 10_000, { contactId: andina.id, credit: true })
    expect((await returnable(s, purchaseId)).debt).toEqual({
      currency: "USD",
      outstandingMinor: 1000,
    })

    const res = await giveBack(s, purchaseId, [{ lineNo: 1, qtyMilli: 4000 }], {
      creditAppliedMinor: 400,
    })
    expect(res.status).toBe(201)
    expect((await payables(s)).totals[0]?.outstandingMinor).toBe(600)
    expect(cashUsd()).toBe(0) // no entró dinero
    expect(checkInvariants(h.db)).toEqual([])

    // No se descuenta más de lo que se debe.
    const over = await giveBack(s, purchaseId, [{ lineNo: 1, qtyMilli: 6000 }], {
      creditAppliedMinor: 700,
    })
    expect(over.status).toBe(422)
    expect(await errorCode(over)).toBe("INVALID_ALLOCATION")

    // Anular la devolución devuelve la deuda.
    const { id } = (await res.json()) as PostedDocumentBody
    expect(
      (
        await h.call(`/api/documents/${id}/void`, {
          cookie: s.owner,
          body: { reversalId: uuidv7() },
        })
      ).status,
    ).toBe(201)
    expect((await payables(s)).totals[0]?.outstandingMinor).toBe(1000)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("sale de los lotes que trajo esa compra, aunque otro venza antes", async () => {
    const s = await setUp(h)
    await h.call("/api/products/p1", {
      method: "PATCH",
      cookie: s.owner,
      body: { tracksLots: true },
    })
    await h.call("/api/settings/features", { method: "PUT", cookie: s.owner, body: { lots: true } })
    const lots = async () =>
      Object.fromEntries(
        ((await (await h.call("/api/lots", { cookie: s.owner })).json()) as Lots).rows.map((r) => [
          r.code,
          r.qtyMilli,
        ]),
      )
    const today = ((await (await h.call("/api/lots", { cookie: s.owner })).json()) as Lots).today
    const late = await buy(s, 5000, { lot: { code: "L1", expiresOn: addDays(today, 60) } })
    await buy(s, 5000, { lot: { code: "L2", expiresOn: addDays(today, 10) } })

    const res = await giveBack(s, late, [{ lineNo: 1, qtyMilli: 2000 }], {
      payments: cash(s, 200),
    })
    expect(res.status).toBe(201)
    expect(await lots()).toEqual({ L1: 3000, L2: 5000 })
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("resta de las compras del día y del libro de compras, y aparece en el turno", async () => {
    const s = await setUp(h)
    const purchaseId = await buy(s, 10_000) // 10,00 $ = 365,00 Bs
    await giveBack(s, purchaseId, [{ lineNo: 1, qtyMilli: 2000 }], { payments: cash(s, 200) })

    const day = (await (await h.call("/api/reports/day", { cookie: s.owner })).json()) as DaySummary
    expect(day.purchases).toEqual({ count: 1, totalLegalMinor: 36_500 - 7300 })

    const book = (await (
      await h.call(
        `/api/reports/tax-book?kind=purchases&from=${h.clock.now - DAY}&to=${h.clock.now + DAY}`,
        { cookie: s.owner },
      )
    ).json()) as TaxBook
    expect(book.rows.map((r) => [r.type, r.totalLegalMinor])).toEqual([
      ["PURCHASE", 36_500],
      ["PURCHASE_RETURN", -7300],
    ])
    expect(book.rows[1]?.returns).toBe(book.rows[0]?.number ?? "")

    const report = (await (
      await h.call(`/api/shifts/${s.shiftId}/report`, { cookie: s.owner })
    ).json()) as ShiftReport
    expect(report.supplierReturns).toEqual({ count: 1, totalLegalMinor: 7300 })
  })

  test("exige purchase.void; la ruta general no arma devoluciones a proveedores", async () => {
    const s = await setUp(h)
    const purchaseId = await buy(s, 2000)
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    const denied = await giveBack(
      s,
      purchaseId,
      [{ lineNo: 1, qtyMilli: 1000 }],
      { payments: cash(s, 100) },
      cashier,
    )
    expect(denied.status).toBe(403)
    expect(
      (await h.call(`/api/documents/${purchaseId}/returnable`, { cookie: cashier })).status,
    ).toBe(403)

    const general = await h.call("/api/documents", {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        type: "PURCHASE_RETURN",
        terminalId: s.terminalId,
        currency: "USD",
        lines: [{ variantId: "v1", qtyMilli: 1000, unitPriceMinor: 100 }],
        payments: cash(s, 100),
      },
    })
    expect(general.status).toBe(422)
  })
})
