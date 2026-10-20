import { beforeEach, describe, expect, test } from "bun:test"
import type { CatalogItem, Category } from "@millhiore/contracts"
import { type Harness, harness, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const post = (cookie: string, path: string, body: unknown, method = "POST") =>
  h.call(path, { cookie, method, body })

describe("categorías", () => {
  test("se crean, se ordenan y no admiten nombres repetidos", async () => {
    const { owner } = await setUp(h)
    const bebidas = (await (
      await post(owner, "/api/categories", { name: "Bebidas" })
    ).json()) as Category
    const viveres = (await (
      await post(owner, "/api/categories", { name: "  Víveres " })
    ).json()) as Category
    expect(bebidas).toMatchObject({ name: "Bebidas", active: true, productCount: 0 })
    expect(viveres.name).toBe("Víveres")
    expect(viveres.position).toBeGreaterThan(bebidas.position)

    const dup = await post(owner, "/api/categories", { name: "Bebidas" })
    expect(dup.status).toBe(409)
    expect(await post(owner, "/api/categories", { name: "  " })).toMatchObject({ status: 422 })

    // Reordenar: «Víveres» pasa primero.
    await post(owner, `/api/categories/${viveres.id}`, { position: 0 }, "PATCH")
    await post(owner, `/api/categories/${bebidas.id}`, { position: 5 }, "PATCH")
    const list = (await (await h.call("/api/categories", { cookie: owner })).json()) as Category[]
    expect(list.map((c) => c.name)).toEqual(["Víveres", "Bebidas"])
  })

  test("un producto se asigna a una categoría y se cuenta en ella", async () => {
    const { owner } = await setUp(h)
    const bebidas = (await (
      await post(owner, "/api/categories", { name: "Bebidas" })
    ).json()) as Category
    const created = await post(owner, "/api/products", {
      name: "Refresco",
      priceMinor: 250,
      priceCurrency: "USD",
      categoryId: bebidas.id,
    })
    expect(created.status).toBe(201)
    const item = (await created.json()) as CatalogItem
    expect(item.categoryId).toBe(bebidas.id)

    const list = (await (await h.call("/api/categories", { cookie: owner })).json()) as Category[]
    expect(list[0]?.productCount).toBe(1)

    // Cambiarla y quitarla.
    const other = (await (
      await post(owner, "/api/categories", { name: "Snacks" })
    ).json()) as Category
    const moved = await post(
      owner,
      `/api/products/${item.productId}`,
      { categoryId: other.id },
      "PATCH",
    )
    expect(((await moved.json()) as CatalogItem).categoryId).toBe(other.id)
    const cleared = await post(
      owner,
      `/api/products/${item.productId}`,
      { categoryId: null },
      "PATCH",
    )
    expect(((await cleared.json()) as CatalogItem).categoryId).toBeNull()
  })

  test("una categoría desactivada no se ofrece ni se puede asignar, pero no borra nada", async () => {
    const { owner } = await setUp(h)
    const bebidas = (await (
      await post(owner, "/api/categories", { name: "Bebidas" })
    ).json()) as Category
    const item = (await (
      await post(owner, "/api/products", {
        name: "Refresco",
        priceMinor: 250,
        priceCurrency: "USD",
        categoryId: bebidas.id,
      })
    ).json()) as CatalogItem
    await post(owner, `/api/categories/${bebidas.id}`, { active: false }, "PATCH")

    expect(
      (await (await h.call("/api/categories", { cookie: owner })).json()) as Category[],
    ).toEqual([])
    const all = (await (
      await h.call("/api/categories?all=true", { cookie: owner })
    ).json()) as Category[]
    expect(all.map((c) => c.name)).toEqual(["Bebidas"])
    // El producto conserva su categoría.
    const products = (await (
      await h.call("/api/products", { cookie: owner })
    ).json()) as CatalogItem[]
    expect(products.find((p) => p.productId === item.productId)?.categoryId).toBe(bebidas.id)

    const denied = await post(owner, "/api/products", {
      name: "Otro",
      priceMinor: 100,
      priceCurrency: "USD",
      categoryId: bebidas.id,
    })
    expect(denied.status).toBe(422)
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      "UNKNOWN_CATEGORY",
    )
    const ghost = await post(owner, "/api/products", {
      name: "Otro",
      priceMinor: 100,
      priceCurrency: "USD",
      categoryId: "no-existe",
    })
    expect(ghost.status).toBe(422)
  })

  test("solo catalog.manage las crea o edita; cualquiera con sesión las ve", async () => {
    const { owner } = await setUp(h)
    await post(owner, "/api/users", {
      name: "Pedro",
      username: "pedro",
      password: "otra-clave-1",
      roleId: "cashier",
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await post(cashier, "/api/categories", { name: "Bebidas" })).status).toBe(403)
    expect((await h.call("/api/categories", { cookie: cashier })).status).toBe(200)
    expect((await h.call("/api/categories")).status).toBe(401)
    expect((await post(owner, "/api/categories/x", { name: "y" }, "PATCH")).status).toBe(404)
  })
})
