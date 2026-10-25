import { beforeEach, describe, expect, test } from "bun:test"
import type {
  CatalogItem,
  TelegramChat,
  TelegramSettings,
  TelegramTest,
} from "@millhiore/contracts"
import { auditLog, telegramMessage } from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { drainOutbox } from "../../events/outbox"
import { cashAccountIds, type Harness, harness, NOW, saleBody, setUp } from "../../testing/harness"
import { enqueueDaily, sendDueTelegram } from "./service"

const TOKEN = "123456789:AAEhBOweik9ai2o4jW8u3Hk2h1k5fCq9xyz"

/** Un Telegram de mentira: guarda lo que se le manda y responde como el de verdad. */
function fakeTelegram() {
  const sent: { chat_id: string; text: string }[] = []
  const state = { down: false }
  const fetcher = (async (url: string, init: RequestInit) => {
    if (state.down) throw new TypeError("fetch failed")
    const [, token, method] = /\/bot([^/]+)\/(\w+)$/.exec(url) ?? []
    const ok = (result: unknown) => Response.json({ ok: true, result })
    if (token !== TOKEN) {
      return Response.json({ ok: false, description: "Unauthorized" }, { status: 401 })
    }
    if (method === "getMe") return ok({ username: "MiBodegaBot" })
    if (method === "getUpdates") {
      return ok([
        { message: { chat: { id: 111, first_name: "Ana", last_name: "Dueña" } } },
        { my_chat_member: { chat: { id: -222, title: "Bodega (equipo)" } } },
        { message: { chat: { id: 111, first_name: "Ana", last_name: "Dueña" } } },
      ])
    }
    if (method === "sendMessage") {
      sent.push(JSON.parse(String(init.body)) as { chat_id: string; text: string })
      return ok({ message_id: sent.length })
    }
    return Response.json({ ok: false, description: "Not Found" }, { status: 404 })
  }) as unknown as typeof fetch
  return { sent, state, fetcher }
}

let h: Harness
let s: Awaited<ReturnType<typeof setUp>>
let tg: ReturnType<typeof fakeTelegram>
beforeEach(async () => {
  tg = fakeTelegram()
  h = harness({ telegram: { fetcher: tg.fetcher } })
  s = await setUp(h)
})

async function json<T>(res: Response, status = 200): Promise<T> {
  if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

const put = (body: Record<string, unknown>) =>
  h.call("/api/telegram", { method: "PUT", cookie: s.owner, body })

/** Conecta el bot con un chat y deja el reloj después de lo que hizo el asistente. */
async function connect(alerts: Record<string, unknown> = {}) {
  h.clock.now += 1000
  drainOutbox(h.db, h.clock.now)
  await json(await put({ token: TOKEN }))
  await json(
    await put({
      chats: [{ id: "111", name: "Ana" }],
      alerts: {
        daily: true,
        dailyHour: 20,
        lowStock: true,
        voids: true,
        shifts: true,
        rate: false,
        ...alerts,
      },
    }),
  )
}

/** Reparte los eventos y manda lo que haya: lo que el trabajo hace cada 5 s. */
async function tick() {
  drainOutbox(h.db, h.clock.now)
  return await sendDueTelegram(h.db, h.clock.now, tg.fetcher)
}

describe("alertas por Telegram", () => {
  test("se conecta con el token, que nunca se devuelve ni queda en la bitácora", async () => {
    const bad = await put({ token: "123456789:AAEhBOweik9ai2o4jW8u3Hk2h1k5fCq9zzz" })
    expect(bad.status).toBe(422)
    expect(((await bad.json()) as { error: { message: string } }).error.message).toContain(
      "no reconoce ese token",
    )
    const saved = await json<TelegramSettings>(await put({ token: TOKEN }))
    expect(saved).toMatchObject({ configured: true, botName: "@MiBodegaBot", chats: [] })
    const read = await h.call("/api/telegram", { cookie: s.owner })
    expect(await read.text()).not.toContain(TOKEN)
    const logged = h.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.telegram.updated"))
      .all()
    expect(JSON.stringify(logged)).not.toContain(TOKEN)
    // Desconectarlo borra el token y los chats.
    const off = await json<TelegramSettings>(await put({ token: null }))
    expect(off).toMatchObject({ configured: false, botName: null, chats: [] })
  })

  test("encuentra los chats que le escribieron al bot y les manda una prueba", async () => {
    await json(await put({ token: TOKEN }))
    const chats = await json<TelegramChat[]>(
      await h.call("/api/telegram/discover", { cookie: s.owner, method: "POST" }),
    )
    expect(chats).toEqual([
      { id: "111", name: "Ana Dueña" },
      { id: "-222", name: "Bodega (equipo)" },
    ])
    await json(await put({ chats }))
    const result = await json<TelegramTest>(
      await h.call("/api/telegram/test", { cookie: s.owner, method: "POST" }),
    )
    expect(result).toEqual({ sent: 2, errors: [] })
    expect(tg.sent.map((m) => m.chat_id)).toEqual(["111", "-222"])
  })

  test("anulaciones y productos que llegan a su mínimo", async () => {
    await connect()
    const item = await json<CatalogItem>(
      await h.call("/api/products", {
        cookie: s.owner,
        body: {
          name: "Harina PAN",
          priceMinor: 150,
          priceCurrency: "USD",
          taxId: "exento",
          minStockMilli: 5000,
        },
      }),
      201,
    )
    // Entran 6; vender 2 la deja en 4 (bajo el mínimo de 5): avisa una vez.
    await json(
      await h.call("/api/documents", {
        cookie: s.owner,
        body: {
          id: uuidv7(),
          type: "ADJUSTMENT",
          terminalId: s.terminalId,
          currency: "VES",
          lines: [{ variantId: item.variantId, qtyMilli: 6000, unitPriceMinor: 0 }],
          payments: [],
          stockReasonId: "stk-in-goods",
        },
      }),
      201,
    )
    const sellFlour = (qtyMilli: number) =>
      h.call("/api/documents", {
        cookie: s.owner,
        body: saleBody(s.terminalId, s.methodUsd, {
          lines: [{ variantId: item.variantId, qtyMilli, unitPriceMinor: 150 }],
          payments: [
            {
              id: uuidv7(),
              paymentMethodId: s.methodUsd,
              currency: "USD",
              amountMinor: (150 * qtyMilli) / 1000,
            },
          ],
        }),
      })
    const sale = await json<{ id: string; number: string }>(await sellFlour(2000), 201)
    await tick()
    expect(tg.sent.map((m) => m.text)).toEqual(["⚠️ Por reponer\n• Harina PAN: quedan 4 (mínimo 5)"])
    // Ya estaba bajo el mínimo: no repite.
    await json(await sellFlour(1000), 201)
    await tick()
    expect(tg.sent).toHaveLength(1)

    await json(
      await h.call(`/api/documents/${sale.id}/void`, {
        cookie: s.owner,
        body: { reversalId: uuidv7(), reason: "error" },
      }),
      201,
    )
    await tick()
    expect(tg.sent[1]?.text).toBe(`❌ Anulada la venta ${sale.number} ($ 3,00). La anuló Dueña.`)
  })

  test("el cierre de turno dice lo vendido y lo que no cuadró", async () => {
    await connect()
    await json(
      await h.call("/api/documents", {
        cookie: s.owner,
        body: saleBody(s.terminalId, s.methodUsd),
      }),
      201,
    )
    // Se vendieron 3 $ en efectivo y se contaron 2 $: falta 1 $.
    await json(
      await h.call(`/api/shifts/${s.shiftId}/close`, {
        cookie: s.owner,
        body: {
          counts: Object.entries(cashAccountIds(h)).map(([name, accountId]) => ({
            accountId,
            countedMinor: name === "Efectivo USD" ? 200 : 0,
          })),
        },
      }),
    )
    await tick()
    const text = tg.sent.at(-1)?.text ?? ""
    expect(text).toContain("🔒 Cierre de turno")
    expect(text).toContain("Efectivo USD: faltante de $ 1,00")
  })

  test("el resumen del día sale una vez, a partir de su hora", async () => {
    await connect({ dailyHour: 20 })
    // NOW es de madrugada en Caracas: todavía no.
    expect(enqueueDaily(h.db, h.clock.now)).toBe(false)
    // A las 8:30 p. m. sale, y una sola vez.
    const evening = Date.parse("2026-10-15T00:30:00Z")
    expect(evening).toBeGreaterThan(NOW)
    h.clock.now = evening
    expect(enqueueDaily(h.db, h.clock.now)).toBe(true)
    expect(enqueueDaily(h.db, h.clock.now + 60_000)).toBe(false)
    await tick()
    expect(tg.sent.at(-1)?.text).toContain("📊 Bodega La Esquina")
  })

  test("sin internet reintenta unas veces y después se rinde", async () => {
    await connect()
    await h.call("/api/telegram/test", { cookie: s.owner, method: "POST" })
    tg.sent.length = 0
    await json(
      await h.call(`/api/documents`, {
        cookie: s.owner,
        body: saleBody(s.terminalId, s.methodUsd),
      }),
      201,
    )
    await json(
      await h.call(`/api/shifts/${s.shiftId}/close`, {
        cookie: s.owner,
        body: {
          counts: Object.entries(cashAccountIds(h)).map(([name, accountId]) => ({
            accountId,
            countedMinor: name === "Efectivo USD" ? 300 : 0,
          })),
        },
      }),
    )
    tg.state.down = true
    expect(await tick()).toEqual({ sent: 0, failed: 0 })
    for (const wait of [60_000, 5 * 60_000]) {
      h.clock.now += wait
      expect(await tick()).toEqual({ sent: 0, failed: 0 })
    }
    h.clock.now += 15 * 60_000
    expect(await tick()).toEqual({ sent: 0, failed: 1 })
    const [m] = h.db.select().from(telegramMessage).where(eq(telegramMessage.kind, "shift")).all()
    expect(m).toMatchObject({ status: "failed", attempts: 4 })
    expect(m?.lastError).toContain("internet")
  })

  test("exige settings.manage", async () => {
    await h.call("/api/users", {
      cookie: s.owner,
      body: { name: "Admin", username: "admin", password: "otra-clave-1", roleId: "manager" },
    })
    const manager = await h.login("admin", "otra-clave-1")
    expect((await h.call("/api/telegram", { cookie: manager })).status).toBe(403)
  })
})
