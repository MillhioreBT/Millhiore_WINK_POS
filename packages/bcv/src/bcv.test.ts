import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { SECTIGO_R36_FINGERPRINT_SHA256, SECTIGO_R36_PEM } from "./certs"
import {
  bcvSite,
  dolarApi,
  fetchOfficialRates,
  normalizeDecimal,
  parseBcvHtml,
  RateSourceError,
} from "./index"

const fixture = await Bun.file(join(import.meta.dir, "../fixtures/bcv-2026-10-14.html")).text()

const stubFetch = (handler: (url: string) => Response | Promise<Response>) =>
  (async (input: string | URL | Request) => handler(String(input))) as unknown as typeof fetch

describe("normalizeDecimal", () => {
  test("formato es-VE y punto decimal", () => {
    expect(normalizeDecimal("879,12250000")).toBe("879.12250000")
    expect(normalizeDecimal(" 1.234,5 ")).toBe("1234.50000000")
    expect(normalizeDecimal("877.9023")).toBe("877.90230000")
    expect(normalizeDecimal("36")).toBe("36.00000000")
    expect(normalizeDecimal("0,5")).toBe("0.50000000")
  })

  test("rechaza lo que no es una tasa", () => {
    for (const bad of ["", "abc", "0", "0,00000000", "-1", "1,2,3", "1.123456789"]) {
      expect(() => normalizeDecimal(bad)).toThrow(RangeError)
    }
  })
})

describe("parseBcvHtml", () => {
  test("lee las cinco cotizaciones y la Fecha Valor de la página real", () => {
    const quotes = parseBcvHtml(fixture)
    expect(Object.fromEntries(quotes.map((q) => [q.currency, q.value]))).toEqual({
      EUR: "977.68092347",
      CNY: "131.36720909",
      TRY: "17.80086663",
      RUB: "10.48211611",
      USD: "879.12250000",
    })
    // "Fecha Valor" = 15-oct-2026 00:00 en Caracas (UTC−4)
    expect(new Set(quotes.map((q) => q.effectiveAt))).toEqual(
      new Set([Date.parse("2026-10-15T04:00:00Z")]),
    )
  })

  test("falla con claridad si la página cambia de estructura", () => {
    expect(() => parseBcvHtml("<html></html>")).toThrow(/Fecha Valor/)
    const noUsd = fixture.replace('id="dolar"', 'id="otro"')
    expect(() => parseBcvHtml(noUsd)).toThrow(/USD/)
  })
})

describe("fuentes", () => {
  test("bcvSite usa la página y reporta errores HTTP", async () => {
    const ok = await bcvSite.fetch(stubFetch(() => new Response(fixture)))
    expect(ok.find((q) => q.currency === "USD")?.value).toBe("879.12250000")
    await expect(
      bcvSite.fetch(stubFetch(() => new Response("x", { status: 503 }))),
    ).rejects.toThrow(/HTTP 503/)
    await expect(
      bcvSite.fetch((async () => {
        throw new Error("ECONNRESET")
      }) as unknown as typeof fetch),
    ).rejects.toThrow(/ECONNRESET/)
  })

  test("dolarApi lee USD y EUR", async () => {
    const quotes = await dolarApi.fetch(
      stubFetch((url) =>
        Response.json({
          promedio: url.includes("euros") ? 982.75895071 : 877.9023,
          fechaActualizacion: "2026-10-14T00:00:00-04:00",
        }),
      ),
    )
    expect(quotes.map((q) => [q.currency, q.value])).toEqual([
      ["USD", "877.90230000"],
      ["EUR", "982.75895071"],
    ])
    await expect(
      dolarApi.fetch(stubFetch(() => Response.json({ promedio: null }))),
    ).rejects.toThrow(RateSourceError)
  })
})

describe("fetchOfficialRates", () => {
  test("usa el respaldo cuando la fuente principal falla y lo registra", async () => {
    const fetcher = stubFetch((url) =>
      url.includes("bcv.org.ve")
        ? new Response("caído", { status: 500 })
        : Response.json({ promedio: 877.9023, fechaActualizacion: "2026-10-14T00:00:00-04:00" }),
    )
    const result = await fetchOfficialRates([bcvSite, dolarApi], fetcher)
    expect(result.source).toBe("dolarapi")
    expect(result.failures.map((f) => f.source)).toEqual(["bcv"])
  })

  test("sin fuentes disponibles lanza AggregateError con el detalle", async () => {
    const fetcher = stubFetch(() => new Response("x", { status: 500 }))
    const err = await fetchOfficialRates([bcvSite, dolarApi], fetcher).catch((e) => e)
    expect(err).toBeInstanceOf(AggregateError)
    expect((err as AggregateError).errors).toHaveLength(2)
  })

  test("la fuente principal gana si responde", async () => {
    const result = await fetchOfficialRates(
      [bcvSite, dolarApi],
      stubFetch(() => new Response(fixture)),
    )
    expect(result).toMatchObject({ source: "bcv", failures: [] })
  })
})

describe("certificado intermedio", () => {
  test("el PEM incluido es el esperado (huella SHA-256)", () => {
    const body = SECTIGO_R36_PEM.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, "")
    const hex = createHash("sha256").update(Buffer.from(body, "base64")).digest("hex").toUpperCase()
    expect(hex.match(/../g)?.join(":")).toBe(SECTIGO_R36_FINGERPRINT_SHA256)
  })

  test("la consulta al BCV lo envía como CA adicional; las del espejo no", async () => {
    const seen: Record<string, unknown> = {}
    const spy = (async (input: string | URL | Request, init?: object) => {
      seen[String(input)] = init
      return String(input).includes("bcv.org.ve")
        ? new Response(fixture)
        : Response.json({ promedio: 1, fechaActualizacion: "2026-10-14T00:00:00-04:00" })
    }) as unknown as typeof fetch
    await bcvSite.fetch(spy)
    await dolarApi.fetch(spy)
    expect((seen["https://www.bcv.org.ve/"] as { tls: { ca: string[] } }).tls.ca).toEqual([
      SECTIGO_R36_PEM,
    ])
    expect(seen["https://ve.dolarapi.com/v1/dolares/oficial"]).not.toHaveProperty("tls")
  })
})
