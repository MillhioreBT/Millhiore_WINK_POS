import { describe, expect, test } from "bun:test"
import type { AuditEntry } from "@millhiore/contracts"
import { actionLabel, entryDetail } from "./auditLabels"
import { dayRange, daysBefore, todayInCaracas } from "./days"
import { describeAgent, isPhone } from "./userAgent"

const entry = (patch: Partial<AuditEntry>): AuditEntry => ({
  id: "a",
  at: 0,
  action: "document.posted",
  actorId: "u",
  actorName: "Dueña",
  entityType: "document",
  entityId: "d",
  data: null,
  ...patch,
})

describe("días de Caracas", () => {
  test("un día va de las 00:00 en Caracas (UTC−4) a las 00:00 siguientes", () => {
    const { from, to } = dayRange("2026-03-10")
    expect(new Date(from).toISOString()).toBe("2026-03-10T04:00:00.000Z")
    expect(to - from).toBe(86_400_000)
  })

  test("la medianoche de Caracas todavía es «hoy» y antes de las 04:00 UTC es «ayer»", () => {
    expect(todayInCaracas(Date.UTC(2026, 2, 10, 4, 0, 0))).toBe("2026-03-10")
    expect(todayInCaracas(Date.UTC(2026, 2, 10, 3, 59, 59))).toBe("2026-03-09")
  })

  test("retrocede días sin saltarse el fin de mes", () => {
    expect(daysBefore("2026-03-02", 6)).toBe("2026-02-24")
    expect(daysBefore("2026-01-03", 5)).toBe("2025-12-29")
    expect(daysBefore("2026-03-02", 0)).toBe("2026-03-02")
  })
})

describe("equipo de la sesión", () => {
  test("reconoce navegador y sistema", () => {
    expect(
      describeAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      ),
    ).toBe("Chrome en Windows")
    expect(
      describeAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 OPR/115.0",
      ),
    ).toBe("Opera en Windows")
    expect(
      describeAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari en iPhone")
    expect(
      describeAgent(
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome en Android")
  })

  test("sin dato o con uno raro no inventa nada", () => {
    expect(describeAgent(null)).toBe("Equipo desconocido")
    expect(describeAgent("curl/8.0")).toBe("Equipo desconocido")
    expect(isPhone(null)).toBe(false)
    expect(isPhone("Mozilla/5.0 (Linux; Android 14) Mobile")).toBe(true)
  })
})

describe("bitácora legible", () => {
  test("traduce las acciones conocidas y deja tal cual las demás", () => {
    expect(actionLabel("document.voided")).toBe("Anuló un documento")
    expect(actionLabel("algo.nuevo")).toBe("algo.nuevo")
  })

  test("resume documentos por su número y tipo", () => {
    expect(entryDetail(entry({ data: { number: "C1-000007", type: "SALE" } }))).toBe(
      "Venta C1-000007",
    )
    expect(entryDetail(entry({ data: { number: "C1-DV-000001", type: "RETURN" } }))).toBe(
      "Devolución C1-DV-000001",
    )
    expect(entryDetail(entry({ data: { number: "X-1", type: "RARO" } }))).toBe("RARO X-1")
  })

  test("no inventa detalle cuando no lo hay y cuenta sesiones cerradas", () => {
    expect(entryDetail(entry({ data: null }))).toBeNull()
    expect(entryDetail(entry({ entityType: "user", action: "user.pin.set", data: {} }))).toBeNull()
    expect(
      entryDetail(
        entry({ entityType: "session", action: "session.revoked.others", data: { count: 1 } }),
      ),
    ).toBe("1 sesión")
    expect(
      entryDetail(
        entry({ entityType: "session", action: "session.revoked.others", data: { count: 3 } }),
      ),
    ).toBe("3 sesiones")
  })

  test("cuenta los productos de un cambio de precios en lote", () => {
    const bulk = (count: number) =>
      entryDetail(entry({ entityType: "product", action: "product.prices.bulk", data: { count } }))
    expect(bulk(1)).toBe("1 producto")
    expect(bulk(12)).toBe("12 productos")
    expect(actionLabel("product.prices.bulk")).toBe("Cambió precios en lote")
  })
})
