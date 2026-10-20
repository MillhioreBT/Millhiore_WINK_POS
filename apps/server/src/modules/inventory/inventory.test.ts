import { beforeEach, describe, expect, test } from "bun:test"
import type { PostedDocumentBody, StockAdjustments, StockReason } from "@millhiore/contracts"
import { documentLine, variant } from "@millhiore/db"
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

const reasons = async (cookie: string, all = false) =>
  (await (
    await h.call(`/api/stock-reasons${all ? "?all=true" : ""}`, { cookie })
  ).json()) as StockReason[]
const reasonId = async (cookie: string, name: string) => {
  const r = (await reasons(cookie, true)).find((x) => x.name === name)
  if (!r) throw new Error(`no hay motivo ${name}`)
  return r.id
}
const adjustments = async (cookie: string, query = "") =>
  (await (await h.call(`/api/stock-adjustments${query}`, { cookie })).json()) as StockAdjustments

const adjust = (
  cookie: string,
  terminalId: string,
  qtyMilli: number,
  over: Record<string, unknown> = {},
) =>
  h.call("/api/documents", {
    cookie,
    body: {
      id: uuidv7(),
      type: "ADJUSTMENT",
      terminalId,
      currency: "VES",
      lines: [{ variantId: "v1", qtyMilli, unitPriceMinor: 0 }],
      payments: [],
      ...over,
    },
  })

/** Compra de `qty` unidades a `unit` USD (en centavos) pagada en efectivo: fija el costo. */
const buy = (
  cookie: string,
  s: { terminalId: string; methodUsd: string },
  qty: number,
  unit = 100,
) =>
  h.call("/api/documents", {
    cookie,
    body: {
      id: uuidv7(),
      type: "PURCHASE",
      terminalId: s.terminalId,
      currency: "USD",
      rate: RATE,
      lines: [{ variantId: "v1", qtyMilli: qty * 1000, unitPriceMinor: unit }],
      payments: [
        {
          id: uuidv7(),
          paymentMethodId: s.methodUsd,
          currency: "USD",
          amountMinor: Math.round(qty * unit * 1.16),
          rate: null,
        },
      ],
    },
  })

describe("motivos de ajuste", () => {
  test("vienen de fábrica, se crean, se renombran y se desactivan", async () => {
    const { owner } = await setUp(h)
    const list = await reasons(owner)
    expect(list.map((r) => [r.name, r.direction])).toEqual([
      ["Entrada de mercancía", "in"],
      ["Sobrante de conteo", "in"],
      ["Otra entrada", "in"],
      ["Merma o daño", "out"],
      ["Vencido", "out"],
      ["Uso interno", "out"],
      ["Robo o pérdida", "out"],
      ["Faltante de conteo", "out"],
      ["Otra salida", "out"],
    ])

    const res = await h.call("/api/stock-reasons", {
      cookie: owner,
      body: { name: "Regalo a cliente", direction: "out" },
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as StockReason
    expect(created).toMatchObject({
      name: "Regalo a cliente",
      direction: "out",
      adjustmentCount: 0,
    })
    const dup = await h.call("/api/stock-reasons", {
      cookie: owner,
      body: { name: "Vencido", direction: "out" },
    })
    expect(dup.status).toBe(409)
    expect(await errorCode(dup)).toBe("DUPLICATE_NAME")

    // El sentido no se cambia aunque se mande
    const renamed = await h.call(`/api/stock-reasons/${created.id}`, {
      cookie: owner,
      method: "PATCH",
      body: { name: "Obsequio", direction: "in" },
    })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({ name: "Obsequio", direction: "out" })
    await h.call(`/api/stock-reasons/${created.id}`, {
      cookie: owner,
      method: "PATCH",
      body: { active: false },
    })
    expect((await reasons(owner)).some((r) => r.id === created.id)).toBe(false)
    expect((await reasons(owner, true)).some((r) => r.id === created.id)).toBe(true)
    expect(
      (
        await h.call("/api/stock-reasons/no-existe", {
          cookie: owner,
          method: "PATCH",
          body: { name: "X" },
        })
      ).status,
    ).toBe(404)
  })

  test("el cajero los ve pero no los cambia; el almacenista sí", async () => {
    const { owner } = await setUp(h)
    for (const [username, roleId] of [
      ["pedro", "cashier"],
      ["luis", "warehouse"],
    ] as const) {
      await h.call("/api/users", {
        cookie: owner,
        body: { name: username, username, password: "otra-clave-1", roleId },
      })
    }
    const cashier = await h.login("pedro", "otra-clave-1")
    const warehouse = await h.login("luis", "otra-clave-1")
    expect((await h.call("/api/stock-reasons", { cookie: cashier })).status).toBe(200)
    expect(
      (
        await h.call("/api/stock-reasons", {
          cookie: cashier,
          body: { name: "X", direction: "in" },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await h.call("/api/stock-reasons", {
          cookie: warehouse,
          body: { name: "Derrame", direction: "out" },
        })
      ).status,
    ).toBe(201)
  })
})

describe("ajustes con motivo", () => {
  test("una salida por merma se valora con el último costo, en bolívares a la tasa del día", async () => {
    const s = await setUp(h)
    // Entrada sin costo conocido todavía
    expect((await adjust(s.owner, s.terminalId, 3000)).status).toBe(201)
    let list = await adjustments(s.owner)
    expect(list.rows[0]).toMatchObject({
      reasonName: "Otra entrada",
      direction: "in",
      qtyMilli: 3000,
      unitCostMinor: null,
      valueLegalMinor: null,
    })
    expect(list.withoutCost).toBe(1)

    // La compra fija el costo en 1,00 $ por unidad
    expect((await buy(s.owner, s, 10)).status).toBe(201)
    expect(h.db.select().from(variant).all()[0]).toMatchObject({
      costMinor: 100,
      costCurrency: "USD",
    })

    const res = await adjust(s.owner, s.terminalId, -2000, {
      stockReasonId: await reasonId(s.owner, "Merma o daño"),
      note: "Se cayó una caja",
    })
    expect(res.status).toBe(201)
    list = await adjustments(s.owner)
    const row = list.rows.find((r) => r.reasonName === "Merma o daño")
    expect(row).toMatchObject({
      direction: "out",
      qtyMilli: -2000,
      unitCostMinor: 100,
      costCurrency: "USD",
      // 2 unidades × 1,00 $ = 2,00 $ × 36,5 = 73,00 Bs
      valueLegalMinor: -7300,
      note: "Se cayó una caja",
      reversedBy: null,
    })
    expect(list.byReason.find((r) => r.reasonName === "Merma o daño")).toMatchObject({
      count: 1,
      valueLegalMinor: -7300,
    })
    expect(list.outLegalMinor).toBe(7300)
    expect(list.legalCurrency).toBe("VES")
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("sin motivo se usa «Otra entrada» u «Otra salida»; lo incoherente se rechaza", async () => {
    const s = await setUp(h)
    await adjust(s.owner, s.terminalId, 5000)
    const out = await adjust(s.owner, s.terminalId, -1000)
    expect(out.status).toBe(201)
    expect((await adjustments(s.owner)).rows.map((r) => r.reasonName).sort()).toEqual([
      "Otra entrada",
      "Otra salida",
    ])

    const waste = await reasonId(s.owner, "Merma o daño")
    const entry = await reasonId(s.owner, "Entrada de mercancía")
    const wrongOut = await adjust(s.owner, s.terminalId, 1000, { stockReasonId: waste })
    expect(wrongOut.status).toBe(422)
    expect(await errorCode(wrongOut)).toBe("INVALID_LINE")
    expect((await adjust(s.owner, s.terminalId, -1000, { stockReasonId: entry })).status).toBe(422)
    expect((await adjust(s.owner, s.terminalId, 1000, { stockReasonId: "no-existe" })).status).toBe(
      422,
    )

    // Un motivo desactivado no se ofrece
    await h.call(`/api/stock-reasons/${waste}`, {
      cookie: s.owner,
      method: "PATCH",
      body: { active: false },
    })
    expect((await adjust(s.owner, s.terminalId, -1000, { stockReasonId: waste })).status).toBe(422)

    // Con dos líneas de signo distinto no se puede adivinar el motivo
    const mixed = await adjust(s.owner, s.terminalId, 1000, {
      lines: [
        { variantId: "v1", qtyMilli: 1000, unitPriceMinor: 0 },
        { variantId: "v1", qtyMilli: -1000, unitPriceMinor: 0 },
      ],
    })
    expect(mixed.status).toBe(422)

    // Solo un ajuste lleva motivo
    const sale = await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.terminalId, s.methodUsd, { stockReasonId: entry }),
    })
    expect(sale.status).toBe(422)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("anular un ajuste devuelve la existencia y lo resta de los totales", async () => {
    const s = await setUp(h)
    await adjust(s.owner, s.terminalId, 5000)
    await buy(s.owner, s, 1)
    const res = await adjust(s.owner, s.terminalId, -1000, {
      stockReasonId: await reasonId(s.owner, "Vencido"),
    })
    const { id } = (await res.json()) as PostedDocumentBody
    const voided = await h.call(`/api/documents/${id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7(), reason: "Lo conté mal" },
    })
    expect(voided.status).toBe(201)

    const list = await adjustments(s.owner)
    expect(list.rows.filter((r) => r.reasonName === "Vencido")).toHaveLength(2)
    expect(list.rows.find((r) => r.id === id)?.reversedBy).not.toBeNull()
    // Neto: nada salió por «Vencido»
    expect(list.byReason.some((r) => r.reasonName === "Vencido")).toBe(false)
    expect(list.outLegalMinor).toBe(0)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("filtra por motivo y por fechas", async () => {
    const s = await setUp(h)
    await adjust(s.owner, s.terminalId, 5000)
    const expired = await reasonId(s.owner, "Vencido")
    await adjust(s.owner, s.terminalId, -1000, { stockReasonId: expired })
    await adjust(s.owner, s.terminalId, -1000, {
      stockReasonId: await reasonId(s.owner, "Uso interno"),
    })
    expect((await adjustments(s.owner)).rows).toHaveLength(3)
    const onlyExpired = await adjustments(s.owner, `?reasonId=${expired}`)
    expect(onlyExpired.rows.map((r) => r.reasonName)).toEqual(["Vencido"])
    const none = await adjustments(s.owner, `?from=${h.clock.now + 1}`)
    expect(none.rows).toEqual([])
    const some = await adjustments(s.owner, `?from=${h.clock.now - 1}&to=${h.clock.now + 1}`)
    expect(some.rows).toHaveLength(3)
  })

  test("quien no ve costos no ve valores; el cajero no puede ajustar", async () => {
    const s = await setUp(h)
    for (const [username, roleId] of [
      ["pedro", "cashier"],
      ["luis", "warehouse"],
    ] as const) {
      await h.call("/api/users", {
        cookie: s.owner,
        body: { name: username, username, password: "otra-clave-1", roleId },
      })
    }
    await adjust(s.owner, s.terminalId, 5000)
    await buy(s.owner, s, 1)
    await adjust(s.owner, s.terminalId, -1000, {
      stockReasonId: await reasonId(s.owner, "Merma o daño"),
    })
    const warehouse = await h.login("luis", "otra-clave-1")
    const cashier = await h.login("pedro", "otra-clave-1")
    const seen = await adjustments(warehouse)
    expect(seen.rows).toHaveLength(2)
    expect(seen.rows.every((r) => r.valueLegalMinor === null && r.unitCostMinor === null)).toBe(
      true,
    )
    expect(seen.outLegalMinor).toBeNull()
    expect(seen.inLegalMinor).toBeNull()
    expect((await adjustments(s.owner)).outLegalMinor).toBe(3650)
    // El cajero mira existencias pero no ajusta
    expect((await h.call("/api/stock-adjustments", { cookie: cashier })).status).toBe(200)
    expect((await adjust(cashier, s.terminalId, -1000)).status).toBe(403)
  })
})

describe("costo congelado en las ventas", () => {
  test("una venta guarda el costo que tenía el producto; sin costo queda vacío", async () => {
    const s = await setUp(h)
    await adjust(s.owner, s.terminalId, 5000)
    const first = await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.terminalId, s.methodUsd),
    })
    expect(first.status).toBe(201)
    await buy(s.owner, s, 1, 80)
    const second = await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.terminalId, s.methodUsd),
    })
    expect(second.status).toBe(201)
    const lines = h.db.select().from(documentLine).all()
    const costs = lines.filter((l) => l.qtyMilli === 2000).map((l) => [l.costMinor, l.costCurrency])
    expect(costs).toEqual([
      [null, null],
      [80, "USD"],
    ])
  })
})
