import { describe, expect, test } from "bun:test"
import { dayOfMonth, nextDueDay } from "./recurrence"

describe("gastos recurrentes: siguiente vencimiento", () => {
  test("cada semana y cada dos semanas", () => {
    expect(nextDueDay("weekly", "2026-10-15", 15)).toBe("2026-10-22")
    expect(nextDueDay("weekly", "2026-12-28", 28)).toBe("2027-01-04")
    expect(nextDueDay("biweekly", "2026-10-15", 15)).toBe("2026-10-29")
    expect(nextDueDay("biweekly", "2026-12-25", 25)).toBe("2027-01-08")
  })

  test("cada mes conserva el día y pasa de diciembre a enero", () => {
    expect(nextDueDay("monthly", "2026-10-05", 5)).toBe("2026-11-05")
    expect(nextDueDay("monthly", "2026-12-05", 5)).toBe("2027-01-05")
  })

  test("el día 31 cae en el último día de los meses cortos y vuelve al 31 después", () => {
    let day = "2026-01-31"
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      day = nextDueDay("monthly", day, 31)
      seen.push(day)
    }
    expect(seen).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"])
    // Año bisiesto
    expect(nextDueDay("monthly", "2028-01-31", 31)).toBe("2028-02-29")
  })

  test("cada año: el 29 de febrero cae el 28 y vuelve al 29 en el bisiesto", () => {
    expect(nextDueDay("yearly", "2026-03-10", 10)).toBe("2027-03-10")
    expect(nextDueDay("yearly", "2024-02-29", 29)).toBe("2025-02-28")
    expect(nextDueDay("yearly", "2027-02-28", 29)).toBe("2028-02-29")
  })

  test("el día del mes de una fecha y las fechas inválidas", () => {
    expect(dayOfMonth("2026-10-07")).toBe(7)
    expect(dayOfMonth("2026-10-31")).toBe(31)
    expect(() => nextDueDay("monthly", "2026-02-30", 30)).toThrow()
  })
})
