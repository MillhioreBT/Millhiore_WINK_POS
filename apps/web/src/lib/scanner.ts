import type { CatalogItem } from "@millhiore/contracts"
import type { BarcodeDetector } from "barcode-detector/ponyfill"

// Lector de códigos de barras con la cámara. Usa zxing (WebAssembly) en todos los navegadores, para
// que lea igual en Android, iPhone y la PC. El .wasm se sirve desde la propia app (no de un CDN):
// funciona sin internet. Se carga solo la primera vez que alguien escanea.

const FORMATS = [
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "code_93",
  "codabar",
  "itf",
  "qr_code",
] as const

let detector: Promise<BarcodeDetector> | null = null

export function barcodeDetector(): Promise<BarcodeDetector> {
  detector ??= (async () => {
    const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
      import("barcode-detector/ponyfill"),
      import("zxing-wasm/reader/zxing_reader.wasm?url"),
    ])
    prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) =>
          path.endsWith(".wasm") ? wasmUrl : prefix + path,
      },
    })
    return new BarcodeDetector({ formats: [...FORMATS] })
  })().catch((e) => {
    detector = null
    throw e
  })
  return detector
}

/** El primer código que se lee en una imagen, un cuadro de video o una foto; null si no hay. */
export async function readCode(source: ImageBitmapSource): Promise<string | null> {
  const found = await (await barcodeDetector()).detect(source as never)
  return found.find((b) => b.rawValue.trim())?.rawValue.trim() ?? null
}

/**
 * La cámara en vivo solo se abre en un contexto seguro (HTTPS, o la PC del servidor con
 * localhost). Un celular que entra por la red local con http:// toma una foto del código.
 */
export function liveCameraAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  )
}

/** El producto con ese código de barras o código interno (SKU). */
export function findByCode(items: readonly CatalogItem[], code: string): CatalogItem | undefined {
  const c = code.trim().toLowerCase()
  return items.find((p) => p.barcode?.toLowerCase() === c || p.sku.toLowerCase() === c)
}
