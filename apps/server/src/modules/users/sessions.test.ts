import { beforeEach, describe, expect, test } from "bun:test"
import type { AuditEntry, SessionRow } from "@millhiore/contracts"
import { type Harness, harness, setUp } from "../../testing/harness"

let h: Harness
beforeEach(() => {
  h = harness()
})

async function newUser(owner: string, username: string, roleId: string) {
  const res = await h.call("/api/users", {
    cookie: owner,
    body: { name: username, username, password: "otra-clave-1", roleId },
  })
  expect(res.status).toBe(201)
}

const sessions = async (cookie: string, all = false) => {
  const res = await h.call(`/api/sessions${all ? "?all=true" : ""}`, { cookie })
  expect(res.status).toBe(200)
  return (await res.json()) as SessionRow[]
}
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

describe("sesiones activas", () => {
  test("cada quien ve las suyas, marca la actual y nunca expone el token", async () => {
    const { owner } = await setUp(h)
    await newUser(owner, "cajera", "cashier")
    const cashier = await h.login("cajera", "otra-clave-1")
    await h.login("duena", "clave-segura-1") // el celular de la dueña

    const mine = await sessions(owner)
    expect(mine).toHaveLength(3 - 1) // las dos de la dueña, ninguna de la cajera
    expect(mine.filter((s) => s.current)).toHaveLength(1)
    expect(mine.every((s) => s.userName === "Dueña")).toBe(true)
    expect(JSON.stringify(mine)).not.toContain("token")

    expect(await sessions(cashier)).toHaveLength(1)
    // Ver las de todos pide user.manage.
    expect((await h.call("/api/sessions?all=true", { cookie: cashier })).status).toBe(403)
    expect(await sessions(owner, true)).toHaveLength(3)
  })

  test("las vencidas no salen", async () => {
    const { owner } = await setUp(h)
    expect(await sessions(owner)).toHaveLength(1)
    // Better Auth fija el vencimiento (30 días) con el reloj real; el servidor usa el del arnés,
    // que se adelanta más allá de ese vencimiento.
    h.clock.now = Date.now() + 31 * 24 * 3_600_000
    expect(await sessions(owner)).toHaveLength(0)
  })

  test("cierra una sesión ajena a la actual, y queda en la bitácora", async () => {
    const { owner } = await setUp(h)
    const phone = await h.login("duena", "clave-segura-1")
    const other = (await sessions(owner)).find((s) => !s.current)
    if (!other) throw new Error("falta la segunda sesión")

    expect(
      (await h.call(`/api/sessions/${other.id}`, { cookie: owner, method: "DELETE" })).status,
    ).toBe(200)
    expect((await h.call("/api/me", { cookie: phone })).status).toBe(401)
    expect((await h.call("/api/me", { cookie: owner })).status).toBe(200)
    expect(
      (await h.call(`/api/sessions/${other.id}`, { cookie: owner, method: "DELETE" })).status,
    ).toBe(404)

    const audit = (await (
      await h.call("/api/audit?action=session.", { cookie: owner })
    ).json()) as AuditEntry[]
    expect(audit.map((a) => a.action)).toEqual(["session.revoked"])
    expect(audit[0]).toMatchObject({ entityId: other.id, actorName: "Dueña" })
    expect(JSON.stringify(audit)).not.toContain("token")
  })

  test("la sesión actual no se cierra por aquí", async () => {
    const { owner } = await setUp(h)
    const current = (await sessions(owner)).find((s) => s.current)
    if (!current) throw new Error("falta la sesión actual")
    const res = await h.call(`/api/sessions/${current.id}`, { cookie: owner, method: "DELETE" })
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe("CURRENT_SESSION")
    expect((await h.call("/api/me", { cookie: owner })).status).toBe(200)
  })

  test("nadie cierra las sesiones de otro sin user.manage; el dueño sí", async () => {
    const { owner } = await setUp(h)
    await newUser(owner, "cajera", "cashier")
    await newUser(owner, "almacen", "warehouse")
    const cashier = await h.login("cajera", "otra-clave-1")
    const warehouse = await h.login("almacen", "otra-clave-1")
    const target = (await sessions(owner, true)).find((s) => s.userName === "cajera")
    if (!target) throw new Error("falta la sesión de la cajera")

    const denied = await h.call(`/api/sessions/${target.id}`, {
      cookie: warehouse,
      method: "DELETE",
    })
    expect(denied.status).toBe(403)
    expect((await h.call("/api/me", { cookie: cashier })).status).toBe(200)

    expect(
      (await h.call(`/api/sessions/${target.id}`, { cookie: owner, method: "DELETE" })).status,
    ).toBe(200)
    expect((await h.call("/api/me", { cookie: cashier })).status).toBe(401)
  })

  test("«cerrar las demás» deja solo la actual y no toca las de otras personas", async () => {
    const { owner } = await setUp(h)
    await newUser(owner, "cajera", "cashier")
    const cashier = await h.login("cajera", "otra-clave-1")
    await h.login("duena", "clave-segura-1")
    await h.login("duena", "clave-segura-1")
    expect(await sessions(owner)).toHaveLength(3)

    const res = await h.call("/api/sessions/close-others", { cookie: owner, body: {} })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { closed: number }).closed).toBe(2)
    expect(await sessions(owner)).toHaveLength(1)
    expect((await h.call("/api/me", { cookie: cashier })).status).toBe(200)
    // Sin otras sesiones no hay nada que cerrar ni que registrar.
    const again = await h.call("/api/sessions/close-others", { cookie: owner, body: {} })
    expect(((await again.json()) as { closed: number }).closed).toBe(0)
  })
})

describe("bitácora", () => {
  test("pide audit.view y la lee de más reciente a más antigua", async () => {
    const { owner } = await setUp(h)
    await newUser(owner, "cajera", "cashier")
    const cashier = await h.login("cajera", "otra-clave-1")
    expect((await h.call("/api/audit", { cookie: cashier })).status).toBe(403)
    expect((await h.call("/api/audit")).status).toBe(401)

    const all = (await (await h.call("/api/audit", { cookie: owner })).json()) as AuditEntry[]
    expect(all.length).toBeGreaterThan(0)
    const times = all.map((a) => a.at)
    expect(times).toEqual([...times].sort((a, b) => b - a))
    expect(all.some((a) => a.action === "shift.opened" && a.actorName === "Dueña")).toBe(true)
  })

  test("filtra por prefijo de acción, por persona y por rango; los comodines son texto", async () => {
    const { owner } = await setUp(h)
    await newUser(owner, "cajera", "cashier")

    const shifts = (await (
      await h.call("/api/audit?action=shift.", { cookie: owner })
    ).json()) as AuditEntry[]
    expect(shifts.length).toBeGreaterThan(0)
    expect(shifts.every((a) => a.action.startsWith("shift."))).toBe(true)

    // «%» y «_» no son comodines.
    for (const action of ["%", "_", "shift_", "s%"]) {
      const none = (await (
        await h.call(`/api/audit?action=${encodeURIComponent(action)}`, { cookie: owner })
      ).json()) as AuditEntry[]
      expect(none).toHaveLength(0)
    }

    const nobody = (await (
      await h.call("/api/audit?actorId=no-existe", { cookie: owner })
    ).json()) as AuditEntry[]
    expect(nobody).toHaveLength(0)

    const future = (await (
      await h.call(`/api/audit?from=${h.clock.now + 86_400_000}`, { cookie: owner })
    ).json()) as AuditEntry[]
    expect(future).toHaveLength(0)

    const limited = (await (
      await h.call("/api/audit?limit=1", { cookie: owner })
    ).json()) as AuditEntry[]
    expect(limited).toHaveLength(1)
  })
})
