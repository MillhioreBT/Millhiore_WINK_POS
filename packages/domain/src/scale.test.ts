import { describe, expect, test } from "bun:test"
import { eanCheckDigit, parseScaleReading, parseWeightBarcode, qtyForAmount } from "./scale"

const byWeight = { prefixes: ["20", "21"], pluDigits: 5, value: "weight" as const }

describe("etiquetas de la balanza", () => {
  test("el producto y el peso salen del código", () => {
    expect(eanCheckDigit("200001200350")).toBe(9)
    // Prefijo 20, PLU 00012, 00350 g y el dígito de control.
    expect(parseWeightBarcode("2000012003509", byWeight)).toEqual({ plu: 12, weightMilli: 350 })
    // Con 4 dígitos de PLU quedan 6 para el precio, en céntimos: Bs 3.012,50.
    expect(
      parseWeightBarcode("2100123012503", { prefixes: ["21"], pluDigits: 4, value: "price" }),
    ).toEqual({ plu: 12, priceMinor: 301_250 })
  })

  test("lo que no es de la balanza no se lee como tal", () => {
    // Dígito de control equivocado (un error de lectura).
    expect(parseWeightBarcode("2000012003508", byWeight)).toBeNull()
    // Otro prefijo: es un código propio del negocio o de un producto.
    expect(parseWeightBarcode("2200012003503", byWeight)).toBeNull()
    expect(parseWeightBarcode("7591234567890", byWeight)).toBeNull()
    // Peso cero, o no son 13 dígitos.
    expect(parseWeightBarcode("2000012000003", byWeight)).toBeNull()
    expect(parseWeightBarcode("200001200350", byWeight)).toBeNull()
    expect(parseWeightBarcode("P00012", byWeight)).toBeNull()
  })

  test("cuánto lleva un monto", () => {
    // 5 $ de queso a 12 $ el kilo: 0,41666… → 0,417 kg.
    expect(qtyForAmount(500, 1200)).toBe(417)
    expect(qtyForAmount(1200, 1200)).toBe(1000)
    expect(qtyForAmount(500, 0)).toBeNull()
    expect(qtyForAmount(0, 1200)).toBeNull()
  })
})

describe("lectura de la balanza por el puerto serie", () => {
  test("los formatos más comunes", () => {
    // CAS y compatibles: estable (ST) o en movimiento (US).
    expect(parseScaleReading("ST,GS,+  0.350kg\r\n")).toEqual({ weightMilli: 350, stable: true })
    expect(parseScaleReading("US,GS,+  0.352kg\r\n")).toEqual({ weightMilli: 352, stable: false })
    // Con coma decimal y espacios.
    expect(parseScaleReading("   1,250 kg\r\n")).toEqual({ weightMilli: 1250, stable: true })
    // Toledo: STX y el peso sin punto, en gramos.
    expect(parseScaleReading(`${String.fromCharCode(2)}00350\r`)).toEqual({
      weightMilli: 350,
      stable: true,
    })
    expect(parseScaleReading("350 g")).toEqual({ weightMilli: 350, stable: true })
    expect(parseScaleReading("0.77 lb")).toEqual({ weightMilli: 349, stable: true })
    // El número de la balanza no se confunde con el peso.
    expect(parseScaleReading("N1 0.500kg")).toEqual({ weightMilli: 500, stable: true })
  })

  test("se toma la última lectura completa", () => {
    expect(parseScaleReading("ST,GS,+  0.200kg\r\nST,GS,+  0.350kg\r\nST,GS")).toEqual({
      weightMilli: 350,
      stable: true,
    })
  })

  test("sin peso legible no hay lectura", () => {
    expect(parseScaleReading("")).toBeNull()
    expect(parseScaleReading("OL,GS,+ ------kg")).toBeNull()
    expect(parseScaleReading("ST,GS,-  0.120kg")).toBeNull()
    expect(parseScaleReading("\r\n\r\n")).toBeNull()
    // En cero es una lectura: no hay nada en el plato.
    expect(parseScaleReading("ST,GS,+  0.000kg")).toEqual({ weightMilli: 0, stable: true })
  })
})
