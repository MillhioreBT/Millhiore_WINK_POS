import { beforeEach, describe, expect, test } from "bun:test"
import type { CatalogItem, Category, Contact, ImportResult } from "@millhiore/contracts"
import { auditLog } from "@millhiore/db"
import { checkInvariants } from "../../posting/invariants"
import { type Harness, harness, setUp } from "../../testing/harness"

let h: Harness
let owner: string
beforeEach(async () => {
  h = harness()
  ;({ owner } = await setUp(h))
})

type Values = Record<string, string | number | null>
const rows = (...values: Values[]) => values.map((v, i) => ({ row: i + 2, values: v }))

async function importProducts(
  values: Values[],
  opts: { apply?: boolean; updateExisting?: boolean; cookie?: string } = {},
) {
  const res = await h.call("/api/import/products", {
    cookie: opts.cookie ?? owner,
    body: {
      rows: rows(...values),
      apply: opts.apply ?? false,
      updateExisting: opts.updateExisting ?? false,
    },
  })
  return { status: res.status, result: (await res.json()) as ImportResult }
}

const products = async () =>
  (await (await h.call("/api/products", { cookie: owner })).json()) as CatalogItem[]

describe("importar productos", () => {
  test("la vista previa revisa cada fila sin guardar nada", async () => {
    const { result } = await importProducts([
      {
        name: "Harina PAN",
        price: "1,30",
        currency: "$",
        category: "Víveres",
        tax: "E",
        stock: 24,
      },
      { name: "Refresco 2 L", price: 2.5, sku: "REF2", barcode: 7591234567890, cost: "1,80" },
      { name: "Sin precio" },
      { name: "Raro", price: "abc", currency: "yenes", tax: "XX" },
      { name: "Otro refresco", price: 1, sku: "ref2" },
    ])
    expect(result).toMatchObject({
      applied: false,
      created: 2,
      errors: 3,
      newCategories: ["Víveres"],
    })
    expect(result.rows.find((r) => r.row === 4)?.messages).toEqual(["Falta el precio"])
    expect(result.rows.find((r) => r.row === 5)?.messages).toEqual([
      "Moneda desconocida: yenes",
      "El precio no es un número válido",
      "IVA desconocido: XX",
    ])
    expect(result.rows.find((r) => r.row === 6)?.messages).toEqual([
      "El SKU ref2 se repite (fila 3)",
    ])
    expect((await products()).map((p) => p.name)).toEqual(["Pan"])
  })

  test("aplicar crea productos, categorías y la existencia inicial con un solo ajuste", async () => {
    const { result } = await importProducts(
      [
        {
          name: "Harina PAN",
          price: "1,30",
          currency: "$",
          category: "Víveres",
          tax: "exento",
          stock: 24,
          minStock: 6,
        },
        { name: "Queso blanco", price: "250", currency: "Bs", category: "víveres", stock: "1,5" },
        { name: "Recarga", price: 1, kind: "Servicio" },
        { name: "Mal", price: "x" },
      ],
      { apply: true },
    )
    expect(result).toMatchObject({ applied: true, created: 3, errors: 1 })
    expect(result.stockDocumentNumber).toMatch(/^C1-AJ-\d+$/)
    const list = await products()
    const harina = list.find((p) => p.name === "Harina PAN")
    expect(harina).toMatchObject({
      priceMinor: 130,
      priceCurrency: "USD",
      taxId: "exento",
      stockMilli: 24_000,
      minStockMilli: 6_000,
      kind: "good",
    })
    expect(list.find((p) => p.name === "Queso blanco")).toMatchObject({
      priceMinor: 25_000,
      priceCurrency: "VES",
      stockMilli: 1_500,
    })
    expect(list.find((p) => p.name === "Recarga")).toMatchObject({
      kind: "service",
      tracksStock: false,
    })
    const categories = (await (
      await h.call("/api/categories", { cookie: owner })
    ).json()) as Category[]
    expect(categories.map((c) => [c.name, c.productCount])).toEqual([["Víveres", 2]])
    expect(
      h.db
        .select()
        .from(auditLog)
        .all()
        .map((a) => a.action),
    ).toContain("product.imported")
    expect(checkInvariants(h.db)).toEqual([])
  })

  test("los existentes (por SKU o código) se omiten o se actualizan", async () => {
    const skip = await importProducts([{ sku: "PAN", name: "Pan canilla", price: 2 }], {
      apply: true,
    })
    expect(skip.result).toMatchObject({ skipped: 1, created: 0 })
    expect((await products())[0]).toMatchObject({ name: "Pan", priceMinor: 150 })

    const update = await importProducts([{ sku: "pan", price: "2,00", stock: 10 }], {
      apply: true,
      updateExisting: true,
    })
    expect(update.result).toMatchObject({ updated: 1 })
    // Sin nombre en la fila se conserva el que tenía.
    expect((await products())[0]).toMatchObject({
      name: "Pan",
      priceMinor: 200,
      stockMilli: 10_000,
    })
  })

  test("un código de barras de otro producto, o existencia en un servicio, son errores", async () => {
    await importProducts([{ name: "Agua", price: 1, barcode: "759000111" }], { apply: true })
    const { result } = await importProducts(
      [
        { sku: "PAN", barcode: "759000111", price: 1 },
        { name: "Delivery", price: 1, kind: "servicio", stock: 2 },
      ],
      { updateExisting: true },
    )
    expect(result.rows.map((r) => r.messages[0])).toEqual([
      "El código 759000111 ya es de otro producto",
      "Un servicio no lleva existencia",
    ])
  })

  test("permisos: catálogo para importar, ajustar inventario para la existencia, ver costos para el costo", async () => {
    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Ana", username: "ana", password: "otra-clave-1", roleId: "warehouse" },
    })
    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const warehouse = await h.login("ana", "otra-clave-1")
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await importProducts([{ name: "X", price: 1 }], { cookie: cashier })).status).toBe(403)
    const { result } = await importProducts([{ name: "X", price: 1, cost: "0,5", stock: 3 }], {
      cookie: warehouse,
    })
    expect(result.rows[0]?.messages).toEqual(["No tienes permiso para cargar costos"])
  })
})

describe("importar contactos", () => {
  const importContacts = async (
    values: Values[],
    opts: { apply?: boolean; updateExisting?: boolean } = {},
  ) =>
    (await (
      await h.call("/api/import/contacts", {
        cookie: owner,
        body: {
          rows: rows(...values),
          apply: opts.apply ?? false,
          updateExisting: opts.updateExisting ?? false,
        },
      })
    ).json()) as ImportResult

  test("crea clientes y proveedores, normaliza el RIF y valida cada fila", async () => {
    const result = await importContacts(
      [
        {
          name: "María Pérez",
          taxId: "v12345678",
          phone: "0414-1234567",
          creditDays: 15,
          creditLimit: "50",
        },
        {
          name: "Distribuidora Sol",
          kind: "Proveedor",
          taxId: "J123456789",
          email: "ventas@sol.com",
        },
        { name: "Repetida", taxId: "V-12345678" },
        { name: "Mal", taxId: "123", kind: "socio", email: "no-es-correo" },
      ],
      { apply: true },
    )
    expect(result).toMatchObject({ created: 2, errors: 2 })
    expect(result.rows.find((r) => r.row === 4)?.messages).toEqual([
      "La cédula o RIF V-12345678 se repite (fila 2)",
    ])
    expect(result.rows.find((r) => r.row === 5)?.messages).toHaveLength(3)
    const all = (await (await h.call("/api/contacts", { cookie: owner })).json()) as Contact[]
    expect(all.map((c) => [c.name, c.kind, c.taxId])).toEqual([
      ["Distribuidora Sol", "supplier", "J-12345678-9"],
      ["María Pérez", "customer", "V-12345678"],
    ])
    expect(all.find((c) => c.name === "María Pérez")).toMatchObject({
      creditDays: 15,
      creditLimitMinor: 5000,
    })
  })

  test("una cédula que ya existe se omite o se actualiza", async () => {
    await importContacts([{ name: "María", taxId: "V-1234567" }], { apply: true })
    expect((await importContacts([{ name: "María P.", taxId: "v1234567" }])).skipped).toBe(1)
    const updated = await importContacts([{ taxId: "V1234567", phone: "0412-0000000" }], {
      apply: true,
      updateExisting: true,
    })
    expect(updated.updated).toBe(1)
    const all = (await (await h.call("/api/contacts", { cookie: owner })).json()) as Contact[]
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ name: "María", phone: "0412-0000000" })
  })
  test("el saldo de un contacto nuevo queda en Fiado o en Por pagar; a uno existente no", async () => {
    await importContacts([{ name: "Ya estaba", taxId: "V-7654321" }], { apply: true })
    const preview = await importContacts([
      { name: "María Pérez", taxId: "V-12345678", balance: "12,50" },
      { name: "Distribuidora Sol", kind: "Proveedor", balance: 300 },
      { name: "Ambos", kind: "ambos", balance: 5 },
      { name: "Ya estaba", taxId: "V-7654321", balance: 10 },
    ])
    expect(preview).toMatchObject({ created: 2, errors: 1, skipped: 1, debts: 2 })
    expect(preview.rows[2]?.messages).toEqual([
      "Para anotar el saldo, di si es cliente (te debe) o proveedor (le debes)",
    ])
    const applied = await importContacts(
      [
        { name: "María Pérez", taxId: "V-12345678", balance: "12,50" },
        { name: "Distribuidora Sol", kind: "Proveedor", balance: 300 },
        { name: "Sin deuda", balance: 0 },
        { name: "Ya estaba", taxId: "V-7654321", balance: 10 },
      ],
      { apply: true, updateExisting: true },
    )
    expect(applied).toMatchObject({ created: 3, updated: 1, debts: 2 })
    expect(applied.rows[3]?.messages).toEqual([
      "El saldo no se anota a un contacto que ya existe: hazlo en Fiado o en Por pagar",
    ])
    const owed = (await (await h.call("/api/receivables", { cookie: owner })).json()) as {
      customers: { name: string; outstandingMinor: number }[]
    }
    expect(owed.customers).toMatchObject([{ name: "María Pérez", outstandingMinor: 1250 }])
    const owing = (await (await h.call("/api/payables", { cookie: owner })).json()) as {
      suppliers: { name: string; open: { label: string; outstandingMinor: number }[] }[]
    }
    expect(owing.suppliers).toMatchObject([
      { name: "Distribuidora Sol", open: [{ label: "Saldo anterior", outstandingMinor: 30000 }] },
    ])
    expect(checkInvariants(h.db)).toEqual([])
  })
})
