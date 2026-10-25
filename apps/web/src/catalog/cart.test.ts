import { describe, expect, test } from "bun:test"
import type { PlacedOrder, PublicCatalog } from "@millhiore/contracts"
import {
  addLine,
  type CartLine,
  itemCount,
  newOrderId,
  parseQty,
  priced,
  setLineQty,
  whatsappText,
} from "./cart"

const cafe: CartLine = {
  variantId: "v-cafe",
  name: "Café",
  unit: "unit",
  qtyMilli: 1000,
  note: null,
}
const queso: CartLine = {
  variantId: "v-queso",
  name: "Queso",
  unit: "kg",
  qtyMilli: 500,
  note: null,
}

const catalog = {
  currencies: "both",
  referenceCurrency: "USD",
  legalCurrency: "VES",
  products: [
    {
      id: "p1",
      name: "Café",
      variants: [
        {
          id: "v-cafe",
          optionValues: null,
          referenceMinor: 200,
          legalMinor: 7300,
          available: true,
        },
      ],
    },
    {
      id: "p2",
      name: "Queso",
      variants: [
        {
          id: "v-queso",
          optionValues: null,
          referenceMinor: 450,
          legalMinor: 16425,
          available: true,
        },
      ],
    },
  ],
} as unknown as PublicCatalog

describe("pedido del cliente", () => {
  test("agrega, suma lo mismo y separa lo que lleva otras indicaciones", () => {
    let lines = addLine([], cafe)
    lines = addLine(lines, cafe)
    expect(lines).toEqual([{ ...cafe, qtyMilli: 2000 }])
    lines = addLine(lines, { ...cafe, note: "sin azúcar" })
    expect(lines).toHaveLength(2)
    expect(setLineQty(lines, 0, 0)).toEqual([{ ...cafe, note: "sin azúcar" }])
    expect(itemCount([...lines, queso])).toBe(4)
  })

  test("los precios son los del catálogo de ahora; lo que ya no está se cae", () => {
    const p = priced([{ ...cafe, qtyMilli: 2000 }, queso, { ...cafe, variantId: "ya-no" }], catalog)
    expect(p.lines.map((l) => l.variantId)).toEqual(["v-cafe", "v-queso"])
    expect(p.reference).toBe(400 + 225)
    expect(p.legal).toBe(14600 + 8213)
  })

  test("cantidades escritas con coma o punto", () => {
    expect(parseQty("1,5")).toBe(1500)
    expect(parseQty("0.250")).toBe(250)
    expect(parseQty("0")).toBeNull()
    expect(parseQty("abc")).toBeNull()
    expect(parseQty("1,2345")).toBeNull()
  })

  test("el mensaje de WhatsApp lleva el número, las líneas, el total y la entrega", () => {
    const order: PlacedOrder = {
      id: "o1",
      number: "P-000012",
      lines: [
        { ...cafe, qtyMilli: 2000, referenceMinor: 200, legalMinor: 7300, note: "sin azúcar" },
        { ...queso, referenceMinor: 450, legalMinor: 16425 },
      ],
      totalReferenceMinor: 625,
      totalLegalMinor: 22813,
      referenceCurrency: "USD",
      legalCurrency: "VES",
    }
    const text = whatsappText(order, {
      name: " Ana ",
      phone: "0414-1112233",
      delivery: "delivery",
      address: "Calle 5, Maracay",
      payment: "Pago móvil",
      note: "",
    })
    expect(text).toBe(
      [
        "Hola, quiero hacer este pedido (P-000012):",
        "• 2 × Café: $ 4,00",
        "   (sin azúcar)",
        "• 0,500 kg × Queso: $ 2,25",
        "Total: $ 6,25 (Bs 228,13)",
        "A nombre de: Ana · 0414-1112233",
        "Delivery a: Calle 5, Maracay",
        "Pago: Pago móvil",
      ].join("\n"),
    )
  })

  test("un id distinto en cada pedido", () => {
    const a = newOrderId()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(newOrderId()).not.toBe(a)
  })
})
