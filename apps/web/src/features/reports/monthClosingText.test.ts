import { describe, expect, test } from "bun:test"
import type { ResultsReport, SalesReport } from "@millhiore/contracts"
import { monthClosingText, monthLabel } from "./monthClosingText"

const results = (over: Partial<ResultsReport> = {}): ResultsReport => ({
  from: 0,
  to: 1,
  legalCurrency: "VES",
  sales: {
    count: 120,
    totalLegalMinor: 1_160_000,
    taxLegalMinor: 160_000,
    netLegalMinor: 1_000_000,
    discountLegalMinor: 0,
    surchargeLegalMinor: 3_000,
  },
  costOfGoodsLegalMinor: 600_000,
  linesWithoutCost: 0,
  grossProfitLegalMinor: 400_000,
  grossMarginBp: 4000,
  expenses: { count: 3, totalLegalMinor: 100_000, byCategory: [] },
  inventoryLossLegalMinor: 5_000,
  commissionsLegalMinor: 2_000,
  netProfitLegalMinor: 293_000,
  purchases: { count: 2, totalLegalMinor: 500_000 },
  ...over,
})

const sales: SalesReport = {
  from: 0,
  to: 1,
  legalCurrency: "VES",
  totals: {
    count: 120,
    totalLegalMinor: 1_160_000,
    netLegalMinor: 1_000_000,
    taxLegalMinor: 160_000,
    discountLegalMinor: 0,
    returnsLegalMinor: 0,
    averageLegalMinor: 9_667,
  },
  byDay: [],
  byProduct: [
    {
      variantId: "v",
      name: "Harina",
      sku: "H",
      qtyMilli: 50_000,
      totalLegalMinor: 600_000,
      costLegalMinor: null,
      profitLegalMinor: null,
    },
  ],
  byCategory: [
    {
      categoryId: "c1",
      name: "Víveres",
      products: 3,
      totalLegalMinor: 900_000,
      costLegalMinor: null,
      profitLegalMinor: null,
    },
    {
      categoryId: null,
      name: "Sin categoría",
      products: 1,
      totalLegalMinor: 260_000,
      costLegalMinor: null,
      profitLegalMinor: null,
    },
  ],
  byMethod: [],
  byUser: [],
}

describe("cierre del mes", () => {
  test("el nombre del mes dice si todavía no terminó", () => {
    expect(monthLabel({ from: "2026-10-01", to: "2026-10-24" })).toBe(
      "Octubre de 2026 (hasta el 24)",
    )
    expect(monthLabel({ from: "2026-09-01", to: "2026-09-30" })).toBe("Septiembre de 2026")
  })

  test("ventas y utilidad contra el mes anterior, categorías, lo más vendido y deudas", () => {
    const text = monthClosingText({
      business: "Bodega",
      label: "Septiembre de 2026",
      results: results(),
      previous: results({
        sales: { ...results().sales, count: 100, totalLegalMinor: 1_000_000 },
        netProfitLegalMinor: 300_000,
      }),
      sales,
      owed: {
        customers: [],
        totals: [
          {
            currency: "USD",
            outstandingMinor: 1_250,
            overdueMinor: 0,
            customers: 2,
            aging: { current: 1_250, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 },
          },
        ],
      },
      owing: null,
    })
    for (const expected of [
      "*Bodega*",
      "Cierre del mes · Septiembre de 2026",
      "Ventas: 120 (▲ 20 % contra el mes anterior)",
      "Total vendido: Bs 11.600,00 (▲ 16 % contra el mes anterior)",
      "Utilidad bruta: Bs 4.000,00 (margen 40 %)",
      "Pérdidas de inventario: Bs 50,00",
      "*Utilidad neta: Bs 2.930,00 (▼ 2,3 % contra el mes anterior)*",
      "1. Víveres: Bs 9.000,00",
      "1. Harina × 50",
      "*POR COBRAR (FIADO)*",
    ]) {
      expect(text).toContain(expected)
    }
  })

  test("sin costos no sale la utilidad", () => {
    const text = monthClosingText({
      business: "B",
      label: "x",
      results: results({
        costOfGoodsLegalMinor: null,
        grossProfitLegalMinor: null,
        grossMarginBp: null,
        inventoryLossLegalMinor: null,
        netProfitLegalMinor: null,
      }),
      previous: null,
      sales,
      owed: null,
      owing: null,
    })
    expect(text).not.toContain("Utilidad")
    expect(text).toContain("*GASTOS*")
    expect(text).not.toContain("contra el mes anterior")
  })
})
