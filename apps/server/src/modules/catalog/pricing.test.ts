import { beforeEach, describe, expect, test } from "bun:test"
import type { BulkPriceResult, CatalogItem, Category } from "@millhiore/contracts"
import { auditLog, variant } from "@millhiore/db"
import { eq } from "drizzle-orm"
import { type Harness, harness, setUp } from "../../testing/harness"

let h: Harness
let owner: string
beforeEach(async () => {
  h = harness()
  ;({ owner } = await setUp(h))
})

async function createProduct(body: Record<string, unknown>): Promise<CatalogItem> {
  const res = await h.call("/api/products", { cookie: owner, body })
  expect(res.status).toBe(201)
  return (await res.json()) as CatalogItem
}

function setCost(variantId: string, costMinor: number, costCurrency: string) {
  h.db.update(variant).set({ costMinor, costCurrency }).where(eq(variant.id, variantId)).run()
}

const priceOf = (variantId: string) =>
  h.db.select().from(variant).where(eq(variant.id, variantId)).get()?.priceMinor

async function bulk(body: Record<string, unknown>, cookie = owner) {
  return await h.call("/api/products/bulk-price", { cookie, body })
}

async function bulkOk(body: Record<string, unknown>): Promise<BulkPriceResult> {
  const res = await bulk(body)
  expect(res.status).toBe(200)
  return (await res.json()) as BulkPriceResult
}

const percent = (valueBp: number, extra: Record<string, unknown> = {}) => ({
  mode: "percent",
  valueBp,
  rounding: "none",
  apply: false,
  ...extra,
})

describe("cambio masivo de precios", () => {
  test("la vista previa calcula sin guardar; aplicar guarda y deja una entrada en la bitácora", async () => {
    const agua = await createProduct({ name: "Agua", priceMinor: 116, priceCurrency: "USD" })
    const preview = await bulkOk(percent(1000))
    expect(preview).toMatchObject({ applied: false, changed: 2, unchanged: 0, skipped: 0 })
    expect(preview.changes).toEqual([
      expect.objectContaining({ name: "Agua", beforeMinor: 116, afterMinor: 128 }),
      expect.objectContaining({ name: "Pan", beforeMinor: 150, afterMinor: 165 }),
    ])
    expect(priceOf(agua.variantId)).toBe(116)
    expect(
      h.db
        .select()
        .from(auditLog)
        .all()
        .some((a) => a.action === "product.prices.bulk"),
    ).toBe(false)

    const applied = await bulkOk(percent(1000, { apply: true }))
    expect(applied).toMatchObject({ applied: true, changed: 2 })
    expect(priceOf(agua.variantId)).toBe(128)
    expect(priceOf("v1")).toBe(165)
    const entries = h.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.action === "product.prices.bulk")
    expect(entries).toHaveLength(1)
    expect(entries[0]?.data).toMatchObject({
      mode: "percent",
      valueBp: 1000,
      count: 2,
      changes: expect.arrayContaining([
        expect.objectContaining({ variantId: "v1", beforeMinor: 150, afterMinor: 165 }),
      ]),
    })
  })

  test("baja precios y redondea a 5 o 10 céntimos o a la unidad", async () => {
    const r1 = await bulkOk(percent(-1000, { rounding: "five" })) // 1,50 − 10 % = 1,35
    expect(r1.changes[0]?.afterMinor).toBe(135)
    const r2 = await bulkOk(percent(-1000, { rounding: "ten" })) // 1,35 → 1,40
    expect(r2.changes[0]?.afterMinor).toBe(140)
    const r3 = await bulkOk(percent(1000, { rounding: "unit" })) // 1,65 → 2,00
    expect(r3.changes[0]?.afterMinor).toBe(200)
    // Solo redondear: 1,50 a la unidad → 2,00
    const r4 = await bulkOk(percent(0, { rounding: "unit" }))
    expect(r4.changes[0]?.afterMinor).toBe(200)
  })

  test("los que quedan igual no cuentan como cambio", async () => {
    await createProduct({ name: "Chicle", priceMinor: 100, priceCurrency: "USD" })
    const r = await bulkOk(percent(0, { rounding: "unit" }))
    expect(r).toMatchObject({ changed: 1, unchanged: 1 })
    expect(r.changes.map((c) => c.name)).toEqual(["Pan"])
  })

  test("ganancia sobre el costo con IVA incluido, sin IVA y con producto exento", async () => {
    setCost("v1", 100, "USD")
    const exento = await createProduct({
      name: "Harina",
      priceMinor: 100,
      priceCurrency: "USD",
      taxId: "exento",
    })
    setCost(exento.variantId, 100, "USD")

    // IVA incluido (por defecto): 1,00 × 1,30 × 1,16 = 1,508 → 1,51; el exento no suma IVA.
    const withTax = await bulkOk({ mode: "markup", valueBp: 3000, rounding: "none", apply: false })
    const byName = Object.fromEntries(withTax.changes.map((c) => [c.name, c.afterMinor]))
    expect(byName).toEqual({ Harina: 130, Pan: 151 })

    await h.call("/api/settings/fiscal", {
      method: "PUT",
      cookie: owner,
      body: { pricesIncludeTax: false },
    })
    const withoutTax = await bulkOk({
      mode: "markup",
      valueBp: 3000,
      rounding: "none",
      apply: false,
    })
    expect(withoutTax.changes.find((c) => c.name === "Pan")?.afterMinor).toBe(130)

    // Un negocio que no cobra IVA tampoco lo suma, aunque sus precios digan incluirlo.
    await h.call("/api/settings/fiscal", {
      method: "PUT",
      cookie: owner,
      body: { pricesIncludeTax: true, taxpayer: "none" },
    })
    const noVat = await bulkOk({ mode: "markup", valueBp: 3000, rounding: "none", apply: false })
    expect(noVat.changes.find((c) => c.name === "Pan")?.afterMinor).toBe(130)
  })

  test("lleva el costo a la moneda del precio con la tasa vigente; sin costo se omite", async () => {
    await h.call("/api/settings/fiscal", {
      method: "PUT",
      cookie: owner,
      body: { pricesIncludeTax: false },
    })
    // Precio en Bs con costo en $: 2,00 $ × 36,5 = 73,00 Bs, + 25 % = 91,25 Bs.
    const queso = await createProduct({ name: "Queso", priceMinor: 5000, priceCurrency: "VES" })
    setCost(queso.variantId, 200, "USD")
    // Precio en $ con costo en Bs: 73,00 Bs / 36,5 = 2,00 $, + 25 % = 2,50 $.
    const leche = await createProduct({ name: "Leche", priceMinor: 100, priceCurrency: "USD" })
    setCost(leche.variantId, 7300, "VES")

    const r = await bulkOk({ mode: "markup", valueBp: 2500, rounding: "none", apply: true })
    expect(r).toMatchObject({ changed: 2, skipped: 1, skippedNoCost: 1, skippedNoRate: 0 })
    expect(priceOf(queso.variantId)).toBe(9125)
    expect(priceOf(leche.variantId)).toBe(250)
    expect(priceOf("v1")).toBe(150) // Pan no tiene costo
  })

  test("alcance: una categoría, sin categoría o los productos indicados", async () => {
    const cat = (await (
      await h.call("/api/categories", { cookie: owner, body: { name: "Bebidas" } })
    ).json()) as Category
    const agua = await createProduct({
      name: "Agua",
      priceMinor: 100,
      priceCurrency: "USD",
      categoryId: cat.id,
    })
    const jugo = await createProduct({ name: "Jugo", priceMinor: 200, priceCurrency: "USD" })

    const byCategory = await bulkOk(percent(1000, { categoryId: cat.id }))
    expect(byCategory.changes.map((c) => c.name)).toEqual(["Agua"])
    const uncategorized = await bulkOk(percent(1000, { categoryId: "none" }))
    expect(uncategorized.changes.map((c) => c.name)).toEqual(["Jugo", "Pan"])
    const listed = await bulkOk(percent(1000, { variantIds: [jugo.variantId, agua.variantId] }))
    expect(listed.changes.map((c) => c.name)).toEqual(["Agua", "Jugo"])

    expect((await bulk(percent(1000, { categoryId: "nope" }))).status).toBe(404)
  })

  test("todos los activos: los desactivados no cambian salvo que se indiquen", async () => {
    const viejo = await createProduct({ name: "Viejo", priceMinor: 100, priceCurrency: "USD" })
    await h.call(`/api/products/${viejo.productId}`, {
      method: "PATCH",
      cookie: owner,
      body: { active: false },
    })
    const all = await bulkOk(percent(1000))
    expect(all.changes.map((c) => c.name)).toEqual(["Pan"])
    const listed = await bulkOk(percent(1000, { variantIds: [viejo.variantId] }))
    expect(listed.changes.map((c) => c.name)).toEqual(["Viejo"])
  })

  test("valida el cuerpo y los permisos", async () => {
    expect((await bulk(percent(0))).status).toBe(422) // 0 % sin redondeo no cambia nada
    expect(
      (await bulk({ mode: "markup", valueBp: -100, rounding: "none", apply: false })).status,
    ).toBe(422)
    expect((await bulk(percent(-10_000))).status).toBe(422) // bajar 100 % dejaría todo en 0

    for (const [username, roleId] of [
      ["pedro", "cashier"],
      ["ana", "warehouse"],
    ] as const) {
      await h.call("/api/users", {
        cookie: owner,
        body: { name: username, username, password: "otra-clave-1", roleId },
      })
    }
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await bulk(percent(1000), cashier)).status).toBe(403)
    // El almacenista gestiona el catálogo pero no ve costos: sube porcentajes, no pone márgenes.
    const warehouse = await h.login("ana", "otra-clave-1")
    expect((await bulk(percent(1000), warehouse)).status).toBe(200)
    expect(
      (await bulk({ mode: "markup", valueBp: 3000, rounding: "none", apply: false }, warehouse))
        .status,
    ).toBe(403)
  })
})
