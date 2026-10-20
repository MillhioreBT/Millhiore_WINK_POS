import { describe, expect, test } from "bun:test"
import { addDays, dayRange, isValidDate, localDate, localHour, zoneOffset } from "./time"

const CCS = "America/Caracas"

describe("días en la zona del negocio", () => {
  test("Caracas está 4 horas detrás de UTC", () => {
    expect(zoneOffset(Date.UTC(2026, 9, 14, 12), CCS)).toBe(-4 * 3_600_000)
  })

  test("el día de Caracas va de las 04:00 UTC a las 04:00 UTC del día siguiente", () => {
    const { from, to } = dayRange("2026-10-14", CCS)
    expect(new Date(from).toISOString()).toBe("2026-10-14T04:00:00.000Z")
    expect(new Date(to).toISOString()).toBe("2026-10-15T04:00:00.000Z")
  })

  test("una venta a las 11 p. m. de Caracas ya es otro día en UTC, pero no en el negocio", () => {
    const at = Date.UTC(2026, 9, 15, 3, 30) // 14/10 23:30 en Caracas
    expect(localDate(at, CCS)).toBe("2026-10-14")
    expect(localHour(at, CCS)).toBe(23)
    const { from, to } = dayRange("2026-10-14", CCS)
    expect(at >= from && at < to).toBe(true)
  })

  test("con horario de verano el día dura 23 o 25 horas", () => {
    const spring = dayRange("2026-03-08", "America/New_York")
    expect(spring.to - spring.from).toBe(23 * 3_600_000)
    const fall = dayRange("2026-11-01", "America/New_York")
    expect(fall.to - fall.from).toBe(25 * 3_600_000)
  })

  test("aritmética de fechas", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28")
    expect(addDays("2024-12-31", 1)).toBe("2025-01-01")
    expect(isValidDate("2026-02-30")).toBe(false)
    expect(isValidDate("14/10/2026")).toBe(false)
    expect(isValidDate("2028-02-29")).toBe(true)
  })
})
