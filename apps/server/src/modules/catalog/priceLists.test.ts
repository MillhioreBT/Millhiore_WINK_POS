import { beforeEach, describe, expect, test } from "bun:test"
import type { Bootstrap, CatalogItem, Contact, PriceList } from "@millhiore/contracts"
import { auditLog } from "@millhiore/db"
import { type Harness, harness, setUp } from "../../testing/harness"

let h: Harness
let owner: string
beforeEach(async () => {
  h = harness()
  ;({ owner } = await setUp(h))
})

async function createList(body: Record<string, unknown>): Promise<PriceList> {
  const res = await h.call("/api/price-lists", { cookie: owner, body })
  expect(res.status).toBe(201)
  return (await res.json()) as PriceList
}

const bootstrap = async () =>
  (await (await h.call("/api/bootstrap", { cookie: owner })).json()) as Bootstrap

describe("listas de precios", () => {
  test("se crean, se editan y la caja recibe las activas con sus precios propios", async () => {
    const mayor = await createList({ name: "Al mayor", adjustBp: -1000 })
    const reventa = await createList({ name: "Revendedores" })
    expect(mayor).toMatchObject({ adjustBp: -1000, position: 1, priceCount: 0, active: true })
    expect(reventa.position).toBe(2)

    const res = await h.call("/api/products", {
      cookie: owner,
      body: {
        name: "Refresco",
        priceMinor: 250,
        priceCurrency: "USD",
        listPrices: [{ priceListId: mayor.id, priceMinor: 200 }],
      },
    })
    expect(res.status).toBe(201)
    const refresco = (await res.json()) as CatalogItem

    let boot = await bootstrap()
    expect(boot.priceLists.map((l) => l.name)).toEqual(["Al mayor", "Revendedores"])
    expect(boot.priceLists[0]?.prices).toEqual([
      { variantId: refresco.variantId, priceMinor: 200, priceCurrency: "USD" },
    ])

    // Cambiar un precio propio, quitarlo y poner otro; la bitácora guarda antes y después.
    await h.call(`/api/products/${refresco.productId}`, {
      method: "PATCH",
      cookie: owner,
      body: {
        listPrices: [
          { priceListId: mayor.id, priceMinor: null },
          { priceListId: reventa.id, priceMinor: 220 },
        ],
      },
    })
    boot = await bootstrap()
    expect(boot.priceLists.map((l) => l.prices.length)).toEqual([0, 1])
    const updated = h.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.action === "product.updated")
      .at(-1)
    expect(updated?.data).toMatchObject({
      before: { listPrices: { [mayor.id]: 200, [reventa.id]: null } },
      after: { listPrices: { [mayor.id]: null, [reventa.id]: 220 } },
    })

    // Desactivar una lista la saca de la caja; editarla queda en la bitácora.
    const off = await h.call(`/api/price-lists/${reventa.id}`, {
      method: "PATCH",
      cookie: owner,
      body: { active: false, name: "Reventa" },
    })
    expect(await off.json()).toMatchObject({ name: "Reventa", active: false, priceCount: 1 })
    expect((await bootstrap()).priceLists.map((l) => l.name)).toEqual(["Al mayor"])
    const all = (await (
      await h.call("/api/price-lists?all=true", { cookie: owner })
    ).json()) as PriceList[]
    expect(all).toHaveLength(2)
    expect(
      h.db
        .select()
        .from(auditLog)
        .all()
        .map((a) => a.action),
    ).toContain("price-list.updated")
  })

  test("un cliente compra con su lista; no se asignan listas inactivas ni inexistentes", async () => {
    const mayor = await createList({ name: "Al mayor", adjustBp: -500 })
    const res = await h.call("/api/contacts", {
      cookie: owner,
      body: { name: "Abasto Don José", priceListId: mayor.id },
    })
    expect(res.status).toBe(201)
    const client = (await res.json()) as Contact
    expect(client.priceListId).toBe(mayor.id)
    const lists = (await (
      await h.call("/api/price-lists", { cookie: owner })
    ).json()) as PriceList[]
    expect(lists[0]?.customerCount).toBe(1)

    const cleared = await h.call(`/api/contacts/${client.id}`, {
      method: "PATCH",
      cookie: owner,
      body: { priceListId: null },
    })
    expect(((await cleared.json()) as Contact).priceListId).toBeNull()

    await h.call(`/api/price-lists/${mayor.id}`, {
      method: "PATCH",
      cookie: owner,
      body: { active: false },
    })
    const bad = await h.call(`/api/contacts/${client.id}`, {
      method: "PATCH",
      cookie: owner,
      body: { priceListId: mayor.id },
    })
    expect(bad.status).toBe(422)
    const unknown = await h.call("/api/products/p1", {
      method: "PATCH",
      cookie: owner,
      body: { listPrices: [{ priceListId: "nope", priceMinor: 100 }] },
    })
    expect(unknown.status).toBe(422)
  })

  test("nombres únicos, ajustes válidos y solo quien gestiona el catálogo", async () => {
    await createList({ name: "Al mayor" })
    expect(
      (await h.call("/api/price-lists", { cookie: owner, body: { name: "Al mayor" } })).status,
    ).toBe(409)
    expect(
      (
        await h.call("/api/price-lists", {
          cookie: owner,
          body: { name: "Gratis", adjustBp: -10_000 },
        })
      ).status,
    ).toBe(422)

    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await h.call("/api/price-lists", { cookie: cashier })).status).toBe(200)
    expect(
      (await h.call("/api/price-lists", { cookie: cashier, body: { name: "Otra" } })).status,
    ).toBe(403)
  })
})
