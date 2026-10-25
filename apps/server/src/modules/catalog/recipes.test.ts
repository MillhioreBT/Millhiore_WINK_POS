import { beforeEach, describe, expect, test } from "bun:test"
import type {
  CatalogItem,
  DocumentDetail,
  ProductDetail,
  ProductionRow,
} from "@millhiore/contracts"
import { documentLine, stockBalance } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"
import { writeSetting } from "../settings/service"

let h: Harness
let ctx: Awaited<ReturnType<typeof setUp>>
beforeEach(async () => {
  h = harness()
  ctx = await setUp(h)
})

async function json<T>(res: Response, status = 200): Promise<T> {
  if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

const product = (body: Record<string, unknown>) =>
  h.call("/api/products", { cookie: ctx.owner, body: { priceCurrency: "USD", ...body } })

const stockOf = (variantId: string) =>
  h.db
    .select()
    .from(stockBalance)
    .all()
    .filter((b) => b.variantId === variantId)
    .reduce((acc, b) => acc + b.qtyMilli, 0)

/** Compra en efectivo a ese costo (en dólares; los insumos van exentos). */
async function buy(variantId: string, qtyMilli: number, unitPriceMinor: number) {
  await json(
    await h.call("/api/documents", {
      cookie: ctx.owner,
      body: {
        id: uuidv7(),
        type: "PURCHASE",
        terminalId: ctx.terminalId,
        currency: "USD",
        rate: { base: "USD", quote: "VES", value: "36.5" },
        pricesIncludeTax: true,
        lines: [{ variantId, qtyMilli, unitPriceMinor }],
        payments: [
          {
            id: uuidv7(),
            paymentMethodId: ctx.methodUsd,
            currency: "USD",
            amountMinor: (qtyMilli / 1000) * unitPriceMinor,
          },
        ],
      },
    }),
    201,
  )
}

/** Pan (0,40 $) y carne molida por kilo (8 $), y la hamburguesa: un pan y 150 g de carne +10 %. */
async function kitchen() {
  const pan = await json<CatalogItem>(
    await product({ name: "Pan de hamburguesa", priceMinor: 60, taxId: "exento" }),
    201,
  )
  const carne = await json<CatalogItem>(
    await product({ name: "Carne molida (kg)", priceMinor: 1200, taxId: "exento" }),
    201,
  )
  await buy(pan.variantId, 10_000, 40)
  await buy(carne.variantId, 5000, 800)
  const burger = await json<CatalogItem>(
    await product({
      name: "Hamburguesa",
      kind: "service",
      priceMinor: 500,
      recipe: [
        { ingredientId: pan.variantId, qtyMilli: 1000 },
        { ingredientId: carne.variantId, qtyMilli: 150, wasteBp: 1000 },
      ],
    }),
    201,
  )
  return { pan, carne, burger }
}

const sell = (variantId: string, qtyMilli: number, unitPriceMinor: number) =>
  h.call("/api/documents", {
    cookie: ctx.owner,
    body: saleBody(ctx.terminalId, ctx.methodUsd, {
      lines: [{ variantId, qtyMilli, unitPriceMinor }],
      payments: [
        {
          id: uuidv7(),
          paymentMethodId: ctx.methodUsd,
          currency: "USD",
          amountMinor: (qtyMilli / 1000) * unitPriceMinor,
        },
      ],
    }),
  })

describe("recetas", () => {
  test("se guardan con el producto y se leen con el costo de cada ingrediente", async () => {
    const { pan, carne, burger } = await kitchen()
    expect(burger.hasRecipe).toBe(true)
    expect(pan.hasRecipe).toBe(false)
    const detail = await json<ProductDetail>(
      await h.call(`/api/products/${burger.productId}`, { cookie: ctx.owner }),
    )
    expect(detail.recipe.map((r) => [r.name, r.qtyMilli, r.wasteBp, r.costMinor])).toEqual([
      ["Pan de hamburguesa", 1000, 0, 40],
      ["Carne molida (kg)", 150, 1000, 800],
    ])
    // Un plato no es ingrediente; tampoco el propio producto, ni dos veces el mismo.
    const bad = (recipe: unknown[]) =>
      h.call(`/api/products/${burger.productId}`, {
        method: "PATCH",
        cookie: ctx.owner,
        body: { recipe },
      })
    expect((await bad([{ ingredientId: burger.variantId, qtyMilli: 1000 }])).status).toBe(422)
    const fries = await json<CatalogItem>(
      await product({ name: "Papas", kind: "service", priceMinor: 200 }),
      201,
    )
    expect((await bad([{ ingredientId: fries.variantId, qtyMilli: 1000 }])).status).toBe(422)
    expect(
      (
        await bad([
          { ingredientId: pan.variantId, qtyMilli: 1000 },
          { ingredientId: pan.variantId, qtyMilli: 500 },
        ])
      ).status,
    ).toBe(422)
    // Vacía, se quita.
    const cleared = await json<CatalogItem>(await bad([]))
    expect(cleared.hasRecipe).toBe(false)
    expect(carne.tracksStock).toBe(true)
  })

  test("vender el plato gasta sus ingredientes con la merma; anular la venta los devuelve", async () => {
    const { pan, carne, burger } = await kitchen()
    const res = await sell(burger.variantId, 2000, 500)
    expect(res.status).toBe(201)
    const sale = (await res.json()) as { id: string }
    expect(stockOf(pan.variantId)).toBe(8000)
    // 2 × 150 g × 1,10 = 330 g.
    expect(stockOf(carne.variantId)).toBe(4670)
    expect(stockOf(burger.variantId)).toBe(0)
    // Lo que costó: 0,40 $ de pan + 1,32 $ de carne por hamburguesa.
    const doc = await json<DocumentDetail>(
      await h.call(`/api/documents/${sale.id}`, { cookie: ctx.owner }),
    )
    expect(doc.lines).toHaveLength(1)
    const [line] = h.db
      .select({ c: documentLine.costMinor, cur: documentLine.costCurrency })
      .from(documentLine)
      .where(eq(documentLine.documentId, sale.id))
      .all()
    expect(line).toEqual({ c: 172, cur: "USD" })
    expect(checkInvariants(h.db)).toEqual([])

    const voided = await h.call(`/api/documents/${sale.id}/void`, {
      cookie: ctx.owner,
      body: { reversalId: uuidv7(), reason: "error" },
    })
    expect(voided.status).toBe(201)
    expect(stockOf(pan.variantId)).toBe(10_000)
    expect(stockOf(carne.variantId)).toBe(5000)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("lo que lleva existencia sale de la suya (se produce por tandas), no de su receta", async () => {
    const { pan } = await kitchen()
    const salsa = await json<CatalogItem>(
      await product({
        name: "Salsa de la casa",
        priceMinor: 100,
        recipe: [{ ingredientId: pan.variantId, qtyMilli: 100 }],
      }),
      201,
    )
    expect((await sell(salsa.variantId, 1000, 100)).status).toBe(201)
    expect(stockOf(salsa.variantId)).toBe(-1000)
    expect(stockOf(pan.variantId)).toBe(10_000)
  })

  test("sin existencia suficiente, el aviso nombra el ingrediente", async () => {
    const { burger } = await kitchen()
    writeSetting(h.db, "inventory.allowNegativeStock", false)
    const res = await sell(burger.variantId, 11_000, 500)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain("Pan de hamburguesa")
  })
})

const produce = (variantId: string, qtyMilli: number, over: Record<string, unknown> = {}) =>
  h.call("/api/documents", {
    cookie: ctx.owner,
    body: {
      id: uuidv7(),
      type: "PRODUCTION",
      terminalId: ctx.terminalId,
      currency: "VES",
      rate: { base: "USD", quote: "VES", value: "36.5" },
      lines: [{ variantId, qtyMilli, unitPriceMinor: 0 }],
      payments: [],
      ...over,
    },
  })

const costOf = async (name: string) =>
  (
    await json<CatalogItem[]>(
      await h.call(`/api/products?search=${encodeURIComponent(name)}`, { cookie: ctx.owner }),
    )
  )[0]

describe("producción por tandas", () => {
  /** Albóndigas por kilo: 1 kg de carne con 10 % de merma y dos panes molidos (9,60 $ el kg). */
  async function meatballs() {
    const k = await kitchen()
    const balls = await json<CatalogItem>(
      await product({
        name: "Albóndigas (kg)",
        priceMinor: 1500,
        taxId: "exento",
        recipe: [
          { ingredientId: k.carne.variantId, qtyMilli: 1000, wasteBp: 1000 },
          { ingredientId: k.pan.variantId, qtyMilli: 2000 },
        ],
      }),
      201,
    )
    return { ...k, balls }
  }

  test("gasta los ingredientes, suma lo producido y le deja el costo de la receta", async () => {
    const { pan, carne, balls } = await meatballs()
    const res = await produce(balls.variantId, 3000)
    expect(res.status).toBe(201)
    const posted = (await res.json()) as { id: string; number: string; totalMinor: number }
    expect(posted.number).toContain("-PR-")
    expect(posted.totalMinor).toBe(0)
    expect(stockOf(balls.variantId)).toBe(3000)
    expect(stockOf(carne.variantId)).toBe(1700)
    expect(stockOf(pan.variantId)).toBe(4000)
    expect(await costOf("Albóndigas")).toMatchObject({ costMinor: 960, costCurrency: "USD" })
    const listed = await json<ProductionRow[]>(
      await h.call("/api/production", { cookie: ctx.owner }),
    )
    expect(listed.map((r) => [r.number, r.productName, r.qtyMilli, r.unitCostMinor])).toEqual([
      [posted.number, "Albóndigas (kg)", 3000, 960],
    ])
    const doc = await json<DocumentDetail>(
      await h.call(`/api/documents/${posted.id}`, { cookie: ctx.owner }),
    )
    expect(doc.lines.map((l) => [l.name, l.qtyMilli, l.ingredients])).toEqual([
      [
        "Albóndigas (kg)",
        3000,
        [
          { variantId: carne.variantId, name: "Carne molida (kg)", qtyMilli: 3300 },
          { variantId: pan.variantId, name: "Pan de hamburguesa", qtyMilli: 6000 },
        ],
      ],
    ])
    expect(checkInvariants(h.db)).toEqual([])

    // Se vende de lo producido, con su costo.
    const sold = await sell(balls.variantId, 1000, 1500)
    expect(sold.status).toBe(201)
    const sale = (await sold.json()) as { id: string }
    expect(stockOf(balls.variantId)).toBe(2000)
    expect(stockOf(carne.variantId)).toBe(1700)
    const [line] = h.db
      .select({ c: documentLine.costMinor, cur: documentLine.costCurrency })
      .from(documentLine)
      .where(eq(documentLine.documentId, sale.id))
      .all()
    expect(line).toEqual({ c: 960, cur: "USD" })

    // Anular la producción devuelve los ingredientes, si lo producido sigue ahí.
    writeSetting(h.db, "inventory.allowNegativeStock", false)
    const voidIt = (id: string) =>
      h.call(`/api/documents/${id}/void`, {
        cookie: ctx.owner,
        body: { reversalId: uuidv7(), reason: "error" },
      })
    expect((await voidIt(posted.id)).status).toBe(409)
    expect((await voidIt(sale.id)).status).toBe(201)
    expect((await voidIt(posted.id)).status).toBe(201)
    expect(stockOf(balls.variantId)).toBe(0)
    expect(stockOf(carne.variantId)).toBe(5000)
    expect(stockOf(pan.variantId)).toBe(10_000)
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("solo se produce lo que lleva existencia y tiene receta", async () => {
    const { pan, burger, balls } = await meatballs()
    // Sin receta.
    const noRecipe = await produce(pan.variantId, 1000)
    expect(noRecipe.status).toBe(422)
    expect(((await noRecipe.json()) as { error: { message: string } }).error.message).toContain(
      "no tiene receta",
    )
    // Un plato se prepara al venderlo, no por tandas.
    expect((await produce(burger.variantId, 1000)).status).toBe(422)
    // Sin precio ni pagos.
    expect(
      (
        await produce(balls.variantId, 1000, {
          lines: [{ variantId: balls.variantId, qtyMilli: 1000, unitPriceMinor: 10 }],
        })
      ).status,
    ).toBe(422)
    // Faltando un ingrediente, no deja producir y dice cuál.
    writeSetting(h.db, "inventory.allowNegativeStock", false)
    const short = await produce(balls.variantId, 9000)
    expect(short.status).toBe(409)
    expect(((await short.json()) as { error: { message: string } }).error.message).toContain(
      "Carne molida",
    )
  })
})

describe("producción con lotes", () => {
  test("lo producido entra a su lote nuevo y los ingredientes salen del que vence primero", async () => {
    const { carne, balls } = await (async () => {
      const k = await kitchen()
      const balls = await json<CatalogItem>(
        await product({
          name: "Albóndigas (kg)",
          priceMinor: 1500,
          taxId: "exento",
          tracksLots: true,
          recipe: [{ ingredientId: k.carne.variantId, qtyMilli: 1000 }],
        }),
        201,
      )
      return { ...k, balls }
    })()
    await h.call("/api/settings/features", {
      method: "PUT",
      cookie: ctx.owner,
      body: { lots: true },
    })
    const res = await produce(balls.variantId, 2000, {
      lines: [
        {
          variantId: balls.variantId,
          qtyMilli: 2000,
          unitPriceMinor: 0,
          lot: { code: "T-01", expiresOn: "2026-11-30" },
        },
      ],
    })
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }
    const doc = await json<DocumentDetail>(
      await h.call(`/api/documents/${id}`, { cookie: ctx.owner }),
    )
    // Solo el lote de lo producido: los ingredientes van aparte.
    expect(doc.lines[0]?.lots.map((l) => [l.code, l.expiresOn, l.qtyMilli])).toEqual([
      ["T-01", "2026-11-30", 2000],
    ])
    expect(doc.lines[0]?.ingredients.map((i) => [i.variantId, i.qtyMilli])).toEqual([
      [carne.variantId, 2000],
    ])
    expect(checkInvariants(h.db)).toEqual([])
  })
})
