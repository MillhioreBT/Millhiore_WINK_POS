import { describe, expect, test } from "bun:test"
import { amount, key, text, yesNo } from "./cells"

describe("celdas importadas", () => {
  test("montos escritos a la venezolana o como los guarda Excel", () => {
    expect(amount("1.234,56")).toBe(123456)
    expect(amount("1234,56")).toBe(123456)
    expect(amount("1234.56")).toBe(123456)
    expect(amount("1,5")).toBe(150)
    expect(amount("1.500")).toBe(150000) // punto de miles
    expect(amount("1.50")).toBe(150)
    expect(amount("$ 2,00")).toBe(200)
    expect(amount("Bs 20")).toBe(2000)
    expect(amount(1.1)).toBe(110)
    expect(amount(0.1 + 0.2)).toBe(30)
    expect(amount("2,5", 3)).toBe(2500)
  })

  test("vacío es undefined; lo que no es un número no negativo es null", () => {
    expect(amount(null)).toBeUndefined()
    expect(amount("  ")).toBeUndefined()
    expect(amount("abc")).toBeNull()
    expect(amount("-3")).toBeNull()
    expect(amount(-3)).toBeNull()
    expect(amount("1,2,3")).toBe(12300) // varias comas: separan miles
  })

  test("textos y códigos de barras largos sin notación científica", () => {
    expect(text("  Pan  ")).toBe("Pan")
    expect(text("")).toBeNull()
    expect(text(7591234567890)).toBe("7591234567890")
    expect(text(1.5)).toBe("1.5")
  })

  test("sí/no y nombres comparables", () => {
    expect(yesNo("Sí")).toBe(true)
    expect(yesNo("no")).toBe(false)
    expect(yesNo("quizás")).toBeUndefined()
    expect(key("  Bebidas  Frías ")).toBe("bebidas frias")
  })
})
