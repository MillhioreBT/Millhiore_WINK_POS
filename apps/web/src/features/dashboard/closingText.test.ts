import { describe, expect, test } from "bun:test"
import type { DaySummary, Payables, Receivables } from "@millhiore/contracts"
import { closingText } from "./closingText"

const day: DaySummary = {
  date: "2026-10-15",
  from: Date.UTC(2026, 9, 15, 4),
  to: Date.UTC(2026, 9, 16, 4),
  legalCurrency: "VES",
  referenceCurrency: "USD",
  sales: {
    count: 5,
    voided: 1,
    totalLegalMinor: 123456,
    taxLegalMinor: 17024,
    surchargeLegalMinor: 3000,
    discountLegalMinor: 2500,
    returnsLegalMinor: 1825,
    creditLegalMinor: 40000,
    totalReferenceMinor: 3380,
  },
  previous: {
    count: 0,
    voided: 0,
    totalLegalMinor: 0,
    taxLegalMinor: 0,
    surchargeLegalMinor: 0,
    discountLegalMinor: 0,
    returnsLegalMinor: 0,
    creditLegalMinor: 0,
    totalReferenceMinor: 0,
  },
  byMethod: [
    {
      methodId: "m1",
      methodName: "Efectivo USD",
      currency: "USD",
      amountMinor: 1000,
      commissionMinor: 0,
    },
    {
      methodId: "m2",
      methodName: "Pago móvil",
      currency: "VES",
      amountMinor: 50000,
      commissionMinor: 1000,
    },
  ],
  byHour: [],
  topProducts: [
    { variantId: "v1", name: "Refresco 2 L", qtyMilli: 4000, totalLegalMinor: 36500 },
    { variantId: "v2", name: "Agua", qtyMilli: 2500, totalLegalMinor: 10000 },
  ],
  purchases: { count: 1, totalLegalMinor: 80000 },
  expenses: { count: 2, totalLegalMinor: 15000 },
  collections: { count: 2, totalLegalMinor: 9000 },
  inventoryLossLegalMinor: 4500,
  expiry: null,
  openShifts: [{ id: "s1", terminalName: "Caja 1", openedAt: 1, openedBy: "Ana" }],
  lowStock: [
    { productId: "p", variantId: "v", name: "Harina", stockMilli: 1000, minStockMilli: 5000 },
  ],
}

const owed: Receivables = {
  customers: [],
  totals: [
    {
      currency: "USD",
      outstandingMinor: 1250,
      overdueMinor: 300,
      customers: 2,
      aging: { current: 950, d1_30: 300, d31_60: 0, d61_90: 0, d90plus: 0 },
    },
  ],
}

const owing: Payables = {
  suppliers: [],
  totals: [
    {
      currency: "USD",
      outstandingMinor: 4000,
      overdueMinor: 1500,
      suppliers: 2,
      aging: { current: 2500, d1_30: 1500, d31_60: 0, d61_90: 0, d90plus: 0 },
    },
  ],
}

describe("cierre del día para WhatsApp", () => {
  test("lleva las cifras del día con negritas de WhatsApp", () => {
    const text = closingText(day, { name: "Bodega La Esquina" }, owed, owing)
    for (const expected of [
      "*Bodega La Esquina*",
      "Cierre del día · Jueves, 15 de octubre",
      "*VENTAS*",
      "Ventas: 4 (1 anulada)",
      "Total vendido: Bs 1.234,56 (≈ $ 33,80)",
      "Promedio por venta: Bs 308,64",
      "IVA: Bs 170,24",
      "IGTF: Bs 30,00",
      "Devoluciones: Bs 18,25",
      "Descuentos dados: Bs 25,00",
      "Vendido a crédito: Bs 400,00",
      "• Efectivo USD: $ 10,00",
      "• Pago móvil: Bs 500,00 (comisión Bs 10,00)",
      "Incluye 2 abonos de clientes (Bs 90,00)",
      "1 factura de proveedor: Bs 800,00",
      "1. Refresco 2 L × 4",
      "2. Agua × 2,5",
      "*POR COBRAR (FIADO)*",
      "$ 12,50 · 2 clientes · $ 3,00 vencido",
      "*POR PAGAR (PROVEEDORES)*",
      "$ 40,00 · 2 proveedores · $ 15,00 vencido",
      "*GASTOS*",
      "Pérdidas de inventario: Bs 45,00",
      "• Harina: 1",
      "Cajas abiertas: Caja 1",
    ]) {
      expect(text).toContain(expected)
    }
  })

  test("omite lo que no tiene datos", () => {
    const quiet: DaySummary = {
      ...day,
      sales: {
        ...day.sales,
        count: 0,
        voided: 0,
        totalLegalMinor: 0,
        taxLegalMinor: 0,
        surchargeLegalMinor: 0,
        discountLegalMinor: 0,
        returnsLegalMinor: 0,
        creditLegalMinor: 0,
        totalReferenceMinor: 0,
      },
      byMethod: [],
      topProducts: [],
      purchases: { count: 0, totalLegalMinor: 0 },
      expenses: { count: 0, totalLegalMinor: 0 },
      collections: { count: 0, totalLegalMinor: 0 },
      inventoryLossLegalMinor: null,
      openShifts: [],
      lowStock: [],
    }
    const text = closingText(quiet, { name: "Bodega" }, null)
    expect(text).toContain("Ventas: 0")
    for (const absent of [
      "Promedio",
      "IVA",
      "IGTF",
      "Descuentos",
      "Devoluciones",
      "crédito",
      "COBRADO",
      "COMPRAS",
      "MÁS VENDIDO",
      "POR COBRAR",
      "POR PAGAR",
      "GASTOS",
      "Pérdidas",
      "POR REPONER",
      "Cajas abiertas",
    ]) {
      expect(text).not.toContain(absent)
    }
  })

  test("sin permiso para ver el fiado no sale esa parte", () => {
    expect(closingText(day, { name: "B" }, null)).not.toContain("POR COBRAR")
  })
})
