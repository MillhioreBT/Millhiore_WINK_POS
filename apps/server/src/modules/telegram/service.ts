import type {
  TelegramAlerts,
  TelegramChat,
  TelegramSettings,
  TelegramTest,
  UpdateTelegramBody,
  WebOrder,
} from "@millhiore/contracts"
import { auditLog, business, type Db, type outbox, telegramMessage } from "@millhiore/db"
import { localDate, uuidv7 } from "@millhiore/domain"
import { and, asc, eq, lte } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { daySummary } from "../reports/service"
import { readSetting, writeSetting } from "../settings/service"
import { shiftReport } from "../shifts/service"
import { dailyText, lowStockText, orderText, rateText, shiftText, voidText } from "./messages"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type OutboxEvent = typeof outbox.$inferSelect

const KEY = "telegram"

/** Lo que se guarda: el token nunca sale de aquí. */
interface Stored {
  token: string | null
  botName: string | null
  chats: TelegramChat[]
  alerts: TelegramAlerts
  /** El último día (AAAA-MM-DD) en que salió el resumen. */
  lastDaily: string | null
}

/** De fábrica: el resumen a las 8 de la noche y las alertas que importan; la tasa no (es diaria). */
const DEFAULT_ALERTS: TelegramAlerts = {
  daily: true,
  dailyHour: 20,
  lowStock: true,
  voids: true,
  shifts: true,
  rate: false,
  orders: true,
}

/** Reintentos de una alerta: al minuto, a los 5 y a los 15; después ya no sirve. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000]

function stored(db: Pick<Db, "select">): Stored {
  const s = readSetting<Partial<Stored>>(db, KEY) ?? {}
  return {
    token: s.token ?? null,
    botName: s.botName ?? null,
    chats: s.chats ?? [],
    alerts: { ...DEFAULT_ALERTS, ...(s.alerts ?? {}) },
    lastDaily: s.lastDaily ?? null,
  }
}

/** Lo que se puede mostrar (y guardar en la bitácora): todo menos el token. */
const visible = (s: Stored): TelegramSettings => ({
  configured: s.token !== null,
  botName: s.botName,
  chats: s.chats,
  alerts: s.alerts,
})

export function telegramSettings(db: Pick<Db, "select">): TelegramSettings {
  return visible(stored(db))
}

/** Llama a la API de bots de Telegram; un error de Telegram o de la red sale como HttpError. */
async function call<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<T> {
  let res: Response
  try {
    res = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new HttpError(
      502,
      "TELEGRAM_UNREACHABLE",
      "No se pudo conectar con Telegram: revisa el internet",
    )
  }
  const json = (await res.json().catch(() => null)) as {
    ok?: boolean
    result?: T
    description?: string
  } | null
  if (!json?.ok) {
    const why = json?.description ?? `respondió ${res.status}`
    throw new HttpError(
      422,
      "TELEGRAM_ERROR",
      res.status === 401 || res.status === 404
        ? "Telegram no reconoce ese token: cópialo de nuevo de @BotFather"
        : `Telegram: ${why}`,
    )
  }
  return json.result as T
}

/**
 * Conecta o desconecta el bot, elige los chats y las alertas. Un token nuevo se comprueba con
 * Telegram (y de ahí sale el nombre del bot). La bitácora nunca guarda el token.
 */
export async function updateTelegram(
  db: Db,
  patch: UpdateTelegramBody,
  actorId: string,
  now: number,
  fetcher: typeof fetch,
): Promise<TelegramSettings> {
  const current = stored(db)
  let next: Stored = { ...current }
  if (patch.token === null) {
    next = { ...next, token: null, botName: null, chats: [] }
  } else if (patch.token !== undefined) {
    const me = await call<{ username?: string }>(patch.token, "getMe", {}, fetcher)
    next = { ...next, token: patch.token, botName: me.username ? `@${me.username}` : null }
  }
  if (patch.chats !== undefined) next.chats = patch.chats
  if (patch.alerts !== undefined) {
    next.alerts = {
      ...next.alerts,
      ...Object.fromEntries(Object.entries(patch.alerts).filter(([, v]) => v !== undefined)),
    }
  }
  db.transaction(
    (tx) => {
      writeSetting(tx, KEY, next)
      tx.insert(auditLog)
        .values({
          id: uuidv7(now),
          at: now,
          actorId,
          action: "settings.telegram.updated",
          entityType: "settings",
          entityId: KEY,
          data: { before: visible(current), after: visible(next) },
        })
        .run()
    },
    { behavior: "immediate" },
  )
  return telegramSettings(db)
}

/**
 * Los chats que le escribieron al bot (o lo agregaron a un grupo) en los últimos días, para
 * elegirlos sin buscar su número.
 */
export async function discoverChats(db: Db, fetcher: typeof fetch): Promise<TelegramChat[]> {
  const { token } = stored(db)
  if (!token) throw new HttpError(409, "TELEGRAM_NOT_CONFIGURED", "Primero conecta el bot")
  type Chat = {
    id: number
    title?: string
    first_name?: string
    last_name?: string
    username?: string
  }
  const updates = await call<
    { message?: { chat: Chat }; my_chat_member?: { chat: Chat }; channel_post?: { chat: Chat } }[]
  >(
    token,
    "getUpdates",
    { allowed_updates: ["message", "my_chat_member", "channel_post"] },
    fetcher,
  )
  const found = new Map<string, TelegramChat>()
  for (const u of updates) {
    const chat = u.message?.chat ?? u.my_chat_member?.chat ?? u.channel_post?.chat
    if (!chat) continue
    const name =
      chat.title ??
      ([chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
        chat.username ||
        String(chat.id))
    found.set(String(chat.id), { id: String(chat.id), name: name.slice(0, 80) })
  }
  return [...found.values()]
}

/** Manda ya una prueba a cada chat y dice a cuáles llegó. */
export async function sendTest(db: Db, fetcher: typeof fetch): Promise<TelegramTest> {
  const s = stored(db)
  if (!s.token) throw new HttpError(409, "TELEGRAM_NOT_CONFIGURED", "Primero conecta el bot")
  if (s.chats.length === 0) throw new HttpError(409, "TELEGRAM_NO_CHATS", "Agrega al menos un chat")
  const errors: string[] = []
  let sent = 0
  for (const c of s.chats) {
    try {
      await call(
        s.token,
        "sendMessage",
        {
          chat_id: c.id,
          text: "✅ Prueba de Millhiore WINK POS: las alertas llegan a este chat.",
        },
        fetcher,
      )
      sent++
    } catch (e) {
      errors.push(`${c.name}: ${(e as Error).message}`)
    }
  }
  return { sent, errors }
}

function enqueue(
  tx: Pick<Db, "insert">,
  chats: TelegramChat[],
  kind: string,
  text: string,
  now: number,
) {
  for (const c of chats) {
    tx.insert(telegramMessage)
      .values({
        id: uuidv7(now),
        chatId: c.id,
        kind,
        text,
        status: "pending",
        nextAttemptAt: now,
        createdAt: now,
      })
      .run()
  }
}

/** Las alertas que salen de los eventos del `outbox`: anulaciones, existencia baja, turnos y tasa. */
export function enqueueTelegram(tx: Tx, events: OutboxEvent[], now: number): void {
  const s = stored(tx)
  if (!s.token || s.chats.length === 0) return
  const { alerts } = s
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>
    let alert: { kind: string; text: string | null } | null = null
    if (e.type === "document.voided" && alerts.voids && typeof p.reverses === "string") {
      alert = { kind: "void", text: voidText(tx, String(p.id), p.reverses) }
    } else if (e.type === "document.posted" && alerts.lowStock && typeof p.id === "string") {
      alert = { kind: "low_stock", text: lowStockText(tx, p.id) }
    } else if (e.type === "shift.closed" && alerts.shifts && typeof p.shiftId === "string") {
      try {
        alert = { kind: "shift", text: shiftText(shiftReport(tx as unknown as Db, p.shiftId)) }
      } catch {
        alert = null
      }
    } else if (e.type === "order.created" && alerts.orders && typeof p.number === "string") {
      alert = { kind: "order", text: orderText(p as unknown as WebOrder) }
    } else if (e.type === "rate.updated" && alerts.rate && typeof p.value === "string") {
      alert = {
        kind: "rate",
        text: rateText({
          base: String(p.base),
          quote: String(p.quote),
          value: p.value,
          ...(typeof p.source === "string" ? { source: p.source } : {}),
        }),
      }
    }
    if (alert?.text) enqueue(tx, s.chats, alert.kind, alert.text, now)
  }
}

/**
 * El resumen del día, una vez al día a partir de la hora elegida (si la PC estaba apagada a esa
 * hora, sale en cuanto se prenda ese mismo día). Devuelve si lo puso en cola.
 */
export function enqueueDaily(db: Db, now: number): boolean {
  const s = stored(db)
  if (!s.token || s.chats.length === 0 || !s.alerts.daily) return false
  const biz = db.select().from(business).get()
  if (!biz) return false
  const today = localDate(now, biz.timezone)
  if (s.lastDaily === today) return false
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: biz.timezone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  )
  if (hour < s.alerts.dailyHour) return false
  const summary = daySummary(db, { now, includeStock: true, seeCost: true })
  db.transaction(
    (tx) => {
      enqueue(tx, s.chats, "daily", dailyText(summary, biz.name), now)
      writeSetting(tx, KEY, { ...s, lastDaily: today })
    },
    { behavior: "immediate" },
  )
  return true
}

/** Manda las alertas que ya tocan; si Telegram no responde, reintenta unas veces y se rinde. */
export async function sendDueTelegram(
  db: Db,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<{ sent: number; failed: number }> {
  const { token } = stored(db)
  if (!token) return { sent: 0, failed: 0 }
  const due = db
    .select()
    .from(telegramMessage)
    .where(and(eq(telegramMessage.status, "pending"), lte(telegramMessage.nextAttemptAt, now)))
    .orderBy(asc(telegramMessage.nextAttemptAt), asc(telegramMessage.id))
    .limit(20)
    .all()
  let sent = 0
  let failed = 0
  for (const m of due) {
    try {
      await call(token, "sendMessage", { chat_id: m.chatId, text: m.text }, fetcher)
      sent++
      db.update(telegramMessage)
        .set({
          status: "sent",
          attempts: m.attempts + 1,
          sentAt: now,
          nextAttemptAt: null,
          lastError: null,
        })
        .where(eq(telegramMessage.id, m.id))
        .run()
    } catch (e) {
      const attempts = m.attempts + 1
      const wait = RETRY_DELAYS_MS[attempts - 1]
      if (wait === undefined) failed++
      db.update(telegramMessage)
        .set({
          status: wait === undefined ? "failed" : "pending",
          attempts,
          nextAttemptAt: wait === undefined ? null : now + wait,
          lastError: (e as Error).message.slice(0, 300),
        })
        .where(eq(telegramMessage.id, m.id))
        .run()
    }
  }
  return { sent, failed }
}
