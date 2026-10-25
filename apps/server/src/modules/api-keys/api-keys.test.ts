import { beforeEach, describe, expect, test } from "bun:test"
import type { ApiKey, CreatedApiKey, DocumentDetail } from "@millhiore/contracts"
import { auditLog } from "@millhiore/db"
import { eq } from "drizzle-orm"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"

let h: Harness
let s: Awaited<ReturnType<typeof setUp>>
beforeEach(async () => {
  h = harness()
  s = await setUp(h)
})

async function json<T>(res: Response, status = 200): Promise<T> {
  if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

const createKey = (permissions: string[], cookie = s.owner, name = "Tienda en línea") =>
  h.call("/api/api-keys", { cookie, body: { name, permissions } })

/** Una petición de otro sistema, con la clave en la cabecera. */
const withKey = (secret: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.call(path, { ...init, headers: { authorization: `Bearer ${secret}` } })

describe("claves de la API", () => {
  test("se crea con sus permisos y el secreto se ve una sola vez", async () => {
    const created = await json<CreatedApiKey>(
      await createKey(["inventory.view", "sale.create"]),
      201,
    )
    expect(created.secret).toMatch(/^mwk_[\w-]{32}$/)
    expect(created.key).toMatchObject({
      name: "Tienda en línea",
      prefix: created.secret.slice(0, 12),
      permissions: ["inventory.view", "sale.create"],
      userName: "Dueña",
      lastUsedAt: null,
      revokedAt: null,
    })
    const list = await json<ApiKey[]>(await h.call("/api/api-keys", { cookie: s.owner }))
    expect(list).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(created.secret)
    // La bitácora no guarda el secreto ni su hash.
    const logged = h.db.select().from(auditLog).where(eq(auditLog.action, "api_key.created")).all()
    expect(logged).toHaveLength(1)
    expect(JSON.stringify(logged)).not.toContain(created.secret)
    expect(JSON.stringify(logged)).not.toContain("secretHash")
  })

  test("otro sistema lee y vende con la clave, como quien la creó", async () => {
    const { secret, key } = await json<CreatedApiKey>(
      await createKey(["inventory.view", "sale.create"]),
      201,
    )
    expect((await withKey(secret, "/api/products")).status).toBe(200)
    const res = await withKey(secret, "/api/documents", {
      method: "POST",
      body: saleBody(s.terminalId, s.methodUsd),
    })
    const posted = await json<{ id: string }>(res, 201)
    const doc = await json<DocumentDetail>(
      await h.call(`/api/documents/${posted.id}`, { cookie: s.owner }),
    )
    expect(doc.createdBy).toBe("Dueña")
    // Sabe cuándo se usó por última vez.
    const [listed] = await json<ApiKey[]>(await h.call("/api/api-keys", { cookie: s.owner }))
    expect(listed?.id).toBe(key.id)
    expect(listed?.lastUsedAt).toBe(h.clock.now)
  })

  test("solo puede lo que se le dio", async () => {
    const { secret } = await json<CreatedApiKey>(await createKey(["inventory.view"]), 201)
    const sale = await withKey(secret, "/api/documents", {
      method: "POST",
      body: saleBody(s.terminalId, s.methodUsd),
    })
    expect(sale.status).toBe(403)
    // Nunca la contraseña, las sesiones, los usuarios ni otras claves.
    for (const path of ["/api/me", "/api/sessions", "/api/users", "/api/api-keys"]) {
      expect((await withKey(secret, path)).status).toBe(403)
    }
  })

  test("una clave revocada, inventada o de un usuario inactivo no entra", async () => {
    const { secret, key } = await json<CreatedApiKey>(await createKey(["inventory.view"]), 201)
    expect((await withKey("mwk_inventada", "/api/products")).status).toBe(401)
    expect((await withKey("otra-cosa", "/api/products")).status).toBe(401)
    const revoked = await json<ApiKey>(
      await h.call(`/api/api-keys/${key.id}/revoke`, { cookie: s.owner, method: "POST" }),
    )
    expect(revoked.revokedAt).toBe(h.clock.now)
    expect((await withKey(secret, "/api/products")).status).toBe(401)

    // Otra dueña crea una clave y después la desactivan: su clave deja de funcionar.
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Socia", username: "socia", password: "otra-clave-1", roleId: "owner" },
    })
    const partner = await h.login("socia", "otra-clave-1")
    const other = await json<CreatedApiKey>(
      await createKey(["inventory.view"], partner, "Script"),
      201,
    )
    expect((await withKey(other.secret, "/api/products")).status).toBe(200)
    const users = await json<{ id: string; username: string }[]>(
      await h.call("/api/users", { cookie: s.owner }),
    )
    const socia = users.find((u) => u.username === "socia")
    await h.call(`/api/users/${socia?.id}`, {
      method: "PATCH",
      cookie: s.owner,
      body: { active: false },
    })
    expect((await withKey(other.secret, "/api/products")).status).toBe(401)
  })

  test("no se dan permisos de usuarios ni ajustes, y crear claves exige settings.manage", async () => {
    expect((await createKey(["user.manage"])).status).toBe(422)
    expect((await createKey(["settings.manage"])).status).toBe(422)
    expect((await createKey([])).status).toBe(422)
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Admin", username: "admin", password: "otra-clave-1", roleId: "manager" },
    })
    const manager = await h.login("admin", "otra-clave-1")
    expect((await createKey(["inventory.view"], manager)).status).toBe(403)
  })
})
