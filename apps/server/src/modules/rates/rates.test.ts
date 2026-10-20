import { beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { auditLog, exchangeRate } from "@millhiore/db"
import { eq } from "drizzle-orm"
import { type Harness, harness, setUp, setupBody } from "../../testing/harness"
import { MAX_AUTOMATIC_JUMP, rateAt, recordRate, STALE_AFTER_MS } from "./service"

const bcvHtml = await Bun.file(
  join(import.meta.dir, "../../../../../packages/bcv/fixtures/bcv-2026-10-14.html"),
).text()

/** Fecha Valor de la página capturada: 15-oct-2026 00:00 en Caracas. */
const BCV_EFFECTIVE = Date.parse("2026-10-15T04:00:00Z")
/** Mientras tanto es la noche del 14-oct: el BCV ya publicó la tasa de mañana. */
const EVENING = Date.parse("2026-10-14T22:00:00Z")

const mirror =
  (usd: number, eur = 982.75895071) =>
  (url: string) =>
    Response.json({
      promedio: url.includes("euros") ? eur : usd,
      fechaActualizacion: "2026-10-14T00:00:00-04:00",
    })

type Handler = (url: string) => Response
const fetcherOf = (handler: Handler) =>
  (async (input: string | URL | Request) => handler(String(input))) as unknown as typeof fetch

const bcvUp: Handler = (url) =>
  url.includes("bcv.org.ve") ? new Response(bcvHtml) : mirror(877.9023)(url)
const bcvDown: Handler = (url) =>
  url.includes("bcv.org.ve") ? new Response("caído", { status: 503 }) : mirror(877.9023)(url)
const allDown: Handler = () => new Response("caído", { status: 500 })

interface RateJson {
  id: string
  base: string
  quote: string
  value: string
  source: string
  effectiveAt: number
}
interface StatusJson {
  stale: boolean
  current: RateJson | null
  lastCheck: { ok: boolean; source: string | null; failures: string[] } | null
}
interface ReportJson {
  ok: boolean
  source: string | null
  recorded: { currency: string; value: string; effectiveAt: number }[]
  rejected: string[]
  error: string | null
}
let current: Handler
let h: Harness
let owner: string

beforeEach(async () => {
  current = bcvUp
  h = harness({ rates: { fetcher: fetcherOf((url) => current(url)) } })
  h.clock.now = EVENING
  ;({ owner } = await setUp(h))
})

const refresh = async (cookie = owner) => {
  const res = await h.call("/api/rates/refresh", { method: "POST", cookie })
  return { status: res.status, body: (await res.json()) as ReportJson }
}

describe("consulta automática", () => {
  test("guarda USD y EUR con la Fecha Valor del BCV, no la hora de consulta", async () => {
    const { status, body } = await refresh()
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, source: "bcv", rejected: [], error: null })
    expect(body.recorded).toEqual([
      { currency: "USD", value: "879.12250000", effectiveAt: BCV_EFFECTIVE },
      { currency: "EUR", value: "977.68092347", effectiveAt: BCV_EFFECTIVE },
    ])
  })

  test("la tasa publicada para mañana no rige hoy, y rige desde su Fecha Valor", async () => {
    await refresh()
    // hoy (noche del 14) sigue la manual del asistente
    expect(
      (await (await h.call("/api/rates/current", { cookie: owner })).json()) as RateJson,
    ).toMatchObject({
      value: "36.50000000",
      source: "manual",
    })
    // a las 00:00 del 15, rige la del BCV
    h.clock.now = BCV_EFFECTIVE
    expect(
      (await (await h.call("/api/rates/current", { cookie: owner })).json()) as RateJson,
    ).toMatchObject({
      value: "879.12250000",
      source: "bcv",
    })
  })

  test("consultar dos veces no duplica nada", async () => {
    await refresh()
    const second = await refresh()
    expect(second.body).toMatchObject({ ok: true, recorded: [] })
    expect(
      h.db.select().from(exchangeRate).where(eq(exchangeRate.source, "bcv")).all(),
    ).toHaveLength(2)
  })

  test("si el BCV falla usa el respaldo y lo deja anotado", async () => {
    current = bcvDown
    const { body } = await refresh()
    expect(body).toMatchObject({ ok: true, source: "dolarapi" })
    const status = (await (
      await h.call("/api/rates/status", { cookie: owner })
    ).json()) as StatusJson
    expect(status.lastCheck).toMatchObject({ ok: true, source: "dolarapi" })
    expect(status.lastCheck?.failures[0] ?? "").toContain("[bcv]")
  })

  test("si todo falla lo registra sin romper nada", async () => {
    current = allDown
    const { status, body } = await refresh()
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.error).toContain("Ninguna fuente")
    const st = (await (await h.call("/api/rates/status", { cookie: owner })).json()) as StatusJson
    expect(st.lastCheck?.ok).toBe(false)
    expect(st.current?.value).toBe("36.50000000") // sigue vigente la anterior
  })

  test("rechaza una tasa automática con un salto sospechoso", async () => {
    await refresh() // 879,1225 queda como última automática
    h.clock.now += 1000
    const bad: Handler = (url) =>
      url.includes("bcv.org.ve") ? new Response("x", { status: 500 }) : mirror(100)(url)
    current = bad
    const { body } = await refresh()
    expect(body.ok).toBe(false)
    expect(body.rejected[0]).toContain("USD/VES")
    expect(body.error).toContain("sospechosa")
    expect(rateAt(h.db, "USD", "VES", Number.MAX_SAFE_INTEGER)?.value).toBe("879.12250000")
    expect(MAX_AUTOMATIC_JUMP).toBeLessThan(0.5)
  })

  test("una tasa manual equivocada no bloquea las oficiales (se compara con la última automática)", async () => {
    // el asistente guardó 36,5 a mano; la oficial real es 879: no debe verse como salto
    const { body } = await refresh()
    expect(body.rejected).toEqual([])
    expect(body.recorded.find((r) => r.currency === "USD")).toBeDefined()
  })

  test("solo quien tiene rate.manage puede forzar la consulta", async () => {
    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await refresh(cashier)).status).toBe(403)
    expect((await h.call("/api/rates/refresh", { method: "POST" })).status).toBe(401)
  })
})

describe("tasa manual e historial", () => {
  test("el dueño carga una tasa manual y queda en auditoría", async () => {
    h.clock.now += 60_000
    const res = await h.call("/api/rates", { cookie: owner, body: { value: "880.5" } })
    expect(res.status).toBe(201)
    expect((await res.json()) as RateJson).toMatchObject({
      value: "880.50000000",
      source: "manual",
      base: "USD",
      quote: "VES",
    })
    const audit = h.db.select().from(auditLog).where(eq(auditLog.action, "rate.updated")).all()
    expect(audit.length).toBe(1) // la inicial del asistente se escribe sin auditoría; esta sí
  })

  test("valida el valor y no repite la misma vigencia", async () => {
    expect((await h.call("/api/rates", { cookie: owner, body: { value: "abc" } })).status).toBe(422)
    const body = { value: "880", effectiveAt: EVENING + 1000 }
    expect((await h.call("/api/rates", { cookie: owner, body })).status).toBe(201)
    expect((await h.call("/api/rates", { cookie: owner, body })).status).toBe(409)
  })

  test("un cajero puede consultar la tasa pero no cambiarla", async () => {
    await h.call("/api/users", {
      cookie: owner,
      body: { name: "Pedro", username: "pedro", password: "otra-clave-1", roleId: "cashier" },
    })
    const cashier = await h.login("pedro", "otra-clave-1")
    expect((await h.call("/api/rates/current", { cookie: cashier })).status).toBe(200)
    expect((await h.call("/api/rates", { cookie: cashier, body: { value: "1" } })).status).toBe(403)
  })

  test("el historial va de la más reciente a la más antigua", async () => {
    await refresh()
    const rows = (await (
      await h.call("/api/rates?limit=10", { cookie: owner })
    ).json()) as RateJson[]
    expect(rows.map((r) => r.source)).toEqual(["bcv", "bcv", "manual"])
    expect(rows[0]?.effectiveAt).toBeGreaterThanOrEqual(rows[2]?.effectiveAt ?? 0)
  })

  test("sin sesión no se consulta nada", async () => {
    for (const path of ["/api/rates/current", "/api/rates/status", "/api/rates"]) {
      expect((await h.call(path)).status).toBe(401)
    }
  })
})

describe("estado y desactualización", () => {
  test("avisa cuando la tasa vigente lleva demasiado tiempo", async () => {
    const fresh = (await (
      await h.call("/api/rates/status", { cookie: owner })
    ).json()) as StatusJson
    expect(fresh.stale).toBe(false)
    h.clock.now += STALE_AFTER_MS + 1000
    const old = (await (await h.call("/api/rates/status", { cookie: owner })).json()) as StatusJson
    expect(old.stale).toBe(true)
  })

  test("sin ninguna tasa cargada está desactualizada y /current da 404", async () => {
    const bare = harness()
    await bare.call("/api/setup", { body: { ...setupBody, initialRate: null } })
    const cookie = await bare.login("duena", "clave-segura-1")
    expect(
      ((await (await bare.call("/api/rates/status", { cookie })).json()) as StatusJson).stale,
    ).toBe(true)
    expect((await bare.call("/api/rates/current", { cookie })).status).toBe(404)
  })
})

describe("instalación nueva por la tarde", () => {
  test("sin tasa vigente toma también el respaldo, para poder vender esa misma noche", async () => {
    const fresh = harness({ rates: { fetcher: fetcherOf((url) => current(url)) } })
    fresh.clock.now = EVENING
    await fresh.call("/api/setup", { body: { ...setupBody, initialRate: null } })
    const cookie = await fresh.login("duena", "clave-segura-1")

    const res = await fresh.call("/api/rates/refresh", { method: "POST", cookie })
    const report = (await res.json()) as ReportJson
    expect(report).toMatchObject({ ok: true, source: "bcv" })
    expect(report.recorded.map((r) => `${r.currency}:${r.value}`).sort()).toEqual([
      "EUR:977.68092347", // BCV (rige desde mañana)
      "EUR:982.75895071", // respaldo (rige desde hoy)
      "USD:877.90230000",
      "USD:879.12250000",
    ])

    const now = (await (await fresh.call("/api/rates/current", { cookie })).json()) as RateJson
    expect(now).toMatchObject({ value: "877.90230000", source: "dolarapi" })

    fresh.clock.now = BCV_EFFECTIVE
    const tomorrow = (await (await fresh.call("/api/rates/current", { cookie })).json()) as RateJson
    expect(tomorrow).toMatchObject({ value: "879.12250000", source: "bcv" })
  })

  test("con una tasa ya vigente no molesta a las fuentes de respaldo", async () => {
    let mirrorCalls = 0
    current = (url) => {
      if (!url.includes("bcv.org.ve")) mirrorCalls++
      return bcvUp(url)
    }
    await refresh() // beforeEach dejó la manual del asistente vigente
    expect(mirrorCalls).toBe(0)
  })
})

describe("desempate entre fuentes", () => {
  test("a igual vigencia manda la manual, luego el BCV y por último el espejo", () => {
    const T = EVENING + 3_600_000 // posterior a la manual que dejó el asistente
    const base = { base: "USD", quote: "VES", effectiveAt: T, createdBy: null }
    recordRate(h.db, { ...base, source: "bcv", value: "878.00000000" }, 1) // creada antes…
    recordRate(h.db, { ...base, source: "dolarapi", value: "877.90000000" }, 2) // …que el espejo
    expect(rateAt(h.db, "USD", "VES", T)?.source).toBe("bcv")

    recordRate(h.db, { ...base, source: "manual", value: "880.00000000" }, 0)
    expect(rateAt(h.db, "USD", "VES", T)?.source).toBe("manual")
  })
})
