import { describe, expect, test } from "bun:test"
import { whatsappNumber } from "./phone"

describe("whatsappNumber", () => {
  test("un celular venezolano pasa al formato de wa.me", () => {
    expect(whatsappNumber("0414-1234567")).toBe("584141234567")
    expect(whatsappNumber("+58 412 555 0101")).toBe("584125550101")
  })
  test("lo que no parece un teléfono no sirve", () => {
    expect(whatsappNumber("123")).toBeNull()
    expect(whatsappNumber(null)).toBeNull()
    expect(whatsappNumber("")).toBeNull()
  })
})
