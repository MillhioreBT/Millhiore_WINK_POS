import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader"
import { qrCode, qrSvg } from "./qr"

// El lector de la cámara (zxing) lee lo que se dibuja: así se prueba con un lector de verdad.
const require = createRequire(import.meta.url)
prepareZXingModule({
  overrides: { wasmBinary: readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm")) },
})

/** Dibuja el QR (4 píxeles por módulo, con su margen de 4 módulos) en una imagen PGM. */
function image(modules: boolean[][]): Uint8Array {
  const scale = 4
  const size = (modules.length + 8) * scale
  const header = new TextEncoder().encode(`P5\n${size} ${size}\n255\n`)
  const pixels = new Uint8Array(size * size).fill(255)
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (!dark) return
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          pixels[((y + 4) * scale + dy) * size + (x + 4) * scale + dx] = 0
        }
      }
    })
  })
  const out = new Uint8Array(header.length + pixels.length)
  out.set(header)
  out.set(pixels, header.length)
  return out
}

async function read(text: string) {
  const modules = qrCode(text)
  const [found] = await readBarcodes(image(modules), { formats: ["QRCode"] })
  return { size: modules.length, text: found?.text }
}

describe("códigos QR", () => {
  test("una dirección de la red local se lee igual", async () => {
    const url = "http://192.168.1.10:3000"
    expect(await read(url)).toEqual({ size: 25, text: url })
  })

  test("direcciones más largas usan versiones más grandes (con patrones de alineación)", async () => {
    for (const text of [
      "https://192.168.100.200:3443/api/tls/ca.crt",
      "https://caja-principal.local:3443/caja?terminal=C1&origen=qr-de-ajustes",
      `https://ejemplo.local/${"x".repeat(120)}`,
      // Versión 10 (cambia el largo del contador a 16 bits) y caracteres no ASCII.
      `Señal ñandú ${"á".repeat(90)}`,
    ]) {
      const result = await read(text)
      expect(result.text).toBe(text)
    }
  })

  test("lo que no cabe se rechaza y el SVG lleva su margen", () => {
    expect(() => qrCode("x".repeat(300))).toThrow("demasiado largo")
    const svg = qrSvg("http://192.168.1.10:3000")
    expect(svg).toContain('viewBox="0 0 33 33"')
    expect(svg.startsWith("<svg")).toBe(true)
  })
})
