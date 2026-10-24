import { beforeEach, describe, expect, test } from "bun:test"
import type { DiscountCode, DocumentDetail } from "@millhiore/contracts"
import { paymentMethod } from "@millhiore/db"
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

async function newCode(s: Ctx, body: Record<string, unknown>) {
  const res = await h.call("/api/discount-codes", { cookie: s.owner, body })
  expect(res.status).toBe(201)
  return (await res.json()) as DiscountCode
}

async function cashier(s: Ctx) {
  const res = await h.call("/api/users", {
    cookie: s.owner,
    body: { name: "Caja", username: "cajera", password: "clave-segura-2", roleId: "cashier" },
  })
  expect(res.status).toBe(201)
  return h.login("cajera", "clave-segura-2")
}

/** Venta de 2 panes a 1,50 $ (3 $) con `discount` repartido y, si se da, el código. */
const sale = (s: Ctx, discount: number, codeId?: string) =>
  saleBody(s.terminalId, s.methodUsd, {
    lines: [{ variantId: "v1", qtyMilli: 2000, unitPriceMinor: 150, discountMinor: discount }],
    payments: [
      {
        id: uuidv7(),
        paymentMethodId: s.methodUsd,
        currency: "USD",
        amountMinor: 300 - discount,
      },
    ],
    ...(codeId ? { discountCodeId: codeId } : {}),
  })

describe("códigos de descuento", () => {
  test("se crean sin repetir el código; solo quien puede dar descuentos", async () => {
    const s = await setUp(h)
    const promo = await newCode(s, { code: "promo10", kind: "percent", rateBp: 1000 })
    expect(promo).toMatchObject({ code: "PROMO10", kind: "percent", rateBp: 1000, uses: 0 })
    const again = await h.call("/api/discount-codes", {
      cookie: s.owner,
      body: { code: "PROMO10", kind: "amount", amountMinor: 100, currency: "USD" },
    })
    expect(again.status).toBe(409)
    const bad = await h.call("/api/discount-codes", {
      cookie: s.owner,
      body: { code: "SINVALOR", kind: "amount" },
    })
    expect(bad.status).toBe(422)
    const cookie = await cashier(s)
    expect(
      (
        await h.call("/api/discount-codes", {
          cookie,
          body: { code: "X1", kind: "percent", rateBp: 500 },
        })
      ).status,
    ).toBe(403)
    // La caja sí lo valida.
    const check = await h.call("/api/discount-codes/check?code=promo10", { cookie })
    expect(check.status).toBe(200)
    expect(
      ((await (await h.call("/api/bootstrap", { cookie })).json()) as { discountCodes: number })
        .discountCodes,
    ).toBe(1)
  })

  test("el cajero sin permiso de descuentos descuenta solo lo que da el código", async () => {
    const s = await setUp(h)
    const promo = await newCode(s, { code: "PROMO10", kind: "percent", rateBp: 1000 })
    const cookie = await cashier(s)
    // Sin código, un descuento exige el permiso.
    expect((await h.call("/api/documents", { cookie, body: sale(s, 30) })).status).toBe(403)
    // Más de lo que da el código: no.
    const over = await h.call("/api/documents", { cookie, body: sale(s, 31, promo.id) })
    expect(over.status).toBe(409)
    expect(await errorCode(over)).toBe("DISCOUNT_DENIED")
    const res = await h.call("/api/documents", { cookie, body: sale(s, 30, promo.id) })
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }
    const doc = (await (
      await h.call(`/api/documents/${id}`, { cookie: s.owner })
    ).json()) as DocumentDetail
    expect(doc).toMatchObject({ discountCode: "PROMO10", discountMinor: 30, totalMinor: 270 })
    const list = (await (
      await h.call("/api/discount-codes", { cookie: s.owner })
    ).json()) as DiscountCode[]
    expect(list[0]?.uses).toBe(1)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("usos máximos: al agotarse no vale; anular la venta devuelve el uso", async () => {
    const s = await setUp(h)
    const once = await newCode(s, {
      code: "UNAVEZ",
      kind: "amount",
      amountMinor: 50,
      currency: "USD",
      maxUses: 1,
    })
    const first = await h.call("/api/documents", { cookie: s.owner, body: sale(s, 50, once.id) })
    expect(first.status).toBe(201)
    const used = await h.call("/api/documents", { cookie: s.owner, body: sale(s, 50, once.id) })
    expect(await errorCode(used)).toBe("DISCOUNT_DENIED")
    expect(
      await errorCode(await h.call("/api/discount-codes/check?code=unavez", { cookie: s.owner })),
    ).toBe("CODE_USED_UP")
    const { id } = (await first.json()) as { id: string }
    expect(
      (
        await h.call(`/api/documents/${id}/void`, {
          cookie: s.owner,
          body: { reversalId: uuidv7() },
        })
      ).status,
    ).toBe(201)
    expect(
      (await h.call("/api/documents", { cookie: s.owner, body: sale(s, 50, once.id) })).status,
    ).toBe(201)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("un código vencido o desactivado no vale; uno en dólares se lleva a bolívares", async () => {
    const s = await setUp(h)
    const old = await newCode(s, {
      code: "VIEJO",
      kind: "percent",
      rateBp: 500,
      validFrom: "2020-01-01",
      validUntil: "2020-12-31",
    })
    expect(
      await errorCode(await h.call("/api/discount-codes/check?code=VIEJO", { cookie: s.owner })),
    ).toBe("CODE_EXPIRED")
    expect(
      await errorCode(
        await h.call("/api/documents", { cookie: s.owner, body: sale(s, 15, old.id) }),
      ),
    ).toBe("DISCOUNT_DENIED")
    await h.call(`/api/discount-codes/${old.id}`, {
      method: "PATCH",
      cookie: s.owner,
      body: { active: false },
    })
    expect((await h.call("/api/discount-codes/check?code=VIEJO", { cookie: s.owner })).status).toBe(
      404,
    )

    // 1 $ de descuento en una venta en bolívares a 36,5: hasta Bs 36,50.
    const dollar = await newCode(s, {
      code: "UNDOLAR",
      kind: "amount",
      amountMinor: 100,
      currency: "USD",
    })
    const cookie = await cashier(s)
    const methodVes = h.db
      .select()
      .from(paymentMethod)
      .all()
      .find((m) => m.name === "Efectivo VES")?.id
    const ves = (discount: number) =>
      saleBody(s.terminalId, s.methodUsd, {
        currency: "VES",
        lines: [
          { variantId: "v1", qtyMilli: 1000, unitPriceMinor: 10_000, discountMinor: discount },
        ],
        payments: [
          {
            id: uuidv7(),
            paymentMethodId: methodVes,
            currency: "VES",
            amountMinor: 10_000 - discount,
          },
        ],
        discountCodeId: dollar.id,
      })
    expect(await errorCode(await h.call("/api/documents", { cookie, body: ves(3651) }))).toBe(
      "DISCOUNT_DENIED",
    )
    expect((await h.call("/api/documents", { cookie, body: ves(3650) })).status).toBe(201)
    expect(checkInvariants(h.db)).toEqual([])
  })
})
