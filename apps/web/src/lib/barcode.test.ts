import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader"
import { barcodeFor, CODE128, code128Values, eanCheckDigit, QUIET_ZONE } from "./barcode"

// El lector de la cámara (zxing) lee lo que se dibuja: así se prueba con un lector de verdad.
const require = createRequire(import.meta.url)
prepareZXingModule({
  overrides: { wasmBinary: readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm")) },
})

/** Dibuja los módulos (3 píxeles cada uno, con margen) en una imagen PGM en escala de grises. */
function image(modules: string): Uint8Array {
  const scale = 3
  const height = 60
  const row = `${"0".repeat(QUIET_ZONE)}${modules}${"0".repeat(QUIET_ZONE)}`
  const width = row.length * scale
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`)
  const pixels = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[y * width + x] = row[Math.floor(x / scale)] === "1" ? 0 : 255
    }
  }
  const out = new Uint8Array(header.length + pixels.length)
  out.set(header)
  out.set(pixels, header.length)
  return out
}

async function read(value: string) {
  const code = barcodeFor(value)
  if (!code) throw new Error(`sin código para ${value}`)
  const [found] = await readBarcodes(image(code.modules), { tryHarder: true })
  return { format: code.format, read: found?.text, readFormat: found?.format }
}

describe("códigos de barras de las etiquetas", () => {
  test("dígito de control de EAN y UPC", () => {
    expect(eanCheckDigit("400638133393")).toBe(1)
    expect(eanCheckDigit("759123456789")).toBe(4)
    expect(eanCheckDigit("9638507")).toBe(4)
    expect(eanCheckDigit("03600029145")).toBe(2)
  })

  test("la tabla de Code 128: 107 símbolos distintos de 11 módulos (la parada, 13)", () => {
    expect(CODE128).toHaveLength(107)
    expect(new Set(CODE128).size).toBe(107)
    for (const [i, p] of CODE128.entries()) {
      const sum = [...p].reduce((acc, w) => acc + Number(w), 0)
      expect(sum).toBe(i === 106 ? 13 : 11)
    }
  })

  test("Code 128 usa el juego C para las tiras de dígitos y su control cuadra", () => {
    // Start B, P, 0 0 0 0 2 - 1 → con dígitos al medio en C solo si son seis o más.
    expect(code128Values("P00002-1")?.slice(0, 2)).toEqual([104, 48])
    expect(code128Values("12345678")).toEqual([105, 12, 34, 56, 78, 47])
    expect(code128Values("ñandú")).toBeNull()
    expect(code128Values("")).toBeNull()
  })

  test("elige EAN-13, UPC-A o EAN-8 si el dígito de control cuadra; si no, Code 128", () => {
    expect(barcodeFor("7591234567894")?.format).toBe("EAN13")
    expect(barcodeFor("7591234567890")?.format).toBe("CODE128")
    expect(barcodeFor("036000291452")?.format).toBe("UPCA")
    expect(barcodeFor("96385074")?.format).toBe("EAN8")
    expect(barcodeFor("P00002-1")?.format).toBe("CODE128")
    expect(barcodeFor("Camisa ñ")).toBeNull()
    expect(barcodeFor("7591234567894")?.modules).toHaveLength(95)
    expect(barcodeFor("96385074")?.modules).toHaveLength(67)
  })

  test("el lector de la cámara lee lo que se dibuja", async () => {
    expect(await read("7591234567894")).toMatchObject({
      read: "7591234567894",
      readFormat: "EAN13",
    })
    // Un UPC-A es un EAN-13 que empieza por 0: el lector lo da con ese 0 delante.
    expect(await read("036000291452")).toMatchObject({ read: "0036000291452" })
    expect(await read("96385074")).toMatchObject({ read: "96385074", readFormat: "EAN8" })
    for (const value of [
      "P00002-1",
      "CAM-XL",
      "12345678",
      "AB123456789012cd",
      "x1y",
      "Ropa 2026",
    ]) {
      expect(await read(value)).toMatchObject({ read: value, readFormat: "Code128" })
    }
  })
})
