import { describe, expect, test } from "bun:test"
import { changeBp, previousRange } from "./compare"

describe("previousRange", () => {
  test("un mes entero se compara con el mes anterior entero", () => {
    expect(previousRange({ from: "2026-03-01", to: "2026-03-31" })).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
      label: "el mes anterior",
    })
  })

  test("lo que va del mes, contra el mes anterior hasta el mismo día (sin pasarse de su final)", () => {
    expect(previousRange({ from: "2026-10-01", to: "2026-10-24" })).toMatchObject({
      from: "2026-09-01",
      to: "2026-09-24",
    })
    expect(previousRange({ from: "2026-03-01", to: "2026-03-30" })).toMatchObject({
      from: "2026-02-01",
      to: "2026-02-28",
    })
    expect(previousRange({ from: "2026-01-01", to: "2026-01-15" })).toMatchObject({
      from: "2025-12-01",
      to: "2025-12-15",
    })
  })

  test("lo que va del año, contra lo mismo del año pasado", () => {
    expect(previousRange({ from: "2028-01-01", to: "2028-02-29" })).toEqual({
      from: "2027-01-01",
      to: "2027-02-28",
      label: "el año anterior",
    })
  })

  test("cualquier otro rango, contra los mismos días justo antes", () => {
    expect(previousRange({ from: "2026-10-24", to: "2026-10-24" })).toEqual({
      from: "2026-10-23",
      to: "2026-10-23",
      label: "el día anterior",
    })
    expect(previousRange({ from: "2026-10-18", to: "2026-10-24" })).toEqual({
      from: "2026-10-11",
      to: "2026-10-17",
      label: "los 7 días anteriores",
    })
  })
})

test("changeBp", () => {
  expect(changeBp(1125, 1000)).toBe(1250)
  expect(changeBp(500, 1000)).toBe(-5000)
  expect(changeBp(-50, -100)).toBe(5000)
  expect(changeBp(10, 0)).toBeNull()
})
