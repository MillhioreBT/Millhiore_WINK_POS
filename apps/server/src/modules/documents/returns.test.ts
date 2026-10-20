import { beforeEach, describe, expect, test } from "bun:test"
import type {
  DaySummary,
  DocumentDetail,
  PostedDocumentBody,
  Receivables,
  Returnable,
  ShiftReport,
} from "@millhiore/contracts"
import { accountBalance, stockBalance } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

type Ctx = Awaited<ReturnType<typeof setUp>>

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

const stock = () => h.db.select().from(stockBalance).get()?.qtyMilli ?? 0
const cashUsd = () => h.db.select().from(accountBalance).get()?.amountMinor ?? 0

/** Vende `qty` panes a 1,50 $ (IVA incluido), con descuento opcional, y paga todo en dólares. */
async function sell(s: Ctx, qty: number, discountMinor = 0, over: Record<string, unknown> = {}) {
  const total = qty * 150 - discountMinor
  const body = saleBody(s.terminalId, s.methodUsd, {
    lines: [{ variantId: "v1", qtyMilli: qty * 1000, unitPriceMinor: 150, discountMinor }],
    payments: [{ id: uuidv7(), paymentMethodId: s.methodUsd, currency: "USD", amountMinor: total }],
    ...over,
  })
  const res = await h.call("/api/documents", { cookie: s.owner, body })
  expect(res.status).toBe(201)
  return body.id
}

const refund = (s: Ctx, amountMinor: number) => [
  { id: uuidv7(), paymentMethodId: s.methodUsd, currency: "USD", amountMinor },
]

function giveBack(
  s: Ctx,
  saleId: string,
  lines: { lineNo: number; qtyMilli: number }[],
  extra: Record<string, unknown> = {},
  cookie = s.owner,
) {
  return h.call(`/api/documents/${saleId}/return`, {
    cookie,
    body: {
      id: uuidv7(),
      terminalId: s.terminalId,
      rate: { base: "USD", quote: "VES", value: "36.5" },
      lines,
      payments: [],
      ...extra,
    },
  })
}

const returnable = async (s: Ctx, saleId: string) =>
  (await (
    await h.call(`/api/documents/${saleId}/returnable`, { cookie: s.owner })
  ).json()) as Returnable

describe("devolución parcial", () => {
  test("devuelve una parte: vuelven las existencias, sale el dinero y el IVA es el de la venta", async () => {
    const s = await setUp(h)
    const saleId = await sell(s, 3) // 4,50 $
    expect(stock()).toBe(-3000)

    const res = await giveBack(s, saleId, [{ lineNo: 1, qtyMilli: 1000 }], {
      payments: refund(s, 150),
    })
    expect(res.status).toBe(201)
    const posted = (await res.json()) as PostedDocumentBody
    expect(posted).toMatchObject({ number: "C1-DV-000001", totalMinor: 150 })
    expect(stock()).toBe(-2000)
    expect(cashUsd()).toBe(450 - 150)

    const detail = (await (
      await h.call(`/api/documents/${posted.id}`, { cookie: s.owner })
    ).json()) as DocumentDetail
    expect(detail).toMatchObject({ type: "RETURN", returnsNumber: "C1-000001" })
    // 1,50 $ con IVA 16 % incluido: base 1,29 e IVA 0,21
    expect(detail.taxes[0]).toMatchObject({ baseMinor: 129, taxMinor: 21 })
    expect(checkInvariants(h.db)).toEqual([])

    const left = await returnable(s, saleId)
    expect(left.lines[0]).toMatchObject({
      qtyMilli: 3000,
      returnedMilli: 1000,
      remainingMilli: 2000,
    })
  })

  test("no se devuelve más de lo vendido, ni dos veces la misma línea, ni de una venta anulada", async () => {
    const s = await setUp(h)
    const saleId = await sell(s, 2)
    expect(
      (await giveBack(s, saleId, [{ lineNo: 1, qtyMilli: 2000 }], { payments: refund(s, 300) }))
        .status,
    ).toBe(201)
    const again = await giveBack(s, saleId, [{ lineNo: 1, qtyMilli: 1000 }], {
      payments: refund(s, 150),
    })
    expect(again.status).toBe(409)
    expect(await errorCode(again)).toBe("NOT_RETURNABLE")

    const other = await sell(s, 1)
    const dup = await giveBack(s, other, [
      { lineNo: 1, qtyMilli: 500 },
      { lineNo: 1, qtyMilli: 500 },
    ])
    expect(await errorCode(dup)).toBe("NOT_RETURNABLE")
    expect(await errorCode(await giveBack(s, other, [{ lineNo: 9, qtyMilli: 100 }]))).toBe(
      "NOT_RETURNABLE",
    )
    expect((await giveBack(s, other, [{ lineNo: 1, qtyMilli: 0 }], { payments: [] })).status).toBe(
      422,
    )

    await h.call(`/api/documents/${other}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7() },
    })
    const onVoided = await giveBack(s, other, [{ lineNo: 1, qtyMilli: 1000 }], {
      payments: refund(s, 150),
    })
    expect(await errorCode(onVoided)).toBe("NOT_RETURNABLE")
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("el reembolso debe cubrir lo devuelto", async () => {
    const s = await setUp(h)
    const saleId = await sell(s, 2)
    const short = await giveBack(s, saleId, [{ lineNo: 1, qtyMilli: 1000 }], {
      payments: refund(s, 100),
    })
    expect(short.status).toBe(422)
    expect(await errorCode(short)).toBe("UNSETTLED")
    expect(stock()).toBe(-2000) // no se escribió nada
  })

  test("el descuento se devuelve en proporción y, al devolver todo, suma exactamente lo vendido", async () => {
    const s = await setUp(h)
    const saleId = await sell(s, 4, 100) // 6,00 − 1,00 = 5,00 $
    // 1 de 4 → descuento 0,25 → 1,25 $
    const first = (await (
      await giveBack(s, saleId, [{ lineNo: 1, qtyMilli: 1000 }], { payments: refund(s, 125) })
    ).json()) as PostedDocumentBody
    expect(first.totalMinor).toBe(125)
    // los 3 que quedan → descuento 0,75 → 3,75 $
    const rest = await giveBack(s, saleId, [{ lineNo: 1, qtyMilli: 3000 }], {
      payments: refund(s, 375),
    })
    expect(rest.status).toBe(201)
    expect(cashUsd()).toBe(0) // se devolvió exactamente lo cobrado
    expect(stock()).toBe(0)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("una venta fiada: la devolución se descuenta de la deuda en vez de reembolsarse", async () => {
    const s = await setUp(h)
    const rosa = (await (
      await h.call("/api/contacts", { cookie: s.owner, body: { kind: "customer", name: "Rosa" } })
    ).json()) as { id: string }
    const saleId = await sell(s, 2, 0, { contactId: rosa.id, creditMinor: 300, payments: [] })
    const info = await returnable(s, saleId)
    expect(info.debt).toEqual({ currency: "USD", outstandingMinor: 300 })

    const res = await giveBack(s, saleId, [{ lineNo: 1, qtyMilli: 1000 }], {
      creditAppliedMinor: 150,
    })
    expect(res.status).toBe(201)
    const owed = (await (
      await h.call("/api/receivables", { cookie: s.owner })
    ).json()) as Receivables
    expect(owed.totals[0]?.outstandingMinor).toBe(150)
    expect(cashUsd()).toBe(0) // no salió dinero
    expect(checkInvariants(h.db)).toEqual([])

    // No se puede descontar más de lo que debe.
    const over = await giveBack(s, saleId, [{ lineNo: 1, qtyMilli: 1000 }], {
      creditAppliedMinor: 200,
    })
    expect(over.status).toBe(422)

    // Anular la devolución devuelve la deuda.
    const { id } = (await res.json()) as PostedDocumentBody
    const voided = await h.call(`/api/documents/${id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7() },
    })
    expect(voided.status).toBe(201)
    const again = (await (
      await h.call("/api/receivables", { cookie: s.owner })
    ).json()) as Receivables
    expect(again.totals[0]?.outstandingMinor).toBe(300)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("una venta con devoluciones no se anula hasta anularlas; anular una devolución repone lo devuelto", async () => {
    const s = await setUp(h)
    const saleId = await sell(s, 2)
    const ret = (await (
      await giveBack(s, saleId, [{ lineNo: 1, qtyMilli: 1000 }], { payments: refund(s, 150) })
    ).json()) as PostedDocumentBody

    const blocked = await h.call(`/api/documents/${saleId}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7() },
    })
    expect(blocked.status).toBe(409)
    expect(await errorCode(blocked)).toBe("HAS_RETURNS")

    expect(
      (
        await h.call(`/api/documents/${ret.id}/void`, {
          cookie: s.owner,
          body: { reversalId: uuidv7() },
        })
      ).status,
    ).toBe(201)
    expect((await returnable(s, saleId)).lines[0]?.remainingMilli).toBe(2000)
    expect(cashUsd()).toBe(300)
    expect(
      (
        await h.call(`/api/documents/${saleId}/void`, {
          cookie: s.owner,
          body: { reversalId: uuidv7() },
        })
      ).status,
    ).toBe(201)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("las devoluciones restan de las ventas del día y del turno", async () => {
    const s = await setUp(h)
    const saleId = await sell(s, 4) // 6,00 $ = 219,00 Bs
    await giveBack(s, saleId, [{ lineNo: 1, qtyMilli: 1000 }], { payments: refund(s, 150) })

    const day = (await (await h.call("/api/reports/day", { cookie: s.owner })).json()) as DaySummary
    expect(day.sales.count).toBe(1)
    expect(day.sales.totalLegalMinor).toBe(21900 - 5475) // 4,50 $ netos
    expect(day.sales.returnsLegalMinor).toBe(5475)
    expect(day.byMethod.find((m) => m.currency === "USD")?.amountMinor).toBe(600 - 150)
    expect(day.topProducts[0]?.qtyMilli).toBe(3000)

    const report = (await (
      await h.call(`/api/shifts/${s.shiftId}/report`, { cookie: s.owner })
    ).json()) as ShiftReport
    expect(report.sales.totalLegalMinor).toBe(21900 - 5475)
    expect(report.sales.returnsLegalMinor).toBe(5475)
    expect(report.byMethod.find((m) => m.currency === "USD")?.amountMinor).toBe(450)
  })

  test("exige sale.void; la caja no arma devoluciones por la ruta general", async () => {
    const s = await setUp(h)
    const saleId = await sell(s, 2)
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect(
      (
        await giveBack(
          s,
          saleId,
          [{ lineNo: 1, qtyMilli: 1000 }],
          { payments: refund(s, 150) },
          cashier,
        )
      ).status,
    ).toBe(403)
    expect((await h.call(`/api/documents/${saleId}/returnable`, { cookie: cashier })).status).toBe(
      403,
    )

    const general = await h.call("/api/documents", {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        type: "RETURN",
        terminalId: s.terminalId,
        currency: "USD",
        lines: [{ variantId: "v1", qtyMilli: 1000, unitPriceMinor: 150 }],
        payments: refund(s, 150),
      },
    })
    expect(general.status).toBe(422)
  })

  test("reintentar la misma devolución es idempotente", async () => {
    const s = await setUp(h)
    const saleId = await sell(s, 2)
    const id = uuidv7()
    const send = () =>
      h.call(`/api/documents/${saleId}/return`, {
        cookie: s.owner,
        body: {
          id,
          terminalId: s.terminalId,
          rate: { base: "USD", quote: "VES", value: "36.5" },
          lines: [{ lineNo: 1, qtyMilli: 1000 }],
          payments: refund(s, 150),
        },
      })
    expect((await send()).status).toBe(201)
    expect((await send()).status).toBe(200)
    expect(cashUsd()).toBe(300 - 150)
  })
})
