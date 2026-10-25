import { describe, expect, test } from "bun:test"
import type { CatalogItem, TabLine } from "@millhiore/contracts"
import { addToDraft, chargeLines, elapsed, tabLabel } from "./tab"

const line = (over: Partial<TabLine>): TabLine => ({
  id: "l",
  variantId: "v1",
  name: "Arepa",
  qtyMilli: 1000,
  priceMinor: 300,
  priceCurrency: "USD",
  taxId: null,
  note: null,
  modifiers: [],
  kitchen: null,
  addedAt: 0,
  addedBy: null,
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
  documentId: null,
  documentNumber: null,
  ...over,
})

describe("cuentas", () => {
  test("el nombre de la cuenta", () => {
    expect(tabLabel({ tableName: "4", label: null, number: "CTA-1" })).toBe("Mesa 4")
    expect(tabLabel({ tableName: "Barra 2", label: null, number: "CTA-1" })).toBe("Barra 2")
    expect(tabLabel({ tableName: null, label: "Juan", number: "CTA-1" })).toBe("Juan")
    expect(elapsed(0, 45 * 60_000)).toBe("45 min")
    expect(elapsed(0, 130 * 60_000)).toBe("2 h 10 min")
  })

  test("se cobra lo pendiente, junto por producto y precio", () => {
    const lines = [
      line({ id: "a", qtyMilli: 2000, note: "sin queso" }),
      line({ id: "b", qtyMilli: 1000 }),
      line({ id: "c", variantId: "v2", name: "Jugo", priceMinor: 150 }),
      line({ id: "d", voidedAt: 1 }),
      line({ id: "e", documentId: "doc" }),
      // Se pidió antes de que subiera el precio: va aparte.
      line({ id: "f", priceMinor: 250 }),
    ]
    const all = chargeLines(lines)
    expect(all.lines.map((l) => [l.name, l.qtyMilli, l.priceMinor, l.fixedPrice])).toEqual([
      ["Arepa", 3000, 300, true],
      ["Jugo", 1000, 150, true],
      ["Arepa", 1000, 250, true],
    ])
    expect(all.refs.map((r) => r.lineId)).toEqual(["a", "b", "c", "f"])

    // Una parte: lo elegido, sin pasar de lo que hay.
    const part = chargeLines(lines, { a: 1000, c: 5000, d: 1000 })
    expect(part.refs).toEqual([
      { lineId: "a", qtyMilli: 1000 },
      { lineId: "c", qtyMilli: 1000 },
    ])
    expect(part.lines.map((l) => l.qtyMilli)).toEqual([1000, 1000])
  })

  test("al cobrar, lo que lleva opciones distintas va aparte", () => {
    const queso = { id: "q", name: "Queso", priceMinor: 100, priceCurrency: "USD" }
    const lines = [
      line({ id: "a", modifiers: [queso] }),
      line({ id: "b", modifiers: [queso] }),
      line({ id: "c" }),
    ]
    const { lines: ticket } = chargeLines(lines)
    expect(ticket.map((l) => [l.qtyMilli, l.modifiers?.map((m) => m.name) ?? []])).toEqual([
      [2000, ["Queso"]],
      [1000, []],
    ])
    expect(ticket[0]?.key).not.toBe(ticket[1]?.key)
  })

  test("el pedido suma al mismo producto sin indicaciones", () => {
    const item = {
      variantId: "v1",
      name: "Arepa",
      priceMinor: 300,
      priceCurrency: "USD",
      taxId: null,
    } as CatalogItem
    let draft = addToDraft([], item)
    draft = addToDraft(draft, item)
    expect(draft.map((l) => l.qtyMilli)).toEqual([2000])
    // Con indicaciones queda aparte: la próxima va en una línea nueva.
    draft = draft.map((l) => ({ ...l, note: "sin queso" }))
    draft = addToDraft(draft, item)
    expect(draft.map((l) => [l.qtyMilli, l.note])).toEqual([
      [2000, "sin queso"],
      [1000, null],
    ])
    expect(new Set(draft.map((l) => l.id)).size).toBe(2)
    // Con opciones, siempre aparte.
    const queso = { id: "q", name: "Queso", priceMinor: 100, priceCurrency: "USD" }
    draft = addToDraft(draft, item, { modifiers: [queso], note: null })
    draft = addToDraft(draft, item, { modifiers: [queso], note: null })
    expect(draft.map((l) => [l.qtyMilli, l.modifiers.length])).toEqual([
      [2000, 0],
      [1000, 0],
      [1000, 1],
      [1000, 1],
    ])
  })
})
