import { beforeEach, describe, expect, test } from "bun:test"
import type { CatalogItem, ProductDetail } from "@millhiore/contracts"
import { auditLog } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const camisa = {
  name: "Camisa",
  priceMinor: 1500,
  priceCurrency: "USD",
  options: [
    { name: "Talla", values: ["S", "M"] },
    { name: "Color", values: ["Azul", "Negro"] },
  ],
}

async function create(cookie: string, body: Record<string, unknown>) {
  const res = await h.call("/api/products", { cookie, body })
  expect(res.status).toBe(201)
  return (await res.json()) as CatalogItem
}

async function detail(cookie: string, id: string) {
  return (await (await h.call(`/api/products/${id}`, { cookie })).json()) as ProductDetail
}

async function items(cookie: string, query = "") {
  return (await (await h.call(`/api/products${query}`, { cookie })).json()) as CatalogItem[]
}

async function patch(cookie: string, id: string, body: Record<string, unknown>) {
  return h.call(`/api/products/${id}`, { method: "PATCH", cookie, body })
}

const sell = (terminalId: string, methodUsd: string, variantId: string, priceMinor: number) =>
  saleBody(terminalId, methodUsd, {
    lines: [{ variantId, qtyMilli: 1000, unitPriceMinor: priceMinor }],
    payments: [
      {
        id: uuidv7(),
        paymentMethodId: methodUsd,
        currency: "USD",
        amountMinor: priceMinor,
      },
    ],
  })

describe("tallas y colores", () => {
  test("crea una variante por combinación, en el orden de la cuadrícula y con su SKU", async () => {
    const { owner } = await setUp(h)
    const first = await create(owner, camisa)
    expect(first).toMatchObject({
      name: "Camisa (S, Azul)",
      productName: "Camisa",
      optionValues: ["S", "Azul"],
      options: camisa.options,
      active: true,
    })
    const list = await items(owner, "?search=camisa")
    expect(list.map((i) => [i.name, i.sku, i.priceMinor])).toEqual([
      ["Camisa (S, Azul)", "P00002-1", 1500],
      ["Camisa (S, Negro)", "P00002-2", 1500],
      ["Camisa (M, Azul)", "P00002-3", 1500],
      ["Camisa (M, Negro)", "P00002-4", 1500],
    ])
    expect(new Set(list.map((i) => i.productId)).size).toBe(1)
    const d = await detail(owner, first.productId)
    expect(d.options).toEqual(camisa.options)
    expect(d.variants.map((v) => v.variantActive)).toEqual([true, true, true, true])
    // Se encuentra también por la combinación.
    expect((await items(owner, "?search=M, Negro")).map((i) => i.name)).toEqual([
      "Camisa (M, Negro)",
    ])
    const audit = h.db
      .select()
      .from(auditLog)
      .all()
      .find((a) => a.action === "product.created")
    expect((audit?.data as ProductDetail | undefined)?.variants).toHaveLength(4)
  })

  test("cada combinación con su precio y su código; la venta descuenta solo la suya", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    const first = await create(owner, {
      ...camisa,
      options: [
        { name: "Talla", values: ["S", "XL"] },
        { name: "Color", values: ["Azul"] },
      ],
      variants: [
        { values: ["S", "Azul"], priceMinor: 1500, barcode: "7590000000017" },
        { values: ["xl", " azul "], priceMinor: 1800, sku: "CAM-XL" },
      ],
    })
    const [s, xl] = (await detail(owner, first.productId)).variants
    expect(xl).toMatchObject({ name: "Camisa (XL, Azul)", sku: "CAM-XL", priceMinor: 1800 })
    expect((await items(owner, "?search=7590000000017")).map((i) => i.name)).toEqual([
      "Camisa (S, Azul)",
    ])
    const sale = await h.call("/api/documents", {
      cookie: owner,
      body: sell(terminalId, methodUsd, xl?.variantId ?? "", 1800),
    })
    expect(sale.status).toBe(201)
    const after = (await detail(owner, first.productId)).variants
    expect(after.map((v) => v.stockMilli)).toEqual([0, -1000])
    expect(s?.variantId).toBe(after[0]?.variantId)
  })

  test("al editar, cada combinación conserva su existencia; las que se quitan se desactivan", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    const first = await create(owner, {
      ...camisa,
      options: [
        { name: "Talla", values: ["S", "M"] },
        { name: "Color", values: ["Azul"] },
      ],
    })
    const [s, m] = (await detail(owner, first.productId)).variants
    if (!s || !m) throw new Error("faltan variantes")
    const sale = await h.call("/api/documents", {
      cookie: owner,
      body: sell(terminalId, methodUsd, m.variantId, 1500),
    })
    expect(sale.status).toBe(201)

    // Renombrar un valor y agregar una talla.
    const renamed = await patch(owner, first.productId, {
      options: [
        { name: "Talla", values: ["S", "M", "L"] },
        { name: "Color", values: ["Azul marino"] },
      ],
      variants: [
        { id: s.variantId, values: ["S", "Azul marino"], priceMinor: 1500 },
        { id: m.variantId, values: ["M", "Azul marino"], priceMinor: 1500 },
        { values: ["L", "Azul marino"], priceMinor: 1700 },
      ],
    })
    expect(renamed.status).toBe(200)
    let d = await detail(owner, first.productId)
    expect(d.variants.map((v) => [v.name, v.sku, v.stockMilli])).toEqual([
      ["Camisa (S, Azul marino)", "P00002-1", 0],
      ["Camisa (M, Azul marino)", "P00002-2", -1000],
      ["Camisa (L, Azul marino)", "P00002-3", 0],
    ])
    expect(d.variants[1]?.variantId).toBe(m.variantId)

    // Quitar la S: deja de venderse, pero no se borra.
    const options = [
      { name: "Talla", values: ["M", "L"] },
      { name: "Color", values: ["Azul marino"] },
    ]
    const withoutS = d.variants
      .filter((v) => v.optionValues?.[0] !== "S")
      .map((v) => ({ id: v.variantId, values: v.optionValues, priceMinor: v.priceMinor }))
    expect((await patch(owner, first.productId, { options, variants: withoutS })).status).toBe(200)
    expect((await items(owner, "?search=camisa")).map((i) => i.name)).toEqual([
      "Camisa (M, Azul marino)",
      "Camisa (L, Azul marino)",
    ])
    d = await detail(owner, first.productId)
    expect(d.variants.map((v) => [v.optionValues?.[0], v.variantActive])).toEqual([
      ["M", true],
      ["L", true],
      ["S", false],
    ])

    // Volver a agregarla recupera la misma variante.
    const back = await patch(owner, first.productId, {
      options: [
        { name: "Talla", values: ["S", "M", "L"] },
        { name: "Color", values: ["Azul marino"] },
      ],
      variants: [...withoutS, { values: ["S", "Azul marino"], priceMinor: 1400 }],
    })
    expect(back.status).toBe(200)
    d = await detail(owner, first.productId)
    expect(d.variants[0]).toMatchObject({ variantId: s.variantId, priceMinor: 1400, active: true })

    // El nombre del producto, el mínimo y la moneda valen para todas.
    await patch(owner, first.productId, { name: "Franela", minStockMilli: 2000 })
    d = await detail(owner, first.productId)
    expect(d.variants.map((v) => [v.name, v.minStockMilli])).toEqual([
      ["Franela (S, Azul marino)", 2000],
      ["Franela (M, Azul marino)", 2000],
      ["Franela (L, Azul marino)", 2000],
    ])
    // Un precio sin combinaciones vale para todas las que se venden.
    await patch(owner, first.productId, { priceMinor: 2000 })
    expect((await items(owner, "?search=franela")).map((i) => i.priceMinor)).toEqual([
      2000, 2000, 2000,
    ])
  })

  test("un producto que ya se vendía pasa a tener tallas y vuelve a una sola forma", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    await h.call("/api/documents", { cookie: owner, body: saleBody(terminalId, methodUsd) })
    const res = await patch(owner, "p1", {
      options: [{ name: "Tamaño", values: ["Pequeño", "Grande"] }],
      variants: [
        { id: "v1", values: ["Grande"], priceMinor: 150 },
        { values: ["Pequeño"], priceMinor: 100 },
      ],
    })
    expect(res.status).toBe(200)
    let d = await detail(owner, "p1")
    expect(d.variants.map((v) => [v.variantId === "v1", v.name, v.sku, v.stockMilli])).toEqual([
      [false, "Pan (Pequeño)", "PAN-1", 0],
      [true, "Pan (Grande)", "PAN", -2000],
    ])

    const simple = await patch(owner, "p1", {
      options: null,
      variants: [{ id: "v1", values: [], priceMinor: 160 }],
    })
    expect(simple.status).toBe(200)
    d = await detail(owner, "p1")
    expect(d.options).toBeNull()
    expect(d.variants.map((v) => [v.name, v.variantActive, v.optionValues])).toEqual([
      ["Pan", true, null],
      ["Pan (Pequeño)", false, ["Pequeño"]],
    ])
    expect((await items(owner, "?search=pan")).map((i) => [i.name, i.priceMinor])).toEqual([
      ["Pan", 160],
    ])
    // De nuevo sencillo, se edita como siempre.
    expect((await patch(owner, "p1", { barcode: "123", priceMinor: 170 })).status).toBe(200)
    expect((await items(owner, "?search=123"))[0]).toMatchObject({ name: "Pan", priceMinor: 170 })
  })

  test("rechaza combinaciones que no cuadran y códigos repetidos", async () => {
    const { owner } = await setUp(h)
    const bad = async (body: Record<string, unknown>, status = 422) => {
      const res = await h.call("/api/products", { cookie: owner, body: { ...camisa, ...body } })
      expect(res.status).toBe(status)
      return ((await res.json()) as { error: { message: string } }).error.message
    }
    expect(await bad({ variants: [{ values: ["XL", "Azul"], priceMinor: 1 }] })).toContain(
      "«XL» no es un valor de «Talla»",
    )
    expect(await bad({ variants: [{ values: ["S"], priceMinor: 1 }] })).toContain(
      "un valor de cada característica",
    )
    expect(
      await bad({
        variants: [
          { values: ["S", "Azul"], priceMinor: 1 },
          { values: ["s", "AZUL"], priceMinor: 1 },
        ],
      }),
    ).toContain("repetida")
    expect(await bad({ options: [{ name: "Talla", values: ["M", "m"] }] })).toContain("repetido")
    expect(await bad({ barcode: "999" })).toContain("su propio código")
    expect(
      await bad(
        {
          variants: [
            { values: ["S", "Azul"], priceMinor: 1, barcode: "555" },
            { values: ["M", "Azul"], priceMinor: 1, barcode: "555" },
          ],
        },
        409,
      ),
    ).toContain("código de barras")
    const { name: _, options: __, ...plain } = camisa
    expect(
      (
        await h.call("/api/products", {
          cookie: owner,
          body: { ...plain, name: "Sin", variants: [{ values: [], priceMinor: 1 }] },
        })
      ).status,
    ).toBe(422)

    const first = await create(owner, camisa)
    expect((await patch(owner, first.productId, { sku: "X" })).status).toBe(422)
    expect(
      (await patch(owner, first.productId, { options: [{ name: "Talla", values: ["S"] }] })).status,
    ).toBe(422)
    const foreign = await patch(owner, first.productId, {
      variants: [{ id: "v1", values: ["S", "Azul"], priceMinor: 1 }],
    })
    expect(foreign.status).toBe(422)
    // Una combinación sin id que ya existe es esa misma variante.
    const same = await patch(owner, first.productId, {
      variants: [{ values: ["M", "Negro"], priceMinor: 1 }],
    })
    expect(same.status).toBe(200)
    const d = await detail(owner, first.productId)
    expect(d.variants.map((v) => v.priceMinor)).toEqual([1500, 1500, 1500, 1])
    // Pero otra no puede quedarse con sus valores.
    const s = d.variants[0]?.variantId
    const dup = await patch(owner, first.productId, {
      variants: [{ id: s, values: ["M", "Negro"], priceMinor: 1 }],
    })
    expect(dup.status).toBe(422)
    expect((await patch(owner, "p1", { variants: [] })).status).toBe(422)
  })

  test("desactivar el producto deja de vender todas sus tallas", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    const first = await create(owner, camisa)
    expect((await patch(owner, first.productId, { active: false })).status).toBe(200)
    expect(await items(owner, "?search=camisa")).toEqual([])
    expect((await items(owner, "?search=camisa&all=true")).every((i) => !i.active)).toBe(true)
    const sale = await h.call("/api/documents", {
      cookie: owner,
      body: sell(terminalId, methodUsd, first.variantId, 1500),
    })
    expect(sale.status).toBe(422)
  })
})
