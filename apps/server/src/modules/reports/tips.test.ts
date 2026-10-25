import { beforeEach, describe, expect, test } from "bun:test"
import type { Bootstrap, DocumentDetail, ShiftReport, TipsReport } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, NOW, saleBody, setUp } from "../../testing/harness"

let h: Harness
let s: Awaited<ReturnType<typeof setUp>>
beforeEach(async () => {
  h = harness()
  s = await setUp(h)
  await h.call("/api/settings/features", { method: "PUT", cookie: s.owner, body: { tips: true } })
})

async function json<T>(res: Response, status = 200): Promise<T> {
  if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

/** Venta de 3,00 $ (dos panes) pagada en efectivo, con propina. */
const sale = (tipMinor: number, tipUserId: string | null, paid = 300 + tipMinor) =>
  h.call("/api/documents", {
    cookie: s.owner,
    body: saleBody(s.terminalId, s.methodUsd, {
      tipMinor,
      tipUserId,
      payments: [
        { id: uuidv7(), paymentMethodId: s.methodUsd, currency: "USD", amountMinor: paid },
      ],
    }),
  })

async function waiter(): Promise<string> {
  await h.call("/api/users", {
    cookie: s.owner,
    body: { name: "Juan Mesonero", username: "juan", password: "otra-clave-1", roleId: "waiter" },
  })
  const boot = await json<Bootstrap>(await h.call("/api/bootstrap", { cookie: s.owner }))
  const juan = boot.staff.find((u) => u.name === "Juan Mesonero")
  if (!juan) throw new Error("falta Juan en el equipo")
  return juan.id
}

describe("propinas", () => {
  test("los pagos la cubren aparte del total y queda para quien se eligió", async () => {
    const juan = await waiter()
    // Pagar solo la venta no alcanza.
    expect((await sale(50, juan, 300)).status).toBe(422)
    const res = await sale(50, juan)
    expect(res.status).toBe(201)
    const posted = (await res.json()) as { id: string; totalMinor: number }
    expect(posted.totalMinor).toBe(300)
    const doc = await json<DocumentDetail>(
      await h.call(`/api/documents/${posted.id}`, { cookie: s.owner }),
    )
    expect(doc).toMatchObject({
      totalMinor: 300,
      tipMinor: 50,
      tipLegalMinor: 1825,
      tipUserId: juan,
      tipUserName: "Juan Mesonero",
    })
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("el turno y el informe dicen cuánto le toca a cada quien, sin lo anulado", async () => {
    const juan = await waiter()
    const first = (await (await sale(50, juan)).json()) as { id: string }
    await sale(100, juan)
    await sale(20, null)
    // Se anula la primera: su propina se resta.
    const voided = await h.call(`/api/documents/${first.id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7(), reason: "error" },
    })
    expect(voided.status).toBe(201)

    const shift = await json<ShiftReport>(
      await h.call(`/api/shifts/${s.shiftId}/report`, { cookie: s.owner }),
    )
    expect(shift.tips).toEqual([
      { userId: juan, name: "Juan Mesonero", totalLegalMinor: 3650 },
      { userId: null, name: "Todo el equipo", totalLegalMinor: 730 },
    ])
    // La propina no es venta.
    expect(shift.sales.totalLegalMinor).toBe(2 * 300 * 36.5)

    const report = await json<TipsReport>(
      await h.call(`/api/reports/tips?from=${NOW - 86_400_000}&to=${NOW + 86_400_000}`, {
        cookie: s.owner,
      }),
    )
    expect(report.rows).toEqual([
      {
        userId: juan,
        name: "Juan Mesonero",
        count: 1,
        totalLegalMinor: 3650,
        totalReferenceMinor: 100,
      },
      {
        userId: null,
        name: "Todo el equipo",
        count: 1,
        totalLegalMinor: 730,
        totalReferenceMinor: 20,
      },
    ])
    expect(report).toMatchObject({ totalLegalMinor: 4380, totalReferenceMinor: 120 })
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("solo una venta lleva propina, y para alguien activo", async () => {
    const nobody = await sale(50, "nadie")
    expect(nobody.status).toBe(422)
    expect(((await nobody.json()) as { error: { message: string } }).error.message).toContain(
      "no está activo",
    )
    // Decir para quién sin propina no tiene sentido.
    expect((await sale(0, await waiter())).status).toBe(422)
    const purchase = await h.call("/api/documents", {
      cookie: s.owner,
      body: {
        ...saleBody(s.terminalId, s.methodUsd, { tipMinor: 50 }),
        type: "PURCHASE",
      },
    })
    expect(purchase.status).toBe(422)
  })
})
