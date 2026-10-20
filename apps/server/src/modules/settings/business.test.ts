import { beforeEach, describe, expect, test } from "bun:test"
import type { Bootstrap, BusinessProfile } from "@millhiore/contracts"
import { type Harness, harness, setupBody } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

describe("datos del negocio", () => {
  test("el RIF del asistente se normaliza y llega a la caja; se editan desde Ajustes", async () => {
    const res = await h.call("/api/setup", {
      body: { ...setupBody, business: { name: "Bodega", taxId: "j123456789" } },
    })
    expect(res.status).toBe(201)
    const owner = await h.login("duena", "clave-segura-1")

    const boot = (await (await h.call("/api/bootstrap", { cookie: owner })).json()) as Bootstrap
    expect(boot.business).toMatchObject({ name: "Bodega", taxId: "J-12345678-9", address: null })

    const put = await h.call("/api/settings/business", {
      method: "PUT",
      cookie: owner,
      body: {
        name: "Bodega La Esquina",
        address: "Av. Bolívar, local 3, Valencia",
        phone: "0241-5550000",
        receiptFooter: "  Vuelva pronto  ",
      },
    })
    expect(put.status).toBe(200)
    expect((await put.json()) as BusinessProfile).toEqual({
      name: "Bodega La Esquina",
      taxId: "J-12345678-9",
      address: "Av. Bolívar, local 3, Valencia",
      phone: "0241-5550000",
      receiptFooter: "Vuelva pronto",
    })

    // Vaciar un dato lo borra; un RIF mal escrito se rechaza.
    const cleared = await h.call("/api/settings/business", {
      method: "PUT",
      cookie: owner,
      body: { phone: "", taxId: null },
    })
    expect((await cleared.json()) as BusinessProfile).toMatchObject({ phone: null, taxId: null })
    const bad = await h.call("/api/settings/business", {
      method: "PUT",
      cookie: owner,
      body: { taxId: "12345" },
    })
    expect(bad.status).toBe(422)
  })

  test("solo settings.manage los cambia", async () => {
    await h.call("/api/setup", { body: setupBody })
    const owner = await h.login("duena", "clave-segura-1")
    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await h.call("/api/settings/business", { cookie: cashier })).status).toBe(200)
    const put = await h.call("/api/settings/business", {
      method: "PUT",
      cookie: cashier,
      body: { name: "Otra" },
    })
    expect(put.status).toBe(403)
  })
})
