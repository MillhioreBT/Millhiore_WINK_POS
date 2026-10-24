import { beforeEach, describe, expect, test } from "bun:test"
import type {
  DaySummary,
  ExpenseCategory,
  InventoryReport,
  PaymentMethodRow,
  PostedDocumentBody,
  ResultsReport,
  SalesReport,
  TaxBook,
} from "@millhiore/contracts"
import { category, documentTax, product, role } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const RATE = { base: "USD", quote: "VES", value: "36.5" }
const DAY = 86_400_000
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

/** Todo el día de hoy del arnés (UTC) y un poco antes y después. */
const WIDE = () => `from=${h.clock.now - 2 * DAY}&to=${h.clock.now + 2 * DAY}`
const get = async <T>(cookie: string, path: string) =>
  (await (await h.call(path, { cookie })).json()) as T

const method = async (cookie: string, name: string) => {
  const m = (await get<PaymentMethodRow[]>(cookie, "/api/payment-methods")).find(
    (x) => x.name === name,
  )
  if (!m) throw new Error(`no hay método ${name}`)
  return m
}

/** Compra de 20 unidades a 1,00 $ pagada en efectivo: el costo del producto queda en 1,00 $. */
const stockUp = (cookie: string, s: { terminalId: string; methodUsd: string }) =>
  h.call("/api/documents", {
    cookie,
    body: {
      id: uuidv7(),
      type: "PURCHASE",
      terminalId: s.terminalId,
      currency: "USD",
      rate: RATE,
      lines: [{ variantId: "v1", qtyMilli: 20_000, unitPriceMinor: 100 }],
      payments: [
        {
          id: uuidv7(),
          paymentMethodId: s.methodUsd,
          currency: "USD",
          amountMinor: 2320,
          rate: null,
        },
      ],
    },
  })

describe("estado de resultados", () => {
  test("ventas, costo, gastos, merma y comisiones hasta la utilidad neta", async () => {
    const s = await setUp(h)
    await stockUp(s.owner, s)
    const card = await method(s.owner, "Punto de venta")
    await h.call(`/api/payment-methods/${card.id}`, {
      cookie: s.owner,
      method: "PATCH",
      body: { commissionBp: 250 },
    })
    // Venta de 2 unidades = 3,00 $ = 109,50 Bs, cobrada con tarjeta (comisión 2,5 % → 274 = 2,74 Bs)
    const sale = await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.terminalId, card.id, {
        payments: [
          {
            id: uuidv7(),
            paymentMethodId: card.id,
            currency: "VES",
            amountMinor: 10_950,
            rate: RATE,
            reference: "T-1",
          },
        ],
      }),
    })
    expect(sale.status).toBe(201)
    const saleDoc = (await sale.json()) as PostedDocumentBody
    // Un gasto de 10,00 Bs
    const cashVes = await method(s.owner, "Efectivo VES")
    const category = (await get<ExpenseCategory[]>(s.owner, "/api/expense-categories"))[0]
    expect(
      (
        await h.call("/api/expenses", {
          cookie: s.owner,
          body: {
            id: uuidv7(),
            terminalId: s.terminalId,
            currency: "VES",
            rate: null,
            amountMinor: 1_000,
            categoryId: category?.id,
            note: "Bolsas",
            payments: [
              {
                id: uuidv7(),
                paymentMethodId: cashVes.id,
                currency: "VES",
                amountMinor: 1_000,
                rate: null,
              },
            ],
          },
        })
      ).status,
    ).toBe(201)
    // Una merma de 1 unidad (a 1,00 $ = 36,50 Bs)
    expect(
      (
        await h.call("/api/documents", {
          cookie: s.owner,
          body: {
            id: uuidv7(),
            type: "ADJUSTMENT",
            terminalId: s.terminalId,
            currency: "VES",
            lines: [{ variantId: "v1", qtyMilli: -1000, unitPriceMinor: 0 }],
            payments: [],
            stockReasonId: "stk-out-waste",
          },
        })
      ).status,
    ).toBe(201)

    const r = await get<ResultsReport>(s.owner, `/api/reports/results?${WIDE()}`)
    const tax = h.db
      .select()
      .from(documentTax)
      .where(eq(documentTax.documentId, saleDoc.id))
      .all()
      .reduce((acc, t) => acc + t.taxLegalMinor, 0)
    expect(r.legalCurrency).toBe("VES")
    expect(r.sales).toMatchObject({
      count: 1,
      totalLegalMinor: 10_950,
      taxLegalMinor: tax,
      netLegalMinor: 10_950 - tax,
    })
    expect(tax).toBeGreaterThan(0)
    // 2 unidades × 1,00 $ × 36,5 = 73,00 Bs
    expect(r.costOfGoodsLegalMinor).toBe(7_300)
    expect(r.linesWithoutCost).toBe(0)
    expect(r.grossProfitLegalMinor).toBe(10_950 - tax - 7_300)
    expect(r.grossMarginBp).toBe(Math.round(((10_950 - tax - 7_300) * 10_000) / (10_950 - tax)))
    expect(r.expenses).toMatchObject({ count: 1, totalLegalMinor: 1_000 })
    expect(r.expenses.byCategory).toEqual([
      { name: category?.name ?? "", count: 1, totalLegalMinor: 1_000 },
    ])
    expect(r.inventoryLossLegalMinor).toBe(3_650)
    // La misma merma sale en Inicio, el día en que ocurrió
    const today = await get<DaySummary>(s.owner, "/api/reports/day")
    expect(today.inventoryLossLegalMinor).toBe(3_650)
    expect(r.commissionsLegalMinor).toBe(274)
    expect(r.netProfitLegalMinor).toBe(10_950 - tax - 7_300 - 1_000 - 3_650 - 274)
    // La compra no es un gasto: sale aparte, como información
    expect(r.purchases).toMatchObject({ count: 1 })

    // Anular la venta devuelve costo, comisión y ventas a cero
    await h.call(`/api/documents/${saleDoc.id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7(), reason: "Prueba" },
    })
    const after = await get<ResultsReport>(s.owner, `/api/reports/results?${WIDE()}`)
    expect(after.sales).toMatchObject({
      count: 0,
      totalLegalMinor: 0,
      taxLegalMinor: 0,
      netLegalMinor: 0,
    })
    expect(after.costOfGoodsLegalMinor).toBe(0)
    expect(after.commissionsLegalMinor).toBe(0)
    expect(after.grossMarginBp).toBeNull()
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("una devolución resta ventas y el costo que tenía al venderse", async () => {
    const s = await setUp(h)
    await stockUp(s.owner, s)
    const sale = (await (
      await h.call("/api/documents", { cookie: s.owner, body: saleBody(s.terminalId, s.methodUsd) })
    ).json()) as PostedDocumentBody
    // El costo sube después: lo devuelto vale lo que costó al venderse
    await h.call("/api/documents", {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        type: "PURCHASE",
        terminalId: s.terminalId,
        currency: "USD",
        rate: RATE,
        lines: [{ variantId: "v1", qtyMilli: 1_000, unitPriceMinor: 500 }],
        payments: [
          {
            id: uuidv7(),
            paymentMethodId: s.methodUsd,
            currency: "USD",
            amountMinor: 580,
            rate: null,
          },
        ],
      },
    })
    const ret = await h.call(`/api/documents/${sale.id}/return`, {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        terminalId: s.terminalId,
        rate: RATE,
        lines: [{ lineNo: 1, qtyMilli: 1_000 }],
        payments: [
          { id: uuidv7(), paymentMethodId: s.methodUsd, currency: "USD", amountMinor: 150 },
        ],
      },
    })
    expect(ret.status).toBe(201)
    const r = await get<ResultsReport>(s.owner, `/api/reports/results?${WIDE()}`)
    // Vendió 2 y devolvió 1: queda 1 × 1,00 $ de costo (36,50 Bs), no 5,00 $
    expect(r.costOfGoodsLegalMinor).toBe(3_650)
    expect(r.sales.totalLegalMinor).toBe(10_950 - 5_475)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("las ventas sin costo conocido se avisan y sin cost.view no hay utilidad", async () => {
    const s = await setUp(h)
    // Se vende antes de comprar: el costo del producto todavía no se conoce
    await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.terminalId, s.methodUsd, {
        lines: [{ variantId: "v1", qtyMilli: 1_000, unitPriceMinor: 150 }],
        payments: [
          { id: uuidv7(), paymentMethodId: s.methodUsd, currency: "USD", amountMinor: 150 },
        ],
        allowNegative: true,
      }),
    })
    const owner = await get<ResultsReport>(s.owner, `/api/reports/results?${WIDE()}`)
    expect(owner.linesWithoutCost).toBe(1)
    expect(owner.costOfGoodsLegalMinor).toBe(0)

    // Un rol que mira informes pero no costos
    h.db
      .insert(role)
      .values({
        id: "viewer",
        name: "Solo informes",
        permissions: ["report.view"],
        isSystem: false,
      })
      .run()
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Vera", username: "vera", password: "otra-clave-1", roleId: "viewer" },
    })
    const viewer = await h.login("vera", "otra-clave-1")
    const blind = await get<ResultsReport>(viewer, `/api/reports/results?${WIDE()}`)
    expect(blind.sales.totalLegalMinor).toBe(owner.sales.totalLegalMinor)
    expect(blind.costOfGoodsLegalMinor).toBeNull()
    expect(blind.grossProfitLegalMinor).toBeNull()
    expect(blind.netProfitLegalMinor).toBeNull()
    expect(blind.inventoryLossLegalMinor).toBeNull()
  })

  test("valida el rango y los permisos", async () => {
    const s = await setUp(h)
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    const t = h.clock.now
    for (const path of ["results", "sales"]) {
      expect(
        (await h.call(`/api/reports/${path}?from=${t}&to=${t}`, { cookie: s.owner })).status,
      ).toBe(422)
      const huge = await h.call(`/api/reports/${path}?from=${t - 900 * DAY}&to=${t}`, {
        cookie: s.owner,
      })
      expect(huge.status).toBe(422)
      expect(await errorCode(huge)).toBe("INVALID_RANGE")
      expect((await h.call(`/api/reports/${path}?${WIDE()}`, { cookie: cashier })).status).toBe(403)
      expect((await h.call(`/api/reports/${path}`, { cookie: s.owner })).status).toBe(422)
    }
  })
})

describe("informe de ventas", () => {
  test("por día, producto con utilidad, método con comisión y vendedor", async () => {
    const s = await setUp(h)
    await stockUp(s.owner, s)
    const card = await method(s.owner, "Punto de venta")
    await h.call(`/api/payment-methods/${card.id}`, {
      cookie: s.owner,
      method: "PATCH",
      body: { commissionBp: 100 },
    })
    await h.call("/api/documents", { cookie: s.owner, body: saleBody(s.terminalId, s.methodUsd) })
    await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.terminalId, card.id, {
        payments: [
          {
            id: uuidv7(),
            paymentMethodId: card.id,
            currency: "VES",
            amountMinor: 10_950,
            rate: RATE,
            reference: "T-9",
          },
        ],
      }),
    })
    // El pan pasa a una categoría: el informe la toma de su producto
    h.db.insert(category).values({ id: "c1", name: "Panadería", position: 1 }).run()
    h.db.update(product).set({ categoryId: "c1" }).where(eq(product.id, "p1")).run()
    const r = await get<SalesReport>(s.owner, `/api/reports/sales?${WIDE()}`)
    expect(r.byCategory).toEqual([
      {
        categoryId: "c1",
        name: "Panadería",
        products: 1,
        totalLegalMinor: 21_900,
        costLegalMinor: 14_600,
        profitLegalMinor: 21_900 - 14_600,
      },
    ])
    expect(r.totals).toMatchObject({ count: 2, totalLegalMinor: 21_900, averageLegalMinor: 10_950 })
    expect(r.byDay).toHaveLength(1)
    expect(r.byDay[0]).toMatchObject({ count: 2, totalLegalMinor: 21_900 })
    expect(r.byProduct).toHaveLength(1)
    expect(r.byProduct[0]).toMatchObject({
      name: "Pan",
      sku: "PAN",
      qtyMilli: 4_000,
      totalLegalMinor: 21_900,
      costLegalMinor: 14_600,
    })
    expect(r.byProduct[0]?.profitLegalMinor).toBe(21_900 - 14_600)
    expect(r.byMethod).toEqual([
      { methodName: "Efectivo USD", currency: "USD", amountMinor: 300, commissionMinor: 0 },
      // 10.950 × 1 % = 109,5 → 110
      { methodName: "Punto de venta", currency: "VES", amountMinor: 10_950, commissionMinor: 110 },
    ])
    expect(r.byUser).toEqual([{ name: "Dueña", count: 2, totalLegalMinor: 21_900 }])
  })
})

describe("inventario valorado", () => {
  test("existencia por costo y por precio de venta, y sin costos no hay valor a costo", async () => {
    const s = await setUp(h)
    await stockUp(s.owner, s)
    await h.call("/api/documents", { cookie: s.owner, body: saleBody(s.terminalId, s.methodUsd) })
    const r = await get<InventoryReport>(s.owner, "/api/reports/inventory")
    expect(Number(r.rate)).toBe(36.5)
    expect(r.rows).toHaveLength(1)
    // 18 unidades: a costo 18 × 1,00 $ × 36,5 = 657,00 Bs; a precio 18 × 1,50 $ × 36,5 = 985,50 Bs
    expect(r.rows[0]).toMatchObject({
      name: "Pan",
      stockMilli: 18_000,
      costMinor: 100,
      costCurrency: "USD",
      valueLegalMinor: 65_700,
      retailLegalMinor: 98_550,
    })
    expect(r.totalValueLegalMinor).toBe(65_700)
    expect(r.totalRetailLegalMinor).toBe(98_550)
    expect(r.withoutCost).toBe(0)

    h.db
      .insert(role)
      .values({
        id: "stocker",
        name: "Solo existencias",
        permissions: ["inventory.view"],
        isSystem: false,
      })
      .run()
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Sara", username: "sara", password: "otra-clave-1", roleId: "stocker" },
    })
    const blind = await get<InventoryReport>(
      await h.login("sara", "otra-clave-1"),
      "/api/reports/inventory",
    )
    expect(blind.rows[0]).toMatchObject({
      stockMilli: 18_000,
      costMinor: null,
      valueLegalMinor: null,
    })
    expect(blind.totalValueLegalMinor).toBeNull()
    expect(blind.totalRetailLegalMinor).toBe(98_550)
  })
})

describe("libro de ventas y de compras", () => {
  test("cada documento con su base e IVA; las anulaciones restan y dicen qué anulan", async () => {
    const s = await setUp(h)
    expect((await stockUp(s.owner, s)).status).toBe(201)
    const sale = (await (
      await h.call("/api/documents", {
        cookie: s.owner,
        body: saleBody(s.terminalId, s.methodUsd),
      })
    ).json()) as PostedDocumentBody
    await h.call(`/api/documents/${sale.id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7(), reason: "Prueba" },
    })

    const sales = await get<TaxBook>(s.owner, `/api/reports/tax-book?kind=sales&${WIDE()}`)
    expect(sales.rates).toEqual([{ key: "taxed:1600", kind: "taxed", rateBp: 1600 }])
    expect(sales.rows).toHaveLength(2)
    const [original, reversal] = sales.rows
    expect(original).toMatchObject({ number: sale.number, voids: null, totalLegalMinor: 10_950 })
    expect(reversal).toMatchObject({ voids: sale.number, totalLegalMinor: -10_950 })
    expect(original?.groups[0]?.taxLegalMinor).toBeGreaterThan(0)
    expect(reversal?.groups[0]?.taxLegalMinor).toBe(-(original?.groups[0]?.taxLegalMinor ?? 0))
    expect(sales.totals).toEqual({
      totalLegalMinor: 0,
      surchargeLegalMinor: 0,
      groups: [{ key: "taxed:1600", baseLegalMinor: 0, taxLegalMinor: 0 }],
    })

    // La compra: 20 × 1,00 $ sin IVA incluido = 730 Bs de base y 116,80 Bs de IVA
    const purchases = await get<TaxBook>(s.owner, `/api/reports/tax-book?kind=purchases&${WIDE()}`)
    expect(purchases.rows).toHaveLength(1)
    expect(purchases.rows[0]).toMatchObject({
      type: "PURCHASE",
      totalLegalMinor: 84_680,
      groups: [{ key: "taxed:1600", baseLegalMinor: 73_000, taxLegalMinor: 11_680 }],
    })

    const res = await h.call(`/api/reports/tax-book?kind=otro&${WIDE()}`, { cookie: s.owner })
    expect(res.status).toBe(422)
  })
})
