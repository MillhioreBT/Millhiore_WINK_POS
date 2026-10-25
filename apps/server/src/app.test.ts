import { beforeEach, describe, expect, test } from "bun:test"
import { auditLog, paymentMethod, user } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { type Harness, harness, saleBody, setUp, setupBody } from "./testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

describe("asistente inicial", () => {
  test("configura una instalación vacía una sola vez", async () => {
    expect(await (await h.call("/api/setup/status")).json()).toEqual({ configured: false })
    expect((await h.call("/api/setup", { body: setupBody })).status).toBe(201)
    expect(await (await h.call("/api/setup/status")).json()).toEqual({ configured: true })

    const again = await h.call("/api/setup", {
      body: { ...setupBody, owner: { ...setupBody.owner, username: "otra" } },
    })
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
      "ALREADY_CONFIGURED",
    )
    // el segundo intento no deja un usuario huérfano
    expect(h.db.select().from(user).all()).toHaveLength(1)
  })

  test("valida los datos con errores por campo", async () => {
    const res = await h.call("/api/setup", {
      body: { ...setupBody, owner: { ...setupBody.owner, password: "corta" } },
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string; issues: { path: string }[] } }
    expect(body.error.code).toBe("VALIDATION")
    expect(body.error.issues.map((i) => i.path)).toContain("owner.password")
  })

  test("avisa al terminar (para traer la primera tasa) y no si el asistente falla", async () => {
    let calls = 0
    const hooked = harness({ afterSetup: () => calls++ })
    const bad = await hooked.call("/api/setup", {
      body: { ...setupBody, owner: { ...setupBody.owner, password: "corta" } },
    })
    expect(bad.status).toBe(422)
    expect(calls).toBe(0)
    expect((await hooked.call("/api/setup", { body: setupBody })).status).toBe(201)
    expect((await hooked.call("/api/setup", { body: setupBody })).status).toBe(409)
    expect(calls).toBe(1)
  })

  test("guarda la tasa inicial y crea cuentas y métodos de pago", async () => {
    await h.call("/api/setup", { body: setupBody })
    const methods = h.db.select().from(paymentMethod).all()
    expect(methods.map((m) => m.name)).toEqual([
      "Efectivo USD",
      "Efectivo VES",
      "Pago móvil",
      "Punto de venta",
      "Zelle",
    ])
    // Contribuyente ordinario por defecto: no percibe IGTF.
    expect(methods.every((m) => m.surchargeId === null)).toBe(true)
  })

  test("un sujeto pasivo especial cobra IGTF en los métodos en divisas", async () => {
    await h.call("/api/setup", { body: { ...setupBody, taxpayer: "special" } })
    const withIgtf = h.db
      .select()
      .from(paymentMethod)
      .all()
      .filter((m) => m.surchargeId === "igtf")
      .map((m) => m.name)
    expect(withIgtf).toEqual(["Efectivo USD", "Zelle"])
  })
})

describe("impuestos", () => {
  test("la venta devuelve el desglose de IVA e IGTF, y la condición fiscal se puede cambiar", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    const fiscal = await h.call("/api/settings/fiscal", { cookie: owner })
    expect(await fiscal.json()).toEqual({
      taxpayer: "ordinary",
      pricesIncludeTax: true,
      defaultTaxId: "iva-general",
      invoices: false,
    })

    const put = await h.call("/api/settings/fiscal", {
      method: "PUT",
      cookie: owner,
      body: { taxpayer: "special" },
    })
    expect(put.status).toBe(200)

    // Pan 2 × 1,50 con IVA incluido = 3,00 → base 2,59 + IVA 0,41; IGTF 3 % de 3,00 = 0,09
    const usd309 = [{ id: uuidv7(), paymentMethodId: methodUsd, currency: "USD", amountMinor: 309 }]
    const res = await h.call("/api/documents", {
      cookie: owner,
      body: saleBody(terminalId, methodUsd, { payments: usd309 }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      totalMinor: number
      surchargeMinor: number
      taxes: unknown[]
    }
    expect(body).toMatchObject({ totalMinor: 300, surchargeMinor: 9 })
    expect(body.taxes).toEqual([
      expect.objectContaining({ taxId: "iva-general", baseMinor: 259, taxMinor: 41 }),
    ])

    // Al dejar de ser especial, el IGTF se retira de los métodos de cobro.
    await h.call("/api/settings/fiscal", {
      method: "PUT",
      cookie: owner,
      body: { taxpayer: "ordinary" },
    })
    expect(
      h.db
        .select()
        .from(paymentMethod)
        .all()
        .some((m) => m.surchargeId),
    ).toBe(false)
    const audited = h.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.action === "settings.fiscal.updated")
    expect(audited).toHaveLength(2)
  })

  test("cambiar una alícuota exige settings.manage y respeta el tipo de impuesto", async () => {
    const { owner } = await setUp(h)
    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await h.call("/api/taxes", { cookie: cashier })).status).toBe(200)
    const patch = (id: string, body: unknown, cookie = owner) =>
      h.call(`/api/taxes/${id}`, { method: "PATCH", cookie, body })

    expect((await patch("iva-general", { rateBp: 1500 }, cashier)).status).toBe(403)
    const ok = await patch("iva-general", { rateBp: 1500 })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ id: "iva-general", rateBp: 1500, kind: "taxed" })
    expect((await patch("exento", { rateBp: 800 })).status).toBe(422)
    expect((await patch("iva-general", { rateBp: 0 })).status).toBe(422)
    expect((await patch("iva-general", { active: false })).status).toBe(409)
    expect((await patch("nope", { rateBp: 100 })).status).toBe(404)

    const igtf = await h.call("/api/surcharges/igtf", {
      method: "PATCH",
      cookie: owner,
      body: { rateBp: 200 },
    })
    expect(await igtf.json()).toMatchObject({ code: "IGTF", rateBp: 200 })
  })
})

describe("sesión y permisos", () => {
  test("sin sesión las rutas protegidas dan 401, y el registro público no existe", async () => {
    await setUp(h)
    expect((await h.call("/api/me")).status).toBe(401)
    expect((await h.call("/api/documents", { body: {} })).status).toBe(401)
    const signUp = await h.call("/api/auth/sign-up/email", {
      body: { email: "x@y.com", password: "12345678", name: "x", username: "x" },
    })
    expect(signUp.status).toBe(404)
  })

  test("la contraseña incorrecta no inicia sesión", async () => {
    await setUp(h)
    const res = await h.call("/api/auth/sign-in/username", {
      body: { username: "duena", password: "mal-mal-mal" },
    })
    expect(res.status).toBe(401)
  })

  test("/api/me devuelve los permisos del rol", async () => {
    const { owner } = await setUp(h)
    const me = (await (await h.call("/api/me", { cookie: owner })).json()) as {
      username: string
      roleId: string
      permissions: string[]
    }
    expect(me).toMatchObject({ username: "duena", roleId: "owner" })
    expect(me.permissions).toContain("sale.void")
  })

  test("el dueño crea un cajero que puede vender pero no anular ni gestionar usuarios", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    const created = await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    expect(created.status).toBe(201)
    const cashier = await h.login("pedro", "otra-clave-1")

    const sale = await h.call("/api/documents", {
      cookie: cashier,
      body: saleBody(terminalId, methodUsd),
    })
    expect(sale.status).toBe(201)
    const { id } = (await sale.json()) as { id: string }

    const voided = await h.call(`/api/documents/${id}/void`, {
      cookie: cashier,
      body: { reversalId: uuidv7() },
    })
    expect(voided.status).toBe(403)
    expect(((await voided.json()) as { error: { message: string } }).error.message).toContain(
      "sale.void",
    )
    expect((await h.call("/api/users", { cookie: cashier })).status).toBe(403)
    expect((await h.call("/api/users", { cookie: owner })).status).toBe(200)
  })

  test("un usuario desactivado pierde el acceso aunque conserve la cookie", async () => {
    const { owner } = await setUp(h)
    expect((await h.call("/api/me", { cookie: owner })).status).toBe(200)
    h.db.update(user).set({ active: false }).where(eq(user.username, "duena")).run()
    expect((await h.call("/api/me", { cookie: owner })).status).toBe(401)
  })

  test("usuario repetido da 409", async () => {
    const { owner } = await setUp(h)
    const res = await h.call("/api/users", {
      cookie: owner,
      body: { name: "Otra", username: "duena", password: "otra-clave-1", roleId: "cashier" },
    })
    expect(res.status).toBe(409)
  })
})

describe("documentos por HTTP", () => {
  test("contabiliza, es idempotente y se puede anular", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    const body = saleBody(terminalId, methodUsd)

    const first = await h.call("/api/documents", { cookie: owner, body })
    expect(first.status).toBe(201)
    expect(await first.json()).toMatchObject({
      number: "C1-000001",
      totalMinor: 300,
      totalLegalMinor: 10950,
      duplicate: false,
    })

    const again = await h.call("/api/documents", { cookie: owner, body })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ number: "C1-000001", duplicate: true })

    const reversalId = uuidv7()
    const voided = await h.call(`/api/documents/${body.id}/void`, {
      cookie: owner,
      body: { reversalId, reason: "error" },
    })
    expect(voided.status).toBe(201)
    expect(await voided.json()).toMatchObject({ number: "C1-000002", totalMinor: -300 })

    const second = await h.call(`/api/documents/${body.id}/void`, {
      cookie: owner,
      body: { reversalId: uuidv7() },
    })
    expect(second.status).toBe(409)
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      "ALREADY_REVERSED",
    )
  })

  test("errores de dominio salen con código y estado estables", async () => {
    const { owner, terminalId, methodUsd } = await setUp(h)
    const unsettled = await h.call("/api/documents", {
      cookie: owner,
      body: saleBody(terminalId, methodUsd, {
        payments: [{ id: uuidv7(), paymentMethodId: methodUsd, currency: "USD", amountMinor: 100 }],
      }),
    })
    expect(unsettled.status).toBe(422)
    expect(((await unsettled.json()) as { error: { code: string } }).error.code).toBe("UNSETTLED")

    const badId = await h.call("/api/documents", {
      cookie: owner,
      body: saleBody(terminalId, methodUsd, { id: "no-uuid" }),
    })
    expect(badId.status).toBe(422)
    expect(((await badId.json()) as { error: { code: string } }).error.code).toBe("VALIDATION")

    const missing = await h.call(`/api/documents/${uuidv7()}/void`, {
      cookie: owner,
      body: { reversalId: uuidv7() },
    })
    expect(missing.status).toBe(404)
  })
})

describe("OpenAPI y límites", () => {
  test("publica la especificación con las rutas", async () => {
    const res = await h.call("/api/openapi.json")
    expect(res.status).toBe(200)
    const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
    expect(spec.openapi).toBe("3.1.0")
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/api/documents",
        "/api/documents/{id}/void",
        "/api/setup",
        "/api/me",
      ]),
    )
  })

  test("limita los intentos de login (5 por minuto)", async () => {
    const limited = harness({ rateLimit: true })
    await limited.call("/api/setup", { body: setupBody })
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      const res = await limited.call("/api/auth/sign-in/username", {
        body: { username: "duena", password: "incorrecta-1" },
      })
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true)
    expect(statuses.slice(5)).toEqual([429, 429])
  })

  test("el límite de login es por cliente: bloquear a uno no bloquea a los demás", async () => {
    const limited = harness({ rateLimit: true })
    await limited.call("/api/setup", { body: setupBody })
    const wrong = { username: "duena", password: "incorrecta-1" }
    const attempts: number[] = []
    for (let i = 0; i < 6; i++) {
      attempts.push(
        (await limited.call("/api/auth/sign-in/username", { body: wrong, ip: "192.168.1.20" }))
          .status,
      )
    }
    expect(attempts).toEqual([401, 401, 401, 401, 401, 429])
    // otra tablet de la misma red entra sin problema
    const other = await limited.call("/api/auth/sign-in/username", {
      body: { username: "duena", password: "clave-segura-1" },
      ip: "192.168.1.21",
    })
    expect(other.status).toBe(200)
  })

  test("falsear x-forwarded-for no sirve para esquivar el límite", async () => {
    const limited = harness({ rateLimit: true })
    await limited.call("/api/setup", { body: setupBody })
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      const res = await limited.call("/api/auth/sign-in/username", {
        body: { username: "duena", password: "incorrecta-1" },
        ip: "192.168.1.30",
        headers: { "x-forwarded-for": `203.0.113.${i}` },
      })
      statuses.push(res.status)
    }
    expect(statuses.slice(5)).toEqual([429, 429])
  })
})
