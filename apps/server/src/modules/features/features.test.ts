import { beforeEach, describe, expect, test } from "bun:test"
import type { Bootstrap, Features, Onboarding } from "@millhiore/contracts"
import { auditLog, product, variant } from "@millhiore/db"
import { type Harness, harness, NOW, saleBody, setUp, setupBody } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

describe("funciones activables", () => {
  test("las de siempre vienen encendidas; se apagan por partes y la caja lo sabe", async () => {
    const { owner } = await setUp(h)
    const get = async () =>
      (await (await h.call("/api/settings/features", { cookie: owner })).json()) as Features
    expect(await get()).toEqual({
      quotes: true,
      priceLists: true,
      charges: true,
      recurring: true,
      payables: true,
      locations: false,
      lots: false,
      variants: false,
      tables: false,
      modifiers: false,
      kitchen: false,
      recipes: false,
      tips: false,
    })
    const res = await h.call("/api/settings/features", {
      method: "PUT",
      cookie: owner,
      body: { quotes: false, charges: false },
    })
    expect(await res.json()).toMatchObject({ quotes: false, charges: false, priceLists: true })
    const boot = (await (await h.call("/api/bootstrap", { cookie: owner })).json()) as Bootstrap
    expect(boot.features).toMatchObject({ quotes: false, charges: false, recurring: true })
    expect(
      h.db
        .select()
        .from(auditLog)
        .all()
        .map((a) => a.action),
    ).toContain("settings.features.updated")
  })

  test("solo quien maneja los ajustes las cambia", async () => {
    const { owner } = await setUp(h)
    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await h.call("/api/settings/features", { cookie: cashier })).status).toBe(200)
    const put = await h.call("/api/settings/features", {
      method: "PUT",
      cookie: cashier,
      body: { quotes: false },
    })
    expect(put.status).toBe(403)
    expect((await h.call("/api/onboarding", { cookie: cashier })).status).toBe(403)
  })
})

describe("guía para arrancar", () => {
  test("cada paso se marca solo con lo que ya hay en la base", async () => {
    const res = await h.call("/api/setup", { body: setupBody })
    expect(res.status).toBe(201)
    const owner = await h.login("duena", "clave-segura-1")
    const steps = async () => {
      const o = (await (await h.call("/api/onboarding", { cookie: owner })).json()) as Onboarding
      return Object.fromEntries(o.steps.map((s) => [s.id, s.done]))
    }
    // Recién instalado: hay tasa (la inicial del asistente) y nada más.
    expect(await steps()).toEqual({
      business: false,
      rate: true,
      products: false,
      users: false,
      printer: false,
      features: false,
      sale: false,
    })
    await h.call("/api/settings/business", {
      method: "PUT",
      cookie: owner,
      body: { ...setupBody.business, taxId: "J-12345678-9", address: "Av. Bolívar" },
    })
    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    await h.call("/api/settings/features", { method: "PUT", cookie: owner, body: {} })
    h.db
      .insert(product)
      .values({ id: "p1", name: "Pan", kind: "good", tracksStock: true, createdAt: NOW })
      .run()
    h.db
      .insert(variant)
      .values({
        id: "v1",
        productId: "p1",
        sku: "PAN",
        name: "Pan",
        priceMinor: 150,
        priceCurrency: "USD",
        createdAt: NOW,
      })
      .run()
    expect(await steps()).toMatchObject({
      business: true,
      users: true,
      features: true,
      products: true,
      sale: false,
    })
  })

  test("la primera venta completa su paso; la guía se esconde y se vuelve a mostrar", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    await h.call("/api/documents", { cookie: owner, body: saleBody(terminalId, methodUsd) })
    const o = (await (await h.call("/api/onboarding", { cookie: owner })).json()) as Onboarding
    expect(o.steps.find((s) => s.id === "sale")?.done).toBe(true)
    const hidden = await h.call("/api/onboarding", {
      method: "PUT",
      cookie: owner,
      body: { dismissed: true },
    })
    expect(((await hidden.json()) as Onboarding).dismissed).toBe(true)
  })
})
