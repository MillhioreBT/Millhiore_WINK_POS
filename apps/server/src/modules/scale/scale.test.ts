import { beforeEach, describe, expect, test } from "bun:test"
import type { Bootstrap, CatalogItem, DocumentDetail, ScaleSettings } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"

let h: Harness
let s: Awaited<ReturnType<typeof setUp>>
beforeEach(async () => {
  h = harness()
  s = await setUp(h)
})

async function json<T>(res: Response, status = 200): Promise<T> {
  if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

/** Queso blanco a 12 $ el kilo, con el código 12 en la balanza. */
const cheese = (over: Record<string, unknown> = {}) =>
  h.call("/api/products", {
    cookie: s.owner,
    body: {
      name: "Queso blanco",
      unit: "kg",
      plu: 12,
      priceMinor: 1200,
      priceCurrency: "USD",
      taxId: "exento",
      ...over,
    },
  })

describe("venta por peso", () => {
  test("un producto por kilo con su código de balanza se vende con decimales", async () => {
    const item = await json<CatalogItem>(await cheese(), 201)
    expect(item).toMatchObject({ unit: "kg", plu: 12 })
    const list = await json<CatalogItem[]>(await h.call("/api/products", { cookie: s.owner }))
    expect(list.find((p) => p.variantId === item.variantId)?.plu).toBe(12)
    // Los demás productos se venden por unidad y sin código de balanza.
    expect(list.find((p) => p.variantId === "v1")).toMatchObject({ unit: "unit", plu: null })

    // 0,350 kg a 12 $ el kilo: 4,20 $.
    const res = await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.terminalId, s.methodUsd, {
        lines: [{ variantId: item.variantId, qtyMilli: 350, unitPriceMinor: 1200 }],
        payments: [
          { id: uuidv7(), paymentMethodId: s.methodUsd, currency: "USD", amountMinor: 420 },
        ],
      }),
    })
    const posted = await json<{ id: string; totalMinor: number }>(res, 201)
    expect(posted.totalMinor).toBe(420)
    const doc = await json<DocumentDetail>(
      await h.call(`/api/documents/${posted.id}`, { cookie: s.owner }),
    )
    expect(doc.lines[0]).toMatchObject({ unit: "kg", qtyMilli: 350, lineTotalMinor: 420 })
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("el código de balanza no se repite y no va con tallas ni colores", async () => {
    await json(await cheese(), 201)
    const dup = await cheese({ name: "Queso amarillo" })
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: { message: string } }).error.message).toContain(
      "código de balanza",
    )
    const withOptions = await cheese({
      name: "Jamón",
      plu: 13,
      options: [{ name: "Tipo", values: ["Ahumado", "Cocido"] }],
    })
    expect(withOptions.status).toBe(422)
    // Fuera de rango.
    expect((await cheese({ name: "Mortadela", plu: 1_000_000 })).status).toBe(422)
  })

  test("se cambia la unidad y el código, y se quita el código", async () => {
    const item = await json<CatalogItem>(await cheese(), 201)
    const edited = await json<CatalogItem>(
      await h.call(`/api/products/${item.productId}`, {
        method: "PATCH",
        cookie: s.owner,
        body: { plu: 99, unit: "l" },
      }),
    )
    expect(edited).toMatchObject({ unit: "l", plu: 99 })
    const cleared = await json<CatalogItem>(
      await h.call(`/api/products/${item.productId}`, {
        method: "PATCH",
        cookie: s.owner,
        body: { plu: null, unit: "unit" },
      }),
    )
    expect(cleared).toMatchObject({ unit: "unit", plu: null })
  })
})

describe("ajustes de la balanza", () => {
  test("de fábrica, cambio y lo que recibe la caja", async () => {
    const defaults = await json<ScaleSettings>(
      await h.call("/api/settings/scale", { cookie: s.owner }),
    )
    expect(defaults).toEqual({
      prefixes: ["20", "21", "22", "23", "24", "25", "26", "27", "28", "29"],
      pluDigits: 5,
      value: "weight",
      priceCurrency: "VES",
    })
    // Con la función apagada la caja no recibe nada.
    let boot = await json<Bootstrap>(await h.call("/api/bootstrap", { cookie: s.owner }))
    expect(boot.features.scale).toBe(false)
    expect(boot.scale).toBeNull()

    const saved = await json<ScaleSettings>(
      await h.call("/api/settings/scale", {
        method: "PUT",
        cookie: s.owner,
        body: { prefixes: ["21", "20", "21"], pluDigits: 4, value: "price", priceCurrency: "USD" },
      }),
    )
    expect(saved.prefixes).toEqual(["20", "21"])
    await h.call("/api/settings/features", {
      method: "PUT",
      cookie: s.owner,
      body: { scale: true },
    })
    boot = await json<Bootstrap>(await h.call("/api/bootstrap", { cookie: s.owner }))
    expect(boot.scale).toEqual({
      prefixes: ["20", "21"],
      pluDigits: 4,
      value: "price",
      priceCurrency: "USD",
    })
  })

  test("valida y exige permiso", async () => {
    const put = (cookie: string, body: Record<string, unknown>) =>
      h.call("/api/settings/scale", {
        method: "PUT",
        cookie,
        body: { prefixes: ["20"], pluDigits: 5, value: "weight", priceCurrency: "VES", ...body },
      })
    expect((await put(s.owner, { prefixes: ["30"] })).status).toBe(422)
    expect((await put(s.owner, { prefixes: [] })).status).toBe(422)
    expect((await put(s.owner, { pluDigits: 7 })).status).toBe(422)
    expect((await put(s.owner, { priceCurrency: "JPY" })).status).toBe(422)
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await put(cashier, {})).status).toBe(403)
    // Leerlos sí puede: la caja los usa.
    expect((await h.call("/api/settings/scale", { cookie: cashier })).status).toBe(200)
  })
})
