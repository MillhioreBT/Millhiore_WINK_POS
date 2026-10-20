import { SECTIGO_R36_PEM } from "./certs"

// Tasas oficiales del BCV. No hay API oficial: se lee la página pública y, si falla, un espejo.
// Todo se devuelve con decimal punto y 8 cifras, en texto, para no pasar nunca por floats.

export interface Quote {
  /** Moneda cotizada frente al bolívar (USD, EUR, CNY, TRY, RUB). */
  currency: string
  /** Bs por 1 unidad de `currency`, con 8 decimales: "879.12250000". */
  value: string
  /** Inicio de vigencia ("Fecha Valor"), en milisegundos Unix. */
  effectiveAt: number
}

export interface RateSource {
  id: string
  fetch(fetcher?: typeof fetch): Promise<Quote[]>
}

export class RateSourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(`[${source}] ${message}`)
    this.name = "RateSourceError"
  }
}

const DECIMALS = 8

/** "879,12250000" | "1.234,5" | "877.9023" → "879.12250000" (8 decimales). Lanza si no es un número válido. */
export function normalizeDecimal(raw: string): string {
  let text = raw.trim()
  if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".") // formato es-VE
  if (!/^\d+(\.\d+)?$/.test(text)) throw new RangeError(`Número inválido: "${raw}"`)
  const [int = "0", frac = ""] = text.split(".")
  if (frac.length > DECIMALS) throw new RangeError(`Más de ${DECIMALS} decimales: "${raw}"`)
  const value = `${int.replace(/^0+(?=\d)/, "")}.${frac.padEnd(DECIMALS, "0")}`
  if (/^0\.0+$/.test(value)) throw new RangeError("La tasa debe ser mayor que cero")
  return value
}

const BLOCKS = ["dolar", "euro", "yuan", "lira", "rublo"] as const

/** Extrae las cotizaciones de la página principal de bcv.org.ve. */
export function parseBcvHtml(html: string): Quote[] {
  const date = /Fecha Valor:[\s\S]*?content="(\d{4}-\d{2}-\d{2}T[^"]+)"/.exec(html)?.[1]
  const effectiveAt = date ? Date.parse(date) : Number.NaN
  if (Number.isNaN(effectiveAt)) throw new RateSourceError("bcv", "No se encontró la Fecha Valor")

  const quotes: Quote[] = []
  for (const id of BLOCKS) {
    const start = html.indexOf(`id="${id}"`)
    if (start === -1) continue
    const block = html.slice(start, start + 1200)
    const currency = /<span>\s*([A-Z]{3})\s*<\/span>/.exec(block)?.[1]
    const value = /<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/.exec(block)?.[1]
    if (!currency || !value) continue
    quotes.push({ currency, value: normalizeDecimal(value), effectiveAt })
  }
  if (!quotes.some((q) => q.currency === "USD")) {
    throw new RateSourceError("bcv", "No se encontró la cotización del USD")
  }
  return quotes
}

const USER_AGENT = "MillhioreWINK/0.0 (+https://github.com/Millhiore/WINK)"

async function get(
  source: string,
  url: string,
  fetcher: typeof fetch,
  extra: object = {},
): Promise<Response> {
  let res: Response
  try {
    res = await fetcher(url, {
      ...extra,
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    throw new RateSourceError(source, `No se pudo conectar: ${(e as Error).message}`)
  }
  if (!res.ok) throw new RateSourceError(source, `HTTP ${res.status}`)
  return res
}

/** Fuente principal: la página pública del BCV. */
export const bcvSite: RateSource = {
  id: "bcv",
  async fetch(fetcher = fetch) {
    // El BCV no envía su intermedio correcto: se añade (Bun admite `tls.ca` como CA adicional).
    const res = await get("bcv", "https://www.bcv.org.ve/", fetcher, {
      tls: { ca: [SECTIGO_R36_PEM] },
    })
    try {
      return parseBcvHtml(await res.text())
    } catch (e) {
      if (e instanceof RateSourceError) throw e
      throw new RateSourceError("bcv", (e as Error).message)
    }
  },
}

/** Respaldo: espejo comunitario de la tasa oficial. Suele ir un día por detrás de la web del BCV. */
export const dolarApi: RateSource = {
  id: "dolarapi",
  async fetch(fetcher = fetch) {
    const quotes: Quote[] = []
    for (const [currency, path] of [
      ["USD", "dolares"],
      ["EUR", "euros"],
    ] as const) {
      const res = await get("dolarapi", `https://ve.dolarapi.com/v1/${path}/oficial`, fetcher)
      const body = (await res.json()) as { promedio?: number | null; fechaActualizacion?: string }
      const effectiveAt = Date.parse(body.fechaActualizacion ?? "")
      if (typeof body.promedio !== "number" || Number.isNaN(effectiveAt)) {
        throw new RateSourceError("dolarapi", `Respuesta inesperada para ${currency}`)
      }
      try {
        quotes.push({ currency, value: normalizeDecimal(String(body.promedio)), effectiveAt })
      } catch (e) {
        throw new RateSourceError("dolarapi", (e as Error).message)
      }
    }
    return quotes
  },
}

export interface FetchResult {
  source: string
  quotes: Quote[]
  /** Fuentes que fallaron antes de llegar a la que respondió. */
  failures: RateSourceError[]
}

/** Prueba las fuentes en orden y devuelve la primera que responde bien. Si todas fallan, lanza AggregateError. */
export async function fetchOfficialRates(
  sources: readonly RateSource[] = DEFAULT_SOURCES,
  fetcher: typeof fetch = fetch,
): Promise<FetchResult> {
  const failures: RateSourceError[] = []
  for (const source of sources) {
    try {
      return { source: source.id, quotes: await source.fetch(fetcher), failures }
    } catch (e) {
      failures.push(
        e instanceof RateSourceError ? e : new RateSourceError(source.id, (e as Error).message),
      )
    }
  }
  throw new AggregateError(
    failures,
    `Ninguna fuente de tasas respondió: ${failures.map((f) => f.message).join("; ")}`,
  )
}

/** Orden de consulta por defecto: la web oficial y, si falla, el espejo. */
export const DEFAULT_SOURCES: readonly RateSource[] = [bcvSite, dolarApi]
