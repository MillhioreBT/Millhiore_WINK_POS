import { beforeEach, describe, expect, test } from "bun:test"
import type {
  Bootstrap,
  CatalogItem,
  DocumentDetail,
  ModifierGroup,
  TabDetail,
} from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"

let h: Harness
let ctx: Awaited<ReturnType<typeof setUp>>
beforeEach(async () => {
  h = harness()
  ctx = await setUp(h)
})

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error

async function group(body: Record<string, unknown>, id?: string) {
  const res = await h.call(id ? `/api/modifier-groups/${id}` : "/api/modifier-groups", {
    method: id ? "PUT" : "POST",
    cookie: ctx.owner,
    body,
  })
  expect(res.status).toBe(id ? 200 : 201)
  return (await res.json()) as ModifierGroup
}

/** Hamburguesa de 5 $ con «Término» (una, obligatoria) y «Extras» (queso 1 $, tocineta 1,50 $). */
async function burger() {
  const termino = await group({
    name: "Término",
    minSelect: 1,
    maxSelect: 1,
    modifiers: [{ name: "Tres cuartos" }, { name: "Bien cocida" }],
  })
  const extras = await group({
    name: "Extras",
    maxSelect: 2,
    modifiers: [
      { name: "Queso", priceMinor: 100, priceCurrency: "USD" },
      { name: "Tocineta", priceMinor: 150, priceCurrency: "USD" },
      { name: "Huevo", priceMinor: 80, priceCurrency: "USD" },
    ],
  })
  const res = await h.call("/api/products", {
    cookie: ctx.owner,
    body: {
      name: "Hamburguesa",
      kind: "service",
      priceMinor: 500,
      priceCurrency: "USD",
      modifierGroupIds: [termino.id, extras.id],
    },
  })
  expect(res.status).toBe(201)
  const item = (await res.json()) as CatalogItem
  const id = (g: ModifierGroup, name: string) => g.modifiers.find((m) => m.name === name)?.id ?? ""
  return { item, termino, extras, id }
}

const sell = (variantId: string, modifierIds: string[], unitPriceMinor: number, over = {}) =>
  h.call("/api/documents", {
    cookie: ctx.owner,
    body: saleBody(ctx.terminalId, ctx.methodUsd, {
      lines: [{ variantId, qtyMilli: 1000, unitPriceMinor, modifierIds, ...over }],
      payments: [
        {
          id: uuidv7(),
          paymentMethodId: ctx.methodUsd,
          currency: "USD",
          amountMinor: unitPriceMinor,
        },
      ],
    }),
  })

describe("opciones y extras", () => {
  test("los grupos se ofrecen con el producto y llegan a la caja", async () => {
    const { item, termino, extras } = await burger()
    expect(item.modifierGroupIds).toEqual([termino.id, extras.id])
    const groups = (await (
      await h.call("/api/modifier-groups", { cookie: ctx.owner })
    ).json()) as ModifierGroup[]
    expect(groups.find((g) => g.id === extras.id)).toMatchObject({
      minSelect: 0,
      maxSelect: 2,
      productCount: 1,
    })
    const boot = (await (await h.call("/api/bootstrap", { cookie: ctx.owner })).json()) as Bootstrap
    expect(boot.modifierGroups.map((g) => [g.name, g.modifiers.length])).toEqual([
      ["Término", 2],
      ["Extras", 3],
    ])
    // Se quitan desde el producto.
    const res = await h.call(`/api/products/${item.productId}`, {
      method: "PATCH",
      cookie: ctx.owner,
      body: { modifierGroupIds: [extras.id] },
    })
    expect(((await res.json()) as CatalogItem).modifierGroupIds).toEqual([extras.id])
    // Un grupo que no existe, no.
    const bad = await h.call(`/api/products/${item.productId}`, {
      method: "PATCH",
      cookie: ctx.owner,
      body: { modifierGroupIds: ["nope"] },
    })
    expect(bad.status).toBe(422)
  })

  test("la venta guarda lo elegido y verifica obligatorias, máximos y que sean del producto", async () => {
    const { item, id, termino, extras } = await burger()
    // Falta el término (obligatorio).
    const missing = await sell(item.variantId, [id(extras, "Queso")], 600)
    expect(missing.status).toBe(422)
    expect((await errorOf(missing)).message).toContain("Término")
    // Más extras de los permitidos.
    const tooMany = await sell(
      item.variantId,
      [
        id(termino, "Bien cocida"),
        id(extras, "Queso"),
        id(extras, "Tocineta"),
        id(extras, "Huevo"),
      ],
      830,
    )
    expect(tooMany.status).toBe(422)
    // Una opción de otro producto: el pan no tiene grupos.
    expect((await sell("v1", [id(extras, "Queso")], 250)).status).toBe(422)

    const ok = await sell(item.variantId, [id(termino, "Bien cocida"), id(extras, "Queso")], 600, {
      note: "sin cebolla",
    })
    expect(ok.status).toBe(201)
    const sale = (await ok.json()) as { id: string }
    const doc = (await (
      await h.call(`/api/documents/${sale.id}`, { cookie: ctx.owner })
    ).json()) as DocumentDetail
    expect(doc.lines[0]?.modifiers.map((m) => [m.name, m.priceMinor])).toEqual([
      ["Bien cocida", 0],
      ["Queso", 100],
    ])
    expect(doc.lines[0]?.note).toBe("sin cebolla")

    // Se quita «Queso» del grupo: deja de venderse, pero la venta conserva su nombre.
    await group(
      {
        name: "Extras",
        maxSelect: 2,
        modifiers: extras.modifiers
          .filter((m) => m.name !== "Queso")
          .map((m) => ({
            id: m.id,
            name: m.name,
            priceMinor: m.priceMinor,
            priceCurrency: m.priceCurrency,
          })),
      },
      extras.id,
    )
    expect(
      (await sell(item.variantId, [id(termino, "Bien cocida"), id(extras, "Queso")], 600)).status,
    ).toBe(422)
    const again = (await (
      await h.call(`/api/documents/${sale.id}`, { cookie: ctx.owner })
    ).json()) as DocumentDetail
    expect(again.lines[0]?.modifiers[1]?.name).toBe("Queso")

    // Solo una venta lleva opciones.
    const purchase = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: {
        id: uuidv7(),
        type: "PURCHASE",
        terminalId: ctx.terminalId,
        currency: "USD",
        rate: { base: "USD", quote: "VES", value: "36.5" },
        pricesIncludeTax: true,
        lines: [
          {
            variantId: "v1",
            qtyMilli: 1000,
            unitPriceMinor: 100,
            modifierIds: [id(termino, "Bien cocida")],
          },
        ],
        payments: [],
      },
    })
    expect(purchase.status).toBe(422)
  })

  test("en la cuenta de una mesa se congelan y se cobran aunque después cambien", async () => {
    const { item, id, termino, extras } = await burger()
    const tab = (await (
      await h.call("/api/tabs", { cookie: ctx.owner, body: { id: uuidv7(), label: "Barra" } })
    ).json()) as TabDetail
    const sinTermino = await h.call(`/api/tabs/${tab.id}/lines`, {
      cookie: ctx.owner,
      body: { lines: [{ id: uuidv7(), variantId: item.variantId, qtyMilli: 1000 }] },
    })
    expect(sinTermino.status).toBe(422)
    const res = await h.call(`/api/tabs/${tab.id}/lines`, {
      cookie: ctx.owner,
      body: {
        lines: [
          {
            id: uuidv7(),
            variantId: item.variantId,
            qtyMilli: 2000,
            modifierIds: [id(termino, "Tres cuartos"), id(extras, "Tocineta")],
          },
        ],
      },
    })
    expect(res.status).toBe(200)
    const t = (await res.json()) as TabDetail
    expect(t.lines[0]?.modifiers.map((m) => m.name)).toEqual(["Tres cuartos", "Tocineta"])
    // Dos hamburguesas de 5 $ con tocineta de 1,50 $.
    expect(t.pending).toEqual([{ currency: "USD", amountMinor: 1300 }])

    // La tocineta deja de ofrecerse; lo pedido se cobra igual.
    await group(
      {
        name: "Extras",
        modifiers: [
          { id: id(extras, "Queso"), name: "Queso", priceMinor: 100, priceCurrency: "USD" },
        ],
      },
      extras.id,
    )
    const line = t.lines[0]
    if (!line) throw new Error("no pidió")
    const sale = await h.call("/api/documents", {
      cookie: ctx.owner,
      body: saleBody(ctx.terminalId, ctx.methodUsd, {
        lines: [
          {
            variantId: item.variantId,
            qtyMilli: 2000,
            unitPriceMinor: 650,
            modifierIds: line.modifiers.map((m) => m.id),
          },
        ],
        payments: [
          { id: uuidv7(), paymentMethodId: ctx.methodUsd, currency: "USD", amountMinor: 1300 },
        ],
        tab: { id: tab.id, lines: [{ lineId: line.id, qtyMilli: 2000 }] },
      }),
    })
    expect(sale.status).toBe(201)
  })

  test("los arma quien maneja el catálogo", async () => {
    const created = await h.call("/api/users", {
      cookie: ctx.owner,
      body: { name: "Caja", username: "caja", password: "otra-clave-1", roleId: "cashier" },
    })
    expect(created.status).toBe(201)
    const cashier = await h.login("caja", "otra-clave-1")
    const res = await h.call("/api/modifier-groups", {
      cookie: cashier,
      body: { name: "Extras", modifiers: [{ name: "Queso" }] },
    })
    expect(res.status).toBe(403)
    const bad = await h.call("/api/modifier-groups", {
      cookie: ctx.owner,
      body: {
        name: "Término",
        minSelect: 2,
        maxSelect: 1,
        modifiers: [{ name: "A" }, { name: "B" }],
      },
    })
    expect(bad.status).toBe(422)
    const noCurrency = await h.call("/api/modifier-groups", {
      cookie: ctx.owner,
      body: { name: "Extras", modifiers: [{ name: "Queso", priceMinor: 100 }] },
    })
    expect(noCurrency.status).toBe(422)
  })
})
