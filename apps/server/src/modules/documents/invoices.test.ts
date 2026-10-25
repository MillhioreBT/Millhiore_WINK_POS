import { beforeEach, describe, expect, test } from "bun:test"
import type { DocumentDetail, DocumentSummary, TaxBook } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import { type Harness, harness, NOW, saleBody, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const json = async <T>(res: Response | Promise<Response>): Promise<T> =>
  (await (await res).json()) as T
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

async function customer(owner: string, taxId = "V12345678") {
  const res = await h.call("/api/contacts", {
    cookie: owner,
    body: { kind: "customer", name: "María Pérez", taxId, address: "Av. Bolívar, Maracay" },
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

async function sell(owner: string, terminalId: string, methodUsd: string, over = {}) {
  const res = await h.call("/api/documents", {
    cookie: owner,
    body: saleBody(terminalId, methodUsd, over),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; number: string }
}

const detail = (cookie: string, id: string) =>
  json<DocumentDetail>(h.call(`/api/documents/${id}`, { cookie }))

const salesBook = (cookie: string) =>
  json<TaxBook>(
    h.call(`/api/reports/tax-book?kind=sales&from=${NOW - 86_400_000}&to=${NOW + 86_400_000}`, {
      cookie,
    }),
  )

describe("datos fiscales del cliente", () => {
  test("quedan en la venta tal como eran: cambiar el contacto después no la cambia", async () => {
    const s = await setUp(h)
    const maria = await customer(s.owner)
    const sale = await sell(s.owner, s.terminalId, s.methodUsd, { contactId: maria.id })
    const res = await h.call(`/api/contacts/${maria.id}`, {
      method: "PATCH",
      cookie: s.owner,
      body: { taxId: "V87654321", address: "Otra dirección" },
    })
    expect(res.status).toBe(200)
    const doc = await detail(s.owner, sale.id)
    expect(doc).toMatchObject({
      contactName: "María Pérez",
      contactTaxId: "V-12345678",
      contactAddress: "Av. Bolívar, Maracay",
      invoiceRequested: false,
      invoice: null,
    })
    const book = await salesBook(s.owner)
    expect(book.rows[0]).toMatchObject({ contactTaxId: "V-12345678", invoiceNumber: null })
  })

  test("se pueden escribir en la caja sin guardar al cliente", async () => {
    const s = await setUp(h)
    const sale = await sell(s.owner, s.terminalId, s.methodUsd, {
      customer: { name: "Inversiones El Sol, C.A.", taxId: "j123456789" },
    })
    const doc = await detail(s.owner, sale.id)
    expect(doc).toMatchObject({
      contactId: null,
      contactName: "Inversiones El Sol, C.A.",
      contactTaxId: "J-12345678-9",
      contactAddress: null,
    })
  })
})

describe("venta con factura", () => {
  test("pide el nombre y la cédula o el RIF, y queda por anotar hasta que se anotan sus números", async () => {
    const s = await setUp(h)
    let res = await h.call("/api/documents", {
      cookie: s.owner,
      body: saleBody(s.terminalId, s.methodUsd, { invoice: true }),
    })
    expect(res.status).toBe(422)
    expect(await errorCode(res)).toBe("CUSTOMER_REQUIRED")
    const maria = await customer(s.owner)
    const plain = await sell(s.owner, s.terminalId, s.methodUsd)
    const sale = await sell(s.owner, s.terminalId, s.methodUsd, {
      contactId: maria.id,
      invoice: true,
    })
    let pending = await json<DocumentSummary[]>(
      h.call("/api/documents?type=SALE&invoice=pending", { cookie: s.owner }),
    )
    expect(pending.map((d) => d.id)).toEqual([sale.id])

    // Una nota de venta sin datos del cliente no lleva factura.
    res = await h.call(`/api/documents/${plain.id}/invoice`, {
      method: "PUT",
      cookie: s.owner,
      body: { invoiceNumber: "000123", controlNumber: "00-000123" },
    })
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe("CUSTOMER_REQUIRED")

    res = await h.call(`/api/documents/${sale.id}/invoice`, {
      method: "PUT",
      cookie: s.owner,
      body: { invoiceNumber: " 000123 ", controlNumber: "00-000123" },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as DocumentDetail).invoice).toMatchObject({
      invoiceNumber: "000123",
      controlNumber: "00-000123",
      recordedAt: NOW,
    })
    pending = await json<DocumentSummary[]>(
      h.call("/api/documents?type=SALE&invoice=pending", { cookie: s.owner }),
    )
    expect(pending).toEqual([])
    const book = await salesBook(s.owner)
    expect(book.rows.find((r) => r.id === sale.id)).toMatchObject({
      invoiceNumber: "000123",
      controlNumber: "00-000123",
      contactTaxId: "V-12345678",
    })

    // El número de control no se repite.
    const other = await sell(s.owner, s.terminalId, s.methodUsd, {
      customer: { name: "Pedro", taxId: "V1" },
      invoice: true,
    })
    res = await h.call(`/api/documents/${other.id}/invoice`, {
      method: "PUT",
      cookie: s.owner,
      body: { invoiceNumber: "000124", controlNumber: "00-000123" },
    })
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe("CONTROL_TAKEN")
  })

  test("cambiar los números pide poder anular; una venta anulada ya no se factura", async () => {
    const s = await setUp(h)
    const created = await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Ana", username: "ana", password: "otra-clave-1", roleId: "cashier" },
    })
    expect(created.status).toBe(201)
    const ana = await h.login("ana", "otra-clave-1")
    const sale = await sell(s.owner, s.terminalId, s.methodUsd, {
      customer: { name: "Pedro", taxId: "V1" },
      invoice: true,
    })
    let res = await h.call(`/api/documents/${sale.id}/invoice`, {
      method: "PUT",
      cookie: ana,
      body: { invoiceNumber: "1", controlNumber: "00-1" },
    })
    expect(res.status).toBe(200)
    res = await h.call(`/api/documents/${sale.id}/invoice`, {
      method: "PUT",
      cookie: ana,
      body: { invoiceNumber: "2", controlNumber: "00-2" },
    })
    expect(res.status).toBe(403)
    res = await h.call(`/api/documents/${sale.id}/invoice`, {
      method: "PUT",
      cookie: s.owner,
      body: { invoiceNumber: "2", controlNumber: "00-2" },
    })
    expect(res.status).toBe(200)
    const audit = h.db.$client
      .query(
        "select action from audit_log where entity_id = ? and action like 'document.invoice.%' order by rowid",
      )
      .all(sale.id) as { action: string }[]
    expect(audit.map((a) => a.action)).toEqual([
      "document.invoice.recorded",
      "document.invoice.changed",
    ])

    const pendingSale = await sell(s.owner, s.terminalId, s.methodUsd, {
      customer: { name: "Pedro", taxId: "V1" },
      invoice: true,
    })
    res = await h.call(`/api/documents/${pendingSale.id}/void`, {
      cookie: s.owner,
      body: { reversalId: uuidv7() },
    })
    expect(res.status).toBe(201)
    const pending = await json<DocumentSummary[]>(
      h.call("/api/documents?invoice=pending", { cookie: s.owner }),
    )
    expect(pending).toEqual([])
    res = await h.call(`/api/documents/${pendingSale.id}/invoice`, {
      method: "PUT",
      cookie: s.owner,
      body: { invoiceNumber: "3", controlNumber: "00-3" },
    })
    expect(res.status).toBe(409)
  })

  test("solo una venta lleva factura, y la caja la ofrece si el negocio la activa", async () => {
    const s = await setUp(h)
    const res = await h.call("/api/documents", {
      cookie: s.owner,
      body: {
        id: uuidv7(),
        type: "PURCHASE",
        terminalId: s.terminalId,
        currency: "USD",
        rate: { base: "USD", quote: "VES", value: "36.5" },
        customer: { name: "Distribuidora", taxId: "J1" },
        invoice: true,
        lines: [{ variantId: "v1", qtyMilli: 1000, unitPriceMinor: 100 }],
        payments: [
          { id: uuidv7(), paymentMethodId: s.methodUsd, currency: "USD", amountMinor: 100 },
        ],
      },
    })
    expect(res.status).toBe(422)

    const fiscal = await json<{ invoices: boolean }>(
      h.call("/api/settings/fiscal", { cookie: s.owner }),
    )
    expect(fiscal.invoices).toBe(false)
    const after = await json<{ invoices: boolean }>(
      h.call("/api/settings/fiscal", { method: "PUT", cookie: s.owner, body: { invoices: true } }),
    )
    expect(after.invoices).toBe(true)
  })
})
