import { beforeEach, describe, expect, test } from "bun:test"
import type { Bootstrap, Me } from "@millhiore/contracts"
import { auditLog, user } from "@millhiore/db"
import { eq } from "drizzle-orm"
import { type Harness, harness, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const PASSWORD = "clave-segura-1"
const put = (cookie: string, body: unknown) =>
  h.call("/api/me/pin", { cookie, method: "PUT", body })
const verify = (cookie: string, pin: string) =>
  h.call("/api/me/pin/verify", { cookie, body: { pin } })
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

describe("PIN de caja", () => {
  test("se pone con la contraseña, se guarda cifrado y /api/me lo refleja", async () => {
    const { owner } = await setUp(h)
    expect(((await (await h.call("/api/me", { cookie: owner })).json()) as Me).hasPin).toBe(false)

    expect((await put(owner, { currentPassword: PASSWORD, pin: "4821" })).status).toBe(200)
    expect(((await (await h.call("/api/me", { cookie: owner })).json()) as Me).hasPin).toBe(true)

    const stored = h.db.select({ pin: user.pinHash }).from(user).get()?.pin
    expect(stored).toMatch(/^\$argon2id\$/)
    expect(stored).not.toContain("4821")
    const audits = h.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.action.startsWith("user.pin"))
    expect(audits.map((a) => a.action)).toEqual(["user.pin.set"])
    expect(JSON.stringify(audits)).not.toContain("4821")
  })

  test("pide la contraseña correcta y rechaza PIN débiles", async () => {
    const { owner } = await setUp(h)
    const wrong = await put(owner, { currentPassword: "otra", pin: "4821" })
    expect(wrong.status).toBe(422)
    expect(await errorCode(wrong)).toBe("WRONG_PASSWORD")

    for (const pin of ["1234", "4321", "0000", "999999", "12", "1234567", "12a4", ""]) {
      const res = await put(owner, { currentPassword: PASSWORD, pin })
      expect(res.status).toBe(pin === "" ? 422 : 422)
    }
    expect(((await (await h.call("/api/me", { cookie: owner })).json()) as Me).hasPin).toBe(false)
  })

  test("verifica el PIN y no abre ni cambia sesiones", async () => {
    const { owner } = await setUp(h)
    // Sin PIN no hay nada que verificar.
    expect(await errorCode(await verify(owner, "4821"))).toBe("NO_PIN")
    await put(owner, { currentPassword: PASSWORD, pin: "4821" })
    expect((await verify(owner, "4821")).status).toBe(200)
    const bad = await verify(owner, "1111")
    expect(bad.status).toBe(401)
    expect(await errorCode(bad)).toBe("WRONG_PIN")
    expect((await h.call("/api/me", { cookie: owner })).status).toBe(200)
    expect((await h.call("/api/me/pin/verify", { body: { pin: "4821" } })).status).toBe(401)
  })

  test("cinco errores bloquean la comprobación un rato y luego se libera", async () => {
    const { owner } = await setUp(h)
    await put(owner, { currentPassword: PASSWORD, pin: "4821" })
    for (let i = 0; i < 5; i++) expect((await verify(owner, "1111")).status).toBe(401)
    const locked = await verify(owner, "4821") // aun el correcto
    expect(locked.status).toBe(429)
    expect(await errorCode(locked)).toBe("PIN_LOCKED")
    h.clock.now += 5 * 60_000 + 1000
    expect((await verify(owner, "4821")).status).toBe(200)
  })

  test("se quita con pin = null y restablecer la contraseña también lo borra", async () => {
    const { owner } = await setUp(h)
    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const pedro = await h.login("pedro", "otra-clave-1")
    await put(pedro, { currentPassword: "otra-clave-1", pin: "7392" })
    const pedroId = h.db.select().from(user).where(eq(user.username, "pedro")).get()?.id ?? ""

    // El dueño restablece la contraseña de Pedro: su PIN deja de valer.
    await h.call(`/api/users/${pedroId}/password`, {
      cookie: owner,
      body: { temporaryPassword: "temporal-2026-xk" },
    })
    expect(h.db.select().from(user).where(eq(user.id, pedroId)).get()?.pinHash).toBeNull()

    // Quitar el propio PIN.
    await put(owner, { currentPassword: PASSWORD, pin: "4821" })
    expect((await put(owner, { currentPassword: PASSWORD, pin: null })).status).toBe(200)
    expect(((await (await h.call("/api/me", { cookie: owner })).json()) as Me).hasPin).toBe(false)
  })

  test("el bloqueo automático lo configura quien tiene settings.manage y llega a la caja", async () => {
    const { owner } = await setUp(h)
    const boot = async () =>
      ((await (await h.call("/api/bootstrap", { cookie: owner })).json()) as Bootstrap).security
    expect(await boot()).toEqual({ autoLockMinutes: 0 })
    const res = await h.call("/api/settings/security", {
      cookie: owner,
      method: "PUT",
      body: { autoLockMinutes: 5 },
    })
    expect(res.status).toBe(200)
    expect(await boot()).toEqual({ autoLockMinutes: 5 })
    expect(
      (
        await h.call("/api/settings/security", {
          cookie: owner,
          method: "PUT",
          body: { autoLockMinutes: 9999 },
        })
      ).status,
    ).toBe(422)

    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect(
      (
        await h.call("/api/settings/security", {
          cookie: cashier,
          method: "PUT",
          body: { autoLockMinutes: 1 },
        })
      ).status,
    ).toBe(403)
    expect((await h.call("/api/settings/security", { cookie: cashier })).status).toBe(200)
  })
})
