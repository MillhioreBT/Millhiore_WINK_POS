import { describe, expect, test } from "bun:test"
import type { DocumentDetail } from "@millhiore/contracts"
import {
  COLUMNS,
  columns,
  encodePc850,
  receiptLines,
  testPageLines,
  toEscPos,
  toPlainText,
  wrap,
} from "./index"

const business = {
  name: "Bodega La Esquina",
  taxId: "J-12345678-9",
  address: "Av. Bolívar, local 3, Valencia, estado Carabobo",
  phone: "0241-5550000",
  receiptFooter: null,
  timezone: "America/Caracas",
}

const sale: DocumentDetail = {
  id: "d1",
  type: "SALE",
  number: "C1-000001",
  postedAt: Date.UTC(2026, 9, 15, 1, 24), // 14/10 9:24 p. m. en Caracas
  currency: "VES",
  legalCurrency: "VES",
  totalMinor: 309022,
  totalLegalMinor: 309022,
  surchargeMinor: 6271,
  surchargeLegalMinor: 6271,
  reversesDocumentId: null,
  reversedBy: null,
  createdBy: "Dueña Prueba",
  contactId: "c1",
  contactName: "María Pérez",
  contactTaxId: "V-12345678",
  externalRef: null,
  note: null,
  discountMinor: 0,
  discountLegalMinor: 0,
  returnsDocumentId: null,
  returnsNumber: null,
  expenseCategoryId: null,
  expenseCategoryName: null,
  stockReasonId: null,
  stockReasonName: null,
  creditMinor: 0,
  creditCurrency: null,
  dueAt: null,
  terminalName: "Caja 1",
  locationId: "l",
  locationName: "Tienda",
  toLocationId: null,
  toLocationName: null,
  discountCode: null,
  allocations: [],
  charges: [],
  rate: { base: "USD", quote: "VES", value: "877.90230000" },
  pricesIncludeTax: true,
  lines: [
    {
      lineNo: 1,
      variantId: "v1",
      name: "Agua mineral 1,5 L",
      qtyMilli: 2000,
      unitPriceMinor: 101837,
      discountMinor: 0,
      lineTotalMinor: 203674,
      taxId: "G",
      taxRateBp: 1600,
      lots: [],
    },
    {
      lineNo: 2,
      variantId: "v2",
      name: "Harina PAN de maíz blanco precocida 1 kg (paquete)",
      qtyMilli: 1000,
      unitPriceMinor: 105348,
      discountMinor: 0,
      lineTotalMinor: 105348,
      taxId: "E",
      taxRateBp: 0,
      lots: [],
    },
  ],
  payments: [
    {
      id: "p1",
      paymentMethodId: "m1",
      methodName: "Pago móvil",
      currency: "VES",
      amountMinor: 100000,
      reference: "4821",
      surchargeId: null,
    },
    {
      id: "p2",
      paymentMethodId: "m2",
      methodName: "Efectivo USD",
      currency: "USD",
      amountMinor: 500,
      reference: null,
      surchargeId: "IGTF",
    },
    {
      id: "p3",
      paymentMethodId: "m3",
      methodName: "Efectivo VES",
      currency: "VES",
      amountMinor: -223658,
      reference: null,
      surchargeId: null,
    },
  ],
  taxes: [
    {
      taxId: "G",
      kind: "taxed",
      rateBp: 1600,
      baseMinor: 175581,
      taxMinor: 28093,
      baseLegalMinor: 175581,
      taxLegalMinor: 28093,
    },
    {
      taxId: "E",
      kind: "exempt",
      rateBp: 0,
      baseMinor: 105348,
      taxMinor: 0,
      baseLegalMinor: 105348,
      taxLegalMinor: 0,
    },
  ],
  surcharges: [
    {
      surchargeId: "IGTF",
      rateBp: 300,
      baseMinor: 209022,
      amountMinor: 6271,
      baseLegalMinor: 209022,
      amountLegalMinor: 6271,
    },
  ],
} as DocumentDetail

describe("texto", () => {
  test("PC850 lleva los acentos del español y aproxima lo demás", () => {
    expect(encodePc850("Año ¿ñ?")).toEqual([0x41, 0xa4, 0x6f, 0x20, 0xa8, 0xa4, 0x3f])
    expect(encodePc850("ÁÉÍÓÚ")).toEqual([0xb5, 0x90, 0xd6, 0xe0, 0xe9])
    expect(encodePc850("—≈")).toEqual([0x2d, 0x7e])
    expect(encodePc850("ő")).toEqual([0x6f]) // sin acento antes que «?»
    expect(encodePc850("😀")).toEqual([0x3f])
  })

  test("ajuste de líneas y columnas", () => {
    expect(wrap("uno dos tres cuatro", 9)).toEqual(["uno dos", "tres", "cuatro"])
    expect(wrap("supercalifragilístico", 8)).toEqual(["supercal", "ifragilí", "stico"])
    expect(columns("TOTAL", "Bs 10,00", 20)).toEqual(["TOTAL       Bs 10,00"])
    const long = columns("Un texto muy largo a la izquierda", "Bs 1.000,00", 24)
    expect(long.at(-1)?.endsWith("Bs 1.000,00")).toBe(true)
    for (const l of long) expect(l.length).toBeLessThanOrEqual(24)
  })
})

describe("recibo", () => {
  for (const paper of [58, 80] as const) {
    test(`a ${paper} mm ninguna línea pasa de ${COLUMNS[paper]} columnas`, () => {
      const width = COLUMNS[paper]
      const lines = receiptLines(sale, business, width)
      for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(width)
    })
  }

  test("lleva encabezado, renglones, IVA, IGTF, referencia y pagos", () => {
    const text = toPlainText(receiptLines(sale, business, 48), 48)
    for (const expected of [
      "Bodega La Esquina",
      "RIF J-12345678-9",
      "NOTA DE VENTA · NO FISCAL",
      "C1-000001 · 14/10/26, 9:24 p. m.",
      "Cliente: María Pérez · V-12345678",
      "Harina PAN de maíz blanco precocida 1 kg\n(paquete) (E)",
      "2 × Bs 1.018,37",
      "Base imponible 16 %",
      "IVA 16 %",
      "Exento (E)",
      "IGTF 3 % s/ Bs 2.090,22",
      "Tasa BCV 877,9023 · Ref. $ 3,59",
      "Vuelto (Efectivo VES)",
      "¡Gracias por su compra!",
    ]) {
      expect(text).toContain(expected)
    }
    expect(text).toMatch(/TOTAL A PAGAR\s+Bs 3\.152,93/)
  })

  test("una venta fiada dice cuánto queda a deber y hasta cuándo", () => {
    const credit: DocumentDetail = {
      ...sale,
      creditMinor: 250,
      creditCurrency: "USD",
      dueAt: Date.UTC(2026, 9, 22, 16),
    }
    const text = toPlainText(receiptLines(credit, business, 48), 48)
    expect(text).toMatch(/A CRÉDITO \(DEBE\)\s+\$ 2,50/)
    expect(text).toContain("Pagar antes del 22/10/26")
    expect(toPlainText(receiptLines(sale, business, 48), 48)).not.toContain("CRÉDITO")
  })

  test("una línea con descuento muestra el importe de lista y lo descontado", () => {
    const first = sale.lines[0]
    if (!first) throw new Error("el fixture no tiene líneas")
    const discounted: DocumentDetail = {
      ...sale,
      lines: [{ ...first, discountMinor: 20000, lineTotalMinor: first.lineTotalMinor - 20000 }],
    }
    const text = toPlainText(receiptLines(discounted, business, 48), 48)
    expect(text).toMatch(/2 × Bs 1\.018,37\s+Bs 2\.036,74/)
    expect(text).toMatch(/Descuento\s+-Bs 200,00/)
    expect(toPlainText(receiptLines(sale, business, 48), 48)).not.toContain("Descuento")
  })

  test("los recargos de la venta salen después de los productos", () => {
    const withCharges: DocumentDetail = {
      ...sale,
      charges: [
        {
          chargeId: "delivery",
          name: "Delivery",
          kind: "fixed",
          rateBp: 0,
          baseMinor: 0,
          amountMinor: 175580,
          amountLegalMinor: 175580,
          taxId: null,
          taxRateBp: 0,
        },
        {
          chargeId: "servicio",
          name: "Servicio",
          kind: "percent",
          rateBp: 1000,
          baseMinor: 175582,
          amountMinor: 17558,
          amountLegalMinor: 17558,
          taxId: "exento",
          taxRateBp: 0,
        },
      ],
    }
    const text = toPlainText(receiptLines(withCharges, business, 48), 48)
    expect(text).toMatch(/Delivery\s+Bs 1\.755,80/)
    expect(text).toMatch(/Servicio 10 % \(E\)\s+Bs 175,58/)
    expect(text.indexOf("Delivery")).toBeGreaterThan(text.indexOf("Agua mineral"))
    // Con IVA, lo que no lo lleva sale aparte como no sujeto para que el desglose sume el total.
    const noVat: DocumentDetail = {
      ...withCharges,
      taxes: [
        ...sale.taxes,
        {
          taxId: null,
          kind: "not_subject",
          rateBp: 0,
          baseMinor: 175580,
          taxMinor: 0,
          baseLegalMinor: 175580,
          taxLegalMinor: 0,
        },
      ],
    }
    expect(toPlainText(receiptLines(noVat, business, 48), 48)).toMatch(/No sujeto {2,}Bs 1\.755,80/)
  })

  test("el recibo de un abono lista las ventas que paga", () => {
    const abono: DocumentDetail = {
      ...sale,
      type: "PAYMENT_IN",
      number: "C1-AB-000001",
      currency: "USD",
      totalMinor: 300,
      surchargeMinor: 0,
      lines: [],
      taxes: [],
      surcharges: [],
      rate: null,
      allocations: [
        { saleDocumentId: "s1", saleNumber: "C1-000007", amountMinor: 200 },
        { saleDocumentId: "s2", saleNumber: "C1-000009", amountMinor: 100 },
      ],
    }
    const text = toPlainText(receiptLines(abono, business, 48), 48)
    expect(text).toContain("RECIBO DE ABONO · NO FISCAL")
    expect(text).toContain("Abono a:")
    expect(text).toMatch(/C1-000007\s+\$ 2,00/)
    expect(text).toMatch(/ABONO\s+\$ 3,00/)
    expect(text).toContain("¡Gracias por su compra!")
  })

  test("un traslado dice de dónde a dónde y las cantidades, sin precios", () => {
    const traslado: DocumentDetail = {
      ...sale,
      type: "STOCK_TRANSFER",
      number: "C1-TL-000001",
      totalMinor: 0,
      surchargeMinor: 0,
      contactName: null,
      locationName: "Depósito",
      toLocationName: "Tienda",
      lines: (sale.lines ?? []).map((l) => ({ ...l, unitPriceMinor: 0, lineTotalMinor: 0 })),
      payments: [],
      taxes: [],
      surcharges: [],
    }
    const text = toPlainText(receiptLines(traslado, business, 48), 48)
    expect(text).toContain("TRASLADO DE INVENTARIO")
    expect(text).toContain("De: Depósito")
    expect(text).toContain("A: Tienda")
    expect(text).toMatch(/UNIDADES\s+3/)
    expect(text).not.toContain("Bs")
    expect(text).not.toContain("¡Gracias por su compra!")
    // El reverso devuelve la mercancía: de la tienda al depósito.
    const back = toPlainText(
      receiptLines({ ...traslado, reversesDocumentId: "d1" }, business, 48),
      48,
    )
    expect(back).toContain("De: Tienda")
    expect(back).toContain("ANULACIÓN")
  })

  test("el mensaje del pie es el del negocio", () => {
    const text = toPlainText(
      receiptLines(sale, { ...business, receiptFooter: "Vuelva pronto" }, 32),
      32,
    )
    expect(text).toContain("Vuelva pronto")
    expect(text).not.toContain("Gracias")
  })

  test("ESC/POS: inicializa, abre la gaveta si se pide y corta al final", () => {
    const lines = testPageLines(business, 48, Date.UTC(2026, 9, 15, 12))
    const bytes = toEscPos(lines, { openDrawer: true })
    expect([...bytes.slice(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 2])
    expect([...bytes.slice(5, 10)]).toEqual([0x1b, 0x70, 0, 25, 250])
    expect([...bytes.slice(-4)]).toEqual([0x1d, 0x56, 66, 3])
    const plain = toEscPos(lines)
    expect([...plain.slice(5, 7)]).not.toEqual([0x1b, 0x70])
  })
})
