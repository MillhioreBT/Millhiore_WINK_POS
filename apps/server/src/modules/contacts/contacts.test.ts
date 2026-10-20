import { beforeEach, describe, expect, test } from "bun:test"
import type { CatalogItem, Contact, DocumentSummary } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, setUp } from "../../testing/harness"
import { normalizeTaxId } from "./service"

let h: Harness
beforeEach(() => {
  h = harness()
})

describe("contactos", () => {
  test("normaliza la cédula y el RIF", () => {
    expect(normalizeTaxId("v12345678")).toBe("V-12345678")
    expect(normalizeTaxId("J-123456789")).toBe("J-12345678-9")
    expect(normalizeTaxId("j12345678-9")).toBe("J-12345678-9")
    expect(normalizeTaxId(null)).toBeNull()
  })

  test("crea, busca por RIF y rechaza duplicados; el cajero crea pero no edita", async () => {
    const { owner } = await setUp(h)
    const created = await h.call("/api/contacts", {
      cookie: owner,
      body: {
        kind: "supplier",
        name: "Distribuidora Polar",
        taxId: "j-123456789",
        phone: "0212-5550000",
      },
    })
    expect(created.status).toBe(201)
    const polar = (await created.json()) as Contact
    expect(polar.taxId).toBe("J-12345678-9")

    const dup = await h.call("/api/contacts", {
      cookie: owner,
      body: { name: "Otra", taxId: "J-12345678-9" },
    })
    expect(dup.status).toBe(409)
    expect(
      (await h.call("/api/contacts", { cookie: owner, body: { name: "x", taxId: "123" } })).status,
    ).toBe(422)

    const found = (await (
      await h.call("/api/contacts?search=12345678", { cookie: owner })
    ).json()) as Contact[]
    expect(found.map((c) => c.name)).toEqual(["Distribuidora Polar"])
    const customers = (await (
      await h.call("/api/contacts?kind=customer", { cookie: owner })
    ).json()) as Contact[]
    expect(customers).toEqual([])

    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect(
      (
        await h.call("/api/contacts", {
          cookie: cashier,
          body: { name: "María", taxId: "V-1234567" },
        })
      ).status,
    ).toBe(201)
    const edit = await h.call(`/api/contacts/${polar.id}`, {
      method: "PATCH",
      cookie: cashier,
      body: { name: "Polar" },
    })
    expect(edit.status).toBe(403)
  })

  test("una compra a un proveedor deja el último costo sin IVA y solo lo ve quien puede", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    const supplier = (await (
      await h.call("/api/contacts", {
        cookie: owner,
        body: { kind: "supplier", name: "Panadería El Trigo", taxId: "J-301234567" },
      })
    ).json()) as Contact

    // 10 panes a 1,16 $ con IVA incluido (pan con IVA general en el arnés) → costo 1,00 $
    const purchase = await h.call("/api/documents", {
      cookie: owner,
      body: {
        id: uuidv7(),
        type: "PURCHASE",
        terminalId,
        currency: "USD",
        rate: { base: "USD", quote: "VES", value: "36.5" },
        pricesIncludeTax: true,
        contactId: supplier.id,
        externalRef: "FAC-000815",
        lines: [{ variantId: "v1", qtyMilli: 10_000, unitPriceMinor: 116 }],
        payments: [
          { id: uuidv7(), paymentMethodId: methodUsd, currency: "USD", amountMinor: 1160 },
        ],
      },
    })
    expect(purchase.status).toBe(201)

    const items = (await (await h.call("/api/products", { cookie: owner })).json()) as CatalogItem[]
    expect(items.find((i) => i.variantId === "v1")).toMatchObject({
      costMinor: 100,
      costCurrency: "USD",
      stockMilli: 10_000,
    })
    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    const seen = (await (
      await h.call("/api/products", { cookie: cashier })
    ).json()) as CatalogItem[]
    expect(seen.find((i) => i.variantId === "v1")?.costMinor).toBeNull()

    const docs = (await (
      await h.call("/api/documents?type=PURCHASE", { cookie: owner })
    ).json()) as DocumentSummary[]
    expect(docs[0]).toMatchObject({
      contactName: "Panadería El Trigo",
      contactTaxId: "J-30123456-7",
      externalRef: "FAC-000815",
    })

    const unknown = await h.call("/api/documents", {
      cookie: owner,
      body: {
        id: uuidv7(),
        type: "PURCHASE",
        terminalId,
        currency: "USD",
        contactId: "nope",
        lines: [{ variantId: "v1", qtyMilli: 1000, unitPriceMinor: 100 }],
        payments: [{ id: uuidv7(), paymentMethodId: methodUsd, currency: "USD", amountMinor: 116 }],
        rate: { base: "USD", quote: "VES", value: "36.5" },
      },
    })
    expect(unknown.status).toBe(422)
    expect(checkInvariants(h.db)).toEqual([])
  })
})
