import { beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bootstrap, CatalogItem, DocumentDetail, DocumentSummary } from "@millhiore/contracts"
import { auditLog } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { createApp } from "../../app"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const agua = { name: "Agua 1,5 L", priceMinor: 116, priceCurrency: "USD", barcode: "7591234567890" }

describe("catálogo", () => {
  test("crea, busca y edita productos; el cambio de precio queda auditado", async () => {
    const { owner } = await setUp(h)
    const created = await h.call("/api/products", { cookie: owner, body: agua })
    expect(created.status).toBe(201)
    const item = (await created.json()) as CatalogItem
    expect(item).toMatchObject({
      name: "Agua 1,5 L",
      kind: "good",
      tracksStock: true,
      taxId: null,
      sku: "P00002", // el arnés ya creó un producto
      stockMilli: 0,
    })

    const byBarcode = (await (
      await h.call("/api/products?search=7591234567890", { cookie: owner })
    ).json()) as CatalogItem[]
    expect(byBarcode.map((i) => i.name)).toEqual(["Agua 1,5 L"])
    const byName = (await (
      await h.call("/api/products?search=agua", { cookie: owner })
    ).json()) as CatalogItem[]
    expect(byName).toHaveLength(1)

    const edited = await h.call(`/api/products/${item.productId}`, {
      method: "PATCH",
      cookie: owner,
      body: { priceMinor: 150, taxId: "exento" },
    })
    expect(await edited.json()).toMatchObject({ priceMinor: 150, taxId: "exento" })
    const audit = h.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.action === "product.updated")
    expect(audit).toHaveLength(1)
    expect(audit[0]?.data).toMatchObject({
      before: { priceMinor: 116 },
      after: { priceMinor: 150 },
    })

    await h.call(`/api/products/${item.productId}`, {
      method: "PATCH",
      cookie: owner,
      body: { active: false },
    })
    const active = (await (await h.call("/api/products", { cookie: owner })).json()) as unknown[]
    const all = (await (
      await h.call("/api/products?all=true", { cookie: owner })
    ).json()) as unknown[]
    expect(all.length - active.length).toBe(1)
  })

  test("rechaza códigos repetidos, impuestos desconocidos y a quien no gestiona catálogo", async () => {
    const { owner } = await setUp(h)
    await h.call("/api/products", { cookie: owner, body: agua })
    const dup = await h.call("/api/products", { cookie: owner, body: { ...agua, name: "Otra" } })
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: { message: string } }).error.message).toContain(
      "código de barras",
    )
    const badTax = await h.call("/api/products", {
      cookie: owner,
      body: { ...agua, barcode: null, taxId: "nope" },
    })
    expect(badTax.status).toBe(422)

    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await h.call("/api/products", { cookie: cashier })).status).toBe(200)
    const denied = await h.call("/api/products", {
      cookie: cashier,
      body: { ...agua, barcode: null },
    })
    expect(denied.status).toBe(403)
  })

  test("la existencia refleja las ventas", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    await h.call("/api/documents", { cookie: owner, body: saleBody(terminalId, methodUsd) })
    const items = (await (await h.call("/api/products", { cookie: owner })).json()) as CatalogItem[]
    expect(items.find((i) => i.variantId === "v1")?.stockMilli).toBe(-2000)
  })
})

describe("arranque de caja y consulta de documentos", () => {
  test("bootstrap trae negocio, cajas, métodos con su IGTF e impuestos", async () => {
    const { owner } = await setUp(h)
    await h.call("/api/settings/fiscal", {
      method: "PUT",
      cookie: owner,
      body: { taxpayer: "special" },
    })
    const b = (await (await h.call("/api/bootstrap", { cookie: owner })).json()) as Bootstrap
    expect(b.business).toMatchObject({ referenceCurrency: "USD", legalCurrency: "VES" })
    expect(b.terminals.map((t) => t.code)).toEqual(["C1"])
    expect(b.taxes).toHaveLength(4)
    expect(b.fiscal.taxpayer).toBe("special")
    const zelle = b.paymentMethods.find((m) => m.name === "Zelle")
    expect(zelle).toMatchObject({ currency: "USD", surcharge: { id: "igtf", rateBp: 300 } })
    expect(b.paymentMethods.map((m) => m.name)).toEqual([
      "Efectivo VES",
      "Efectivo USD",
      "Pago móvil",
      "Punto de venta",
      "Zelle",
    ])
    const mobile = b.paymentMethods.find((m) => m.name === "Pago móvil")
    expect(mobile).toMatchObject({ currency: "VES", requiresReference: true, surcharge: null })
  })

  test("lista y detalle de ventas, con anulación marcada", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    const sale = (await (
      await h.call("/api/documents", { cookie: owner, body: saleBody(terminalId, methodUsd) })
    ).json()) as { id: string }
    await h.call(`/api/documents/${sale.id}/void`, {
      cookie: owner,
      body: { reversalId: uuidv7(), reason: "prueba" },
    })

    const list = (await (
      await h.call("/api/documents?type=SALE", { cookie: owner })
    ).json()) as DocumentSummary[]
    expect(list).toHaveLength(2)
    const original = list.find((d) => d.id === sale.id)
    expect(original?.reversedBy).not.toBeNull()
    expect(original?.createdBy).toBe("Dueña")

    const detail = (await (
      await h.call(`/api/documents/${sale.id}`, { cookie: owner })
    ).json()) as DocumentDetail
    expect(detail.lines).toEqual([
      expect.objectContaining({ name: "Pan", qtyMilli: 2000, lineTotalMinor: 300 }),
    ])
    expect(detail.payments[0]).toMatchObject({ methodName: "Efectivo USD", amountMinor: 300 })
    expect(detail.taxes[0]).toMatchObject({ taxId: "iva-general", baseMinor: 259, taxMinor: 41 })
    expect(detail.rate).toEqual({ base: "USD", quote: "VES", value: "36.50000000" })

    expect((await h.call("/api/documents?type=NOPE", { cookie: owner })).status).toBe(422)
    expect((await h.call("/api/documents/nope", { cookie: owner })).status).toBe(404)
  })
})

describe("aplicación web", () => {
  test("sirve archivos, cae en index.html para rutas del navegador y no expone fuera de la carpeta", async () => {
    const root = join(tmpdir(), `millhiore-web-${uuidv7()}`)
    mkdirSync(join(root, "assets"), { recursive: true })
    writeFileSync(join(root, "index.html"), "<!doctype html><title>WINK</title>")
    writeFileSync(join(root, "assets", "app-abc.js"), "console.log(1)")
    try {
      const app = createApp({ db: h.db, auth: {} as never, now: Date.now, webRoot: root })
      const asset = await app.request("/assets/app-abc.js")
      expect(await asset.text()).toBe("console.log(1)")
      expect(asset.headers.get("cache-control")).toContain("immutable")
      const route = await app.request("/pos")
      expect(await route.text()).toContain("<title>WINK</title>")
      const traversal = await app.request("/..%2f..%2fpackage.json")
      expect(await traversal.text()).toContain("<title>WINK</title>")
      // La API sigue respondiendo como API, no con la página.
      expect(await (await app.request("/api/health")).json()).toMatchObject({ status: "ok" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
