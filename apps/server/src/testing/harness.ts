import { expect } from "bun:test"
import type { RateSource } from "@millhiore/bcv"
import {
  account,
  createDb,
  type Db,
  migrateDb,
  paymentMethod,
  product,
  terminal,
  variant,
} from "@millhiore/db"
import { uuidv7 } from "@millhiore/domain"
import { eq } from "drizzle-orm"
import { createApp } from "../app"
import { createAuth } from "../infra/auth"

export const BASE = "http://localhost:3000"
export const NOW = 1_760_000_000_000

export interface Harness {
  db: Db
  call: (
    path: string,
    init?: {
      method?: string
      body?: unknown
      cookie?: string
      /** Dirección del cliente tal como la vería el servidor Bun. */
      ip?: string
      headers?: Record<string, string>
    },
  ) => Promise<Response>
  login: (username: string, password: string) => Promise<string>
  /** Reloj del servidor: se puede adelantar en las pruebas. */
  clock: { now: number }
}

export function harness(
  opts: {
    rateLimit?: boolean
    rates?: { sources?: RateSource[]; fetcher?: typeof fetch }
    afterSetup?: () => void
    backups?: { dataDir: string; keep: number }
  } = {},
): Harness {
  const db = createDb(":memory:")
  migrateDb(db)
  const auth = createAuth(db, {
    secret: "test-secret-test-secret-test-secret-1234",
    baseURL: BASE,
    rateLimit: opts.rateLimit ?? false,
  })
  const clock = { now: NOW }
  const app = createApp({
    db,
    auth,
    now: () => clock.now,
    ...(opts.rates ? { rates: opts.rates } : {}),
    ...(opts.afterSetup ? { afterSetup: opts.afterSetup } : {}),
    ...(opts.backups ? { backups: opts.backups } : {}),
  })

  const call: Harness["call"] = async (path, init = {}) =>
    await app.request(
      path,
      {
        method: init.method ?? (init.body ? "POST" : "GET"),
        headers: {
          origin: BASE,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.cookie ? { cookie: init.cookie } : {}),
          ...init.headers,
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      },
      // Lo que Bun pasa como 2.º argumento de fetch: de ahí sale la IP del socket.
      init.ip
        ? { server: { requestIP: () => ({ address: init.ip, family: "IPv4", port: 50000 }) } }
        : {},
    )

  const login: Harness["login"] = async (username, password) => {
    const res = await call("/api/auth/sign-in/username", { body: { username, password } })
    if (res.status !== 200) throw new Error(`login falló: ${res.status} ${await res.text()}`)
    return res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ")
  }
  return { db, call, login, clock }
}

export const setupBody = {
  business: { name: "Bodega La Esquina" },
  owner: { name: "Dueña", username: "duena", password: "clave-segura-1" },
  initialRate: "36.5",
}

export async function setUp(h: Harness) {
  const res = await h.call("/api/setup", { body: setupBody })
  expect(res.status).toBe(201)
  const owner = await h.login("duena", "clave-segura-1")
  // Catálogo mínimo (aún no hay API de catálogo)
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
  const term = h.db.select().from(terminal).where(eq(terminal.code, "C1")).get()
  const usd = h.db
    .select()
    .from(paymentMethod)
    .all()
    .find((m) => m.name === "Efectivo USD")
  if (!term || !usd) throw new Error("el asistente no creó la terminal o el método de pago")
  // Vender exige turno abierto: se abre con la gaveta vacía.
  const shift = await openShiftFor(h, owner, term.id, {})
  return { owner, terminalId: term.id, methodUsd: usd.id, shiftId: shift.id }
}

/** Cuentas de efectivo del negocio, por nombre ("Efectivo USD", "Efectivo VES"). */
export function cashAccountIds(h: Harness): Record<string, string> {
  return Object.fromEntries(
    h.db
      .select()
      .from(account)
      .where(eq(account.kind, "cash"))
      .all()
      .map((a) => [a.name, a.id]),
  )
}

/** Abre turno contando `counts` (por nombre de cuenta; lo que falte cuenta 0). */
export async function openShiftFor(
  h: Harness,
  cookie: string,
  terminalId: string,
  counts: Record<string, number>,
): Promise<{ id: string }> {
  const res = await h.call("/api/shifts", {
    cookie,
    body: {
      id: uuidv7(),
      terminalId,
      counts: Object.entries(cashAccountIds(h)).map(([name, accountId]) => ({
        accountId,
        countedMinor: counts[name] ?? 0,
      })),
    },
  })
  if (res.status !== 201) throw new Error(`no se pudo abrir el turno: ${await res.text()}`)
  return (await res.json()) as { id: string }
}

export const saleBody = (
  terminalId: string,
  methodId: string,
  over: Record<string, unknown> = {},
) => ({
  id: uuidv7(),
  type: "SALE",
  terminalId,
  currency: "USD",
  rate: { base: "USD", quote: "VES", value: "36.5" },
  lines: [{ variantId: "v1", qtyMilli: 2000, unitPriceMinor: 150 }],
  payments: [{ id: uuidv7(), paymentMethodId: methodId, currency: "USD", amountMinor: 300 }],
  ...over,
})
