import {
  DEFAULT_SOURCES,
  type FetchResult,
  fetchOfficialRates,
  type RateSource,
} from "@millhiore/bcv"
import { auditLog, business, currency, type Db, exchangeRate, outbox } from "@millhiore/db"
import { normalizeRate, uuidv7 } from "@millhiore/domain"
import { and, desc, eq, lte, ne, sql } from "drizzle-orm"
import { HttpError } from "../../http/errors"
import { readSetting, writeSetting } from "../settings/service"

export type StoredRate = typeof exchangeRate.$inferSelect
export type RateSourceId = StoredRate["source"]

/** Una tasa automática que se aparta más de esto de la anterior se rechaza (probable error de lectura). */
export const MAX_AUTOMATIC_JUMP = 0.25

/** Sin tasa vigente en más de este tiempo se avisa. El BCV no publica en feriados largos. */
export const STALE_AFTER_MS = 5 * 24 * 60 * 60 * 1000

const LAST_CHECK_KEY = "rates.lastCheck"

/** A igual vigencia manda la manual, luego el BCV (8 decimales) y por último el espejo. */
const SOURCE_PRIORITY = sql`case ${exchangeRate.source} when 'manual' then 0 when 'bcv' then 1 else 2 end`

export interface LastCheck {
  at: number
  ok: boolean
  source: string | null
  error: string | null
  /** Fuentes que fallaron antes de la que respondió. */
  failures: string[]
  /** Cotizaciones que se rechazaron por sospechosas. */
  rejected: string[]
}

/** Tasa vigente en el instante `at`: la de mayor `effectiveAt` que ya empezó; si empatan, la más reciente. */
export function rateAt(
  db: Pick<Db, "select">,
  base: string,
  quote: string,
  at: number,
): StoredRate | undefined {
  return db
    .select()
    .from(exchangeRate)
    .where(
      and(
        eq(exchangeRate.base, base),
        eq(exchangeRate.quote, quote),
        lte(exchangeRate.effectiveAt, at),
      ),
    )
    .orderBy(desc(exchangeRate.effectiveAt), SOURCE_PRIORITY, desc(exchangeRate.createdAt))
    .limit(1)
    .get()
}

export function getBusinessPair(db: Db): { base: string; quote: string } | undefined {
  const biz = db.select().from(business).get()
  return biz ? { base: biz.referenceCurrency, quote: biz.legalCurrency } : undefined
}

export class SuspiciousRateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SuspiciousRateError"
  }
}

export interface NewRate {
  base: string
  quote: string
  value: string
  source: RateSourceId
  effectiveAt: number
  createdBy: string | null
}

/**
 * Guarda una tasa en el historial. Idempotente por (par, vigencia, fuente). Las automáticas
 * pasan por una comprobación de salto brusco; las manuales no, porque las pone una persona.
 */
export function recordRate(db: Db, input: NewRate, now: number): { id: string; inserted: boolean } {
  const value = normalizeRate(input.value)
  return db.transaction(
    (tx) => {
      if (input.source !== "manual") {
        const previous = latestAutomatic(tx, input.base, input.quote)
        if (previous) {
          const jump = Math.abs(Number(value) / Number(previous.value) - 1)
          if (jump > MAX_AUTOMATIC_JUMP) {
            throw new SuspiciousRateError(
              `${input.base}/${input.quote}: ${previous.value} → ${value} (${(jump * 100).toFixed(0)}%)`,
            )
          }
        }
      }
      const id = uuidv7(now)
      const row = tx
        .insert(exchangeRate)
        .values({ id, ...input, value, createdAt: now })
        .onConflictDoNothing()
        .returning({ id: exchangeRate.id })
        .get()
      if (!row) return { id, inserted: false }

      const data = {
        base: input.base,
        quote: input.quote,
        value,
        source: input.source,
        effectiveAt: input.effectiveAt,
      }
      tx.insert(auditLog)
        .values({
          id: uuidv7(now),
          at: now,
          actorId: input.createdBy,
          action: "rate.updated",
          entityType: "exchange_rate",
          entityId: id,
          data,
        })
        .run()
      tx.insert(outbox)
        .values({ id: uuidv7(now), type: "rate.updated", payload: { id, ...data }, createdAt: now })
        .run()
      return { id, inserted: true }
    },
    { behavior: "immediate" },
  )
}

export interface RefreshReport {
  ok: boolean
  source: string | null
  recorded: { currency: string; value: string; effectiveAt: number }[]
  rejected: string[]
  error: string | null
}

/**
 * Consulta las fuentes oficiales y guarda las tasas nuevas. Guarda el resultado de la consulta
 * para poder avisar si la tasa lleva días sin actualizarse.
 *
 * Normalmente basta con la primera fuente que responde. Si todavía no hay ninguna tasa vigente
 * (instalación nueva), se consultan también las demás: el BCV publica por la tarde la tasa del
 * día siguiente y, hasta medianoche, solo el respaldo conoce la de hoy.
 */
export async function refreshRates(
  db: Db,
  opts: { now: number; fetcher?: typeof fetch; sources?: RateSource[] },
): Promise<RefreshReport> {
  const pair = getBusinessPair(db)
  if (!pair)
    return {
      ok: false,
      source: null,
      recorded: [],
      rejected: [],
      error: "El negocio aún no está configurado",
    }
  if (pair.quote !== "VES") {
    return {
      ok: false,
      source: null,
      recorded: [],
      rejected: [],
      error: "La tasa BCV solo aplica si la moneda legal es VES",
    }
  }

  const sources = opts.sources ?? DEFAULT_SOURCES
  const save = (check: LastCheck) => writeSetting(db, LAST_CHECK_KEY, check)
  let primary: FetchResult
  try {
    primary = await fetchOfficialRates(sources, opts.fetcher)
  } catch (e) {
    const error = (e as Error).message
    save({ at: opts.now, ok: false, source: null, error, failures: [], rejected: [] })
    return { ok: false, source: null, recorded: [], rejected: [], error }
  }

  const known = new Set(
    db
      .select({ code: currency.code })
      .from(currency)
      .all()
      .map((c) => c.code),
  )
  const recorded: RefreshReport["recorded"] = []
  const rejected: string[] = []
  const store = (result: FetchResult) => {
    const source: RateSourceId = result.source === "bcv" ? "bcv" : "dolarapi"
    for (const q of result.quotes) {
      if (!known.has(q.currency) || q.currency === pair.quote) continue
      try {
        const { inserted } = recordRate(
          db,
          {
            base: q.currency,
            quote: pair.quote,
            value: q.value,
            source,
            effectiveAt: q.effectiveAt,
            createdBy: null,
          },
          opts.now,
        )
        if (inserted)
          recorded.push({ currency: q.currency, value: q.value, effectiveAt: q.effectiveAt })
      } catch (e) {
        if (!(e instanceof SuspiciousRateError)) throw e
        rejected.push(e.message)
      }
    }
  }
  store(primary)

  if (!rateAt(db, pair.base, pair.quote, opts.now)) {
    for (const other of sources.filter((s) => s.id !== primary.source)) {
      try {
        store(await fetchOfficialRates([other], opts.fetcher))
      } catch {
        // si otra fuente no responde no pasa nada: ya hay una consulta buena registrada
      }
    }
  }

  // Si la moneda de referencia fue rechazada, la consulta no cuenta como buena.
  const referenceRejected = rejected.some((r) => r.startsWith(`${pair.base}/`))
  const ok = !referenceRejected
  const error = referenceRejected
    ? "Tasa sospechosa rechazada; confírmala a mano si es correcta"
    : null
  save({
    at: opts.now,
    ok,
    source: primary.source,
    error,
    failures: primary.failures.map((f) => f.message),
    rejected,
  })
  return { ok, source: primary.source, recorded, rejected, error }
}

export interface RateStatus {
  pair: { base: string; quote: string } | null
  current: StoredRate | null
  lastCheck: LastCheck | null
  /** No hay tasa vigente o la última lleva demasiado tiempo. */
  stale: boolean
}

export function rateStatus(db: Db, now: number): RateStatus {
  const pair = getBusinessPair(db)
  const lastCheck = readSetting<LastCheck>(db, LAST_CHECK_KEY) ?? null
  const current = pair ? (rateAt(db, pair.base, pair.quote, now) ?? null) : null
  return {
    pair: pair ?? null,
    current,
    lastCheck,
    stale: !current || now - current.effectiveAt > STALE_AFTER_MS,
  }
}

/** Tasa vigente del par del negocio, o error 409 si no hay: sin tasa no se puede vender en dos monedas. */
export function requireCurrentRate(db: Db, now: number): StoredRate {
  const pair = getBusinessPair(db)
  const current = pair ? rateAt(db, pair.base, pair.quote, now) : undefined
  if (!current) throw new HttpError(409, "NO_RATE", "No hay una tasa de cambio vigente")
  return current
}

/**
 * Última tasa que NO fue manual. La comprobación de saltos bruscos compara contra esta y no
 * contra una manual, para que un error de tecleo no bloquee las tasas oficiales correctas.
 */
function latestAutomatic(
  db: Pick<Db, "select">,
  base: string,
  quote: string,
): StoredRate | undefined {
  return db
    .select()
    .from(exchangeRate)
    .where(
      and(
        eq(exchangeRate.base, base),
        eq(exchangeRate.quote, quote),
        ne(exchangeRate.source, "manual"),
      ),
    )
    .orderBy(desc(exchangeRate.effectiveAt), desc(exchangeRate.createdAt))
    .limit(1)
    .get()
}
