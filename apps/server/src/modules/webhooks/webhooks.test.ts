import { beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import type { Webhook, WebhookDelivery } from "@millhiore/contracts"
import { auditLog } from "@millhiore/db"
import { eq } from "drizzle-orm"
import { drainOutbox } from "../../events/outbox"
import { type Harness, harness, saleBody, setUp } from "../../testing/harness"
import { deliverDue, RETRY_DELAYS_MS } from "./service"

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

/** Lo que recibe el otro sistema, con lo que responde. */
function receiver(respond: () => Response | Promise<Response> = () => new Response("ok")) {
  const got: { url: string; headers: Headers; body: string }[] = []
  const fetcher = (async (url: string, init: RequestInit) => {
    got.push({ url, headers: new Headers(init.headers), body: String(init.body) })
    return await respond()
  }) as unknown as typeof fetch
  return { got, fetcher }
}

const create = (events: string[], url = "https://tienda.example/hooks") =>
  h.call("/api/webhooks", { cookie: s.owner, body: { name: "Tienda", url, events } })

const sell = () =>
  h.call("/api/documents", { cookie: s.owner, body: saleBody(s.terminalId, s.methodUsd) })

/** Una vuelta del trabajo en segundo plano. */
async function tick(fetcher: typeof fetch) {
  drainOutbox(h.db, h.clock.now)
  return await deliverDue(h.db, h.clock.now, fetcher)
}

describe("webhooks", () => {
  test("una venta llega firmada, con el documento completo", async () => {
    const hook = await json<Webhook>(await create(["sale.posted", "shift.closed"]), 201)
    expect(hook.secret).toMatch(/^whsec_/)
    const sale = await json<{ id: string }>(await sell(), 201)
    const { got, fetcher } = receiver()
    expect(await tick(fetcher)).toEqual({ delivered: 1, failed: 0 })
    expect(got).toHaveLength(1)
    const [msg] = got
    if (!msg) throw new Error("no llegó")
    expect(msg.url).toBe("https://tienda.example/hooks")
    expect(msg.headers.get("x-millhiore-event")).toBe("sale.posted")
    const body = JSON.parse(msg.body) as { event: string; data: { id: string; lines: unknown[] } }
    expect(body.event).toBe("sale.posted")
    expect(body.data.id).toBe(sale.id)
    expect(body.data.lines).toHaveLength(1)
    // La firma: HMAC-SHA256 de «t.cuerpo» con el secreto del webhook.
    const sig = msg.headers.get("x-millhiore-signature") ?? ""
    const t = /t=(\d+)/.exec(sig)?.[1]
    const mac = createHmac("sha256", hook.secret).update(`${t}.${msg.body}`).digest("hex")
    expect(sig).toBe(`t=${t},v1=${mac}`)
    // Ya repartido: la siguiente vuelta no lo repite.
    expect(await tick(fetcher)).toEqual({ delivered: 0, failed: 0 })
    expect(got).toHaveLength(1)
    const [listed] = await json<Webhook[]>(await h.call("/api/webhooks", { cookie: s.owner }))
    expect(listed?.last).toMatchObject({ status: "delivered", lastStatus: 200 })
  })

  test("solo los eventos elegidos, y solo los de después de crearlo", async () => {
    await sell()
    h.clock.now += 1000
    await json(await create(["document.voided"]), 201)
    h.clock.now += 1000
    await sell()
    const { got, fetcher } = receiver()
    await tick(fetcher)
    expect(got).toHaveLength(0)
    // Con «document.posted», una venta llega con ese nombre.
    await json(await create(["document.posted"], "https://contable.example/in"), 201)
    h.clock.now += 1000
    await sell()
    await tick(fetcher)
    expect(got.map((g) => g.headers.get("x-millhiore-event"))).toEqual(["document.posted"])
  })

  test("si no responde se reintenta cada vez más espaciado y al final se da por fallido", async () => {
    const hook = await json<Webhook>(await create(["sale.posted"]), 201)
    await sell()
    const { got, fetcher } = receiver(() => new Response("caído", { status: 503 }))
    await tick(fetcher)
    let [d] = await json<WebhookDelivery[]>(
      await h.call(`/api/webhooks/${hook.id}/deliveries`, { cookie: s.owner }),
    )
    expect(d).toMatchObject({ status: "pending", attempts: 1, lastStatus: 503 })
    expect(d?.nextAttemptAt).toBe(h.clock.now + 60_000)
    // Antes de tiempo no se intenta.
    await tick(fetcher)
    expect(got).toHaveLength(1)
    for (const wait of RETRY_DELAYS_MS) {
      h.clock.now += wait
      await tick(fetcher)
    }
    expect(got).toHaveLength(RETRY_DELAYS_MS.length + 1)
    ;[d] = await json<WebhookDelivery[]>(
      await h.call(`/api/webhooks/${hook.id}/deliveries`, { cookie: s.owner }),
    )
    expect(d).toMatchObject({ status: "failed", attempts: 7, nextAttemptAt: null })
    // Reintentarlo a mano lo vuelve a mandar ya.
    await h.call(`/api/webhooks/deliveries/${d?.id}/retry`, { cookie: s.owner, method: "POST" })
    const ok = receiver()
    expect(await tick(ok.fetcher)).toEqual({ delivered: 1, failed: 0 })
  })

  test("prueba, apagado y cambios; todo en la bitácora sin el secreto", async () => {
    // Después de la tasa que cargó el asistente: esa no le toca.
    h.clock.now += 1000
    const hook = await json<Webhook>(await create(["rate.updated"]), 201)
    await json(
      await h.call(`/api/webhooks/${hook.id}/ping`, { cookie: s.owner, method: "POST" }),
      201,
    )
    const { got, fetcher } = receiver()
    await tick(fetcher)
    expect(got[0]?.headers.get("x-millhiore-event")).toBe("ping")
    // Apagado no recibe; al encenderlo llega lo que esperaba.
    await h.call(`/api/webhooks/${hook.id}`, {
      method: "PATCH",
      cookie: s.owner,
      body: { active: false, url: "https://otra.example/x" },
    })
    await h.call(`/api/webhooks/${hook.id}/ping`, { cookie: s.owner, method: "POST" })
    await tick(fetcher)
    expect(got).toHaveLength(1)
    await h.call(`/api/webhooks/${hook.id}`, {
      method: "PATCH",
      cookie: s.owner,
      body: { active: true },
    })
    await tick(fetcher)
    expect(got.map((g) => g.url)).toEqual([
      "https://tienda.example/hooks",
      "https://otra.example/x",
    ])
    const logged = h.db.select().from(auditLog).where(eq(auditLog.entityType, "webhook")).all()
    expect(logged.map((l) => l.action)).toEqual([
      "webhook.created",
      "webhook.updated",
      "webhook.updated",
    ])
    expect(JSON.stringify(logged)).not.toContain(hook.secret)
  })

  test("valida la dirección y los eventos, y exige settings.manage", async () => {
    expect((await create(["sale.posted"], "ftp://tienda.example")).status).toBe(422)
    expect((await create([])).status).toBe(422)
    expect((await create(["venta.algo"])).status).toBe(422)
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Admin", username: "admin", password: "otra-clave-1", roleId: "manager" },
    })
    const manager = await h.login("admin", "otra-clave-1")
    expect((await h.call("/api/webhooks", { cookie: manager })).status).toBe(403)
  })
})
