import { describe, expect, test } from "bun:test"
import { waitLevel } from "./KitchenPage"

describe("pantalla de cocina", () => {
  test("el tiempo de espera se pone amarillo al 75 % y rojo al pasar el de la estación", () => {
    expect(waitLevel(5, 15)).toBe("ok")
    expect(waitLevel(12, 15)).toBe("late")
    expect(waitLevel(15, 15)).toBe("over")
    expect(waitLevel(40, 15)).toBe("over")
  })
})
