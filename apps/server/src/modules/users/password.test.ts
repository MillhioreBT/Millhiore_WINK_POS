import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Me, UserRow } from "@millhiore/contracts"
import { authAccount, createDb, migrateDb, role, seedRoles, user } from "@millhiore/db"
import { eq } from "drizzle-orm"
import { resetPasswordCli } from "../../cli/reset-password"
import { createAuth, verifyPassword } from "../../infra/auth"
import { type Harness, harness, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

const OWNER_PASS = "clave-segura-1"

async function newUser(owner: string, username: string, roleId: string, password = "otra-clave-1") {
  const res = await h.call("/api/users", {
    cookie: owner,
    body: { name: username, username, password, roleId },
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

const changeOwn = (cookie: string, body: Record<string, unknown>) =>
  h.call("/api/me/password", { cookie, body })

describe("cambiar la propia contraseña", () => {
  test("exige la actual, aplica las reglas y cierra las otras sesiones", async () => {
    const { owner } = await setUp(h)
    const phone = await h.login("duena", OWNER_PASS) // otra sesión (el celular)

    expect(
      (await changeOwn(owner, { currentPassword: "no-es", newPassword: "Nueva.Clave.77" })).status,
    ).toBe(422)
    const weak = await changeOwn(owner, { currentPassword: OWNER_PASS, newPassword: "12345678" })
    expect(weak.status).toBe(422)
    expect(((await weak.json()) as { error: { message: string } }).error.message).toMatch(/común/)
    const same = await changeOwn(owner, { currentPassword: OWNER_PASS, newPassword: OWNER_PASS })
    expect(same.status).toBe(422)

    const ok = await changeOwn(owner, {
      currentPassword: OWNER_PASS,
      newPassword: "Nueva.Clave.77",
    })
    expect(ok.status).toBe(200)
    expect((await h.call("/api/me", { cookie: owner })).status).toBe(200) // esta sigue abierta
    expect((await h.call("/api/me", { cookie: phone })).status).toBe(401) // la del celular no
    await expect(h.login("duena", OWNER_PASS)).rejects.toThrow()
    await h.login("duena", "Nueva.Clave.77")
  })

  test("se puede mantener abiertas las demás sesiones", async () => {
    const { owner } = await setUp(h)
    const phone = await h.login("duena", OWNER_PASS)
    const res = await changeOwn(owner, {
      currentPassword: OWNER_PASS,
      newPassword: "Nueva.Clave.77",
      signOutOthers: false,
    })
    expect(res.status).toBe(200)
    expect((await h.call("/api/me", { cookie: phone })).status).toBe(200)
  })

  test("cinco intentos fallidos bloquean el cambio un rato", async () => {
    const { owner } = await setUp(h)
    for (let i = 0; i < 5; i++) {
      await changeOwn(owner, { currentPassword: `mala-${i}`, newPassword: "Nueva.Clave.77" })
    }
    const blocked = await changeOwn(owner, {
      currentPassword: OWNER_PASS,
      newPassword: "Nueva.Clave.77",
    })
    expect(blocked.status).toBe(429)
  })

  test("las rutas de Better Auth para cambiar contraseñas están cerradas", async () => {
    const { owner } = await setUp(h)
    const res = await h.call("/api/auth/change-password", {
      cookie: owner,
      body: { currentPassword: OWNER_PASS, newPassword: "12345678" },
    })
    expect(res.status).toBe(404)
  })
})

describe("el dueño restablece la de otro", () => {
  test("temporal: cierra sus sesiones y lo obliga a elegir una propia antes de seguir", async () => {
    const { owner } = await setUp(h)
    const id = await newUser(owner, "pedro", "cashier")
    const pedro = await h.login("pedro", "otra-clave-1")

    const reset = await h.call(`/api/users/${id}/password`, {
      cookie: owner,
      body: { temporaryPassword: "temp-abcd-2345" },
    })
    expect(reset.status).toBe(200)
    expect((await h.call("/api/me", { cookie: pedro })).status).toBe(401)

    const temp = await h.login("pedro", "temp-abcd-2345")
    const me = (await (await h.call("/api/me", { cookie: temp })).json()) as Me
    expect(me.mustChangePassword).toBe(true)
    const blocked = await h.call("/api/products", { cookie: temp })
    expect(blocked.status).toBe(403)
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe(
      "PASSWORD_CHANGE_REQUIRED",
    )
    const users = (await (await h.call("/api/users", { cookie: owner })).json()) as UserRow[]
    expect(users.find((u) => u.id === id)?.mustChangePassword).toBe(true)

    const chosen = await changeOwn(temp, {
      currentPassword: "temp-abcd-2345",
      newPassword: "Mi.Propia.Clave.9",
    })
    expect(chosen.status).toBe(200)
    expect((await h.call("/api/products", { cookie: temp })).status).toBe(200)
  })

  test("protecciones: la propia cuenta, los dueños y el último dueño", async () => {
    const { owner } = await setUp(h)
    const ownerId = h.db.select().from(user).where(eq(user.username, "duena")).get()?.id ?? ""

    // La propia se cambia en «Mi cuenta».
    const own = await h.call(`/api/users/${ownerId}/password`, {
      cookie: owner,
      body: { temporaryPassword: "temp-abcd-2345" },
    })
    expect(own.status).toBe(409)

    // Un supervisor con user.manage no toca a un dueño.
    h.db
      .insert(role)
      .values({ id: "supervisor", name: "Supervisor", permissions: ["user.manage"] })
      .run()
    await newUser(owner, "sara", "supervisor")
    const sara = await h.login("sara", "otra-clave-1")
    const onOwner = await h.call(`/api/users/${ownerId}/password`, {
      cookie: sara,
      body: { temporaryPassword: "temp-abcd-2345" },
    })
    expect(onOwner.status).toBe(403)
    const promote = await h.call(`/api/users/${ownerId}`, {
      method: "PATCH",
      cookie: sara,
      body: { active: false },
    })
    expect(promote.status).toBe(403)

    // Nunca sin un dueño activo.
    const demoteSelf = await h.call(`/api/users/${ownerId}`, {
      method: "PATCH",
      cookie: owner,
      body: { roleId: "cashier" },
    })
    expect(demoteSelf.status).toBe(409)
    const deactivateSelf = await h.call(`/api/users/${ownerId}`, {
      method: "PATCH",
      cookie: owner,
      body: { active: false },
    })
    expect(deactivateSelf.status).toBe(409)

    // Con un segundo dueño, sí se puede cambiar el rol del primero.
    const second = await newUser(owner, "luis", "owner")
    const luis = await h.login("luis", "otra-clave-1")
    const demote = await h.call(`/api/users/${ownerId}`, {
      method: "PATCH",
      cookie: luis,
      body: { roleId: "manager", name: "Dueña (encargada)" },
    })
    expect(demote.status).toBe(200)
    expect(((await demote.json()) as UserRow).roleId).toBe("manager")
    // …pero luis ya es el único dueño: no se puede desactivar.
    const lastOne = await h.call(`/api/users/${second}`, {
      method: "PATCH",
      cookie: luis,
      body: { active: false },
    })
    expect(lastOne.status).toBe(409)
  })

  test("desactivar cierra sus sesiones", async () => {
    const { owner } = await setUp(h)
    const id = await newUser(owner, "pedro", "cashier")
    const pedro = await h.login("pedro", "otra-clave-1")
    const res = await h.call(`/api/users/${id}`, {
      method: "PATCH",
      cookie: owner,
      body: { active: false },
    })
    expect(res.status).toBe(200)
    expect((await h.call("/api/me", { cookie: pedro })).status).toBe(401)
    await expect(h.login("pedro", "otra-clave-1")).resolves.toBeDefined() // entra, pero…
    expect(
      (await h.call("/api/me", { cookie: await h.login("pedro", "otra-clave-1") })).status,
    ).toBe(401) // …la sesión de un inactivo no sirve
  })
})

describe("recuperación desde la PC del servidor", () => {
  const dirs: string[] = []
  afterEach(() => {
    Bun.gc(true)
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
  })

  test("genera una temporal, cierra sesiones y obliga a cambiarla", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "millhiore-cli-"))
    dirs.push(dataDir)
    const db = createDb(join(dataDir, "millhiore.db"))
    migrateDb(db)
    seedRoles(db)
    const auth = createAuth(db, {
      secret: "test-secret-test-secret-test-secret-1234",
      baseURL: "http://localhost:3000",
      rateLimit: false,
    })
    const created = await auth.api.signUpEmail({
      body: {
        name: "Dueña",
        email: "duena@usuarios.millhiore.local",
        password: OWNER_PASS,
        username: "duena",
      },
    })
    db.update(user).set({ roleId: "owner" }).where(eq(user.id, created.user.id)).run()
    db.$client.close()
    Bun.gc(true)

    const out: string[] = []
    const info = spyOn(console, "info").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "))
    })
    try {
      expect(await resetPasswordCli(["duena", "--data", dataDir], {})).toBe(0)
      expect(await resetPasswordCli(["nadie", "--data", dataDir], {})).toBe(1)
    } finally {
      info.mockRestore()
    }
    const temporary = out.join("\n").match(/[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}/)?.[0] ?? ""
    expect(temporary).not.toBe("")

    Bun.gc(true)
    const after = createDb(join(dataDir, "millhiore.db"))
    const row = after.select().from(user).where(eq(user.username, "duena")).get()
    const account = after
      .select()
      .from(authAccount)
      .where(eq(authAccount.userId, row?.id ?? ""))
      .get()
    expect(row?.mustChangePassword).toBe(true)
    expect(await verifyPassword(temporary, account?.password ?? "")).toBe(true)
    after.$client.close()
  })
})
