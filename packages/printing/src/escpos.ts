// Comandos ESC/POS: el idioma de casi todas las impresoras térmicas de recibos (Epson, Bixolon,
// Star en modo ESC/POS y las genéricas «POS-58/POS-80» que se venden en Venezuela).

const ESC = 0x1b
const GS = 0x1d

/**
 * Página de códigos PC850 (Europa occidental): la soportan prácticamente todas las térmicas y
 * trae todo lo del español. Se selecciona con ESC t 2.
 */
const PC850_PAGE = 2
// biome-ignore format: tabla de códigos, más legible en filas
const PC850: Record<string, number> = {
  Ç: 0x80, ü: 0x81, é: 0x82, â: 0x83, ä: 0x84, à: 0x85, å: 0x86, ç: 0x87,
  ê: 0x88, ë: 0x89, è: 0x8a, ï: 0x8b, î: 0x8c, ì: 0x8d, Ä: 0x8e, Å: 0x8f,
  É: 0x90, æ: 0x91, Æ: 0x92, ô: 0x93, ö: 0x94, ò: 0x95, û: 0x96, ù: 0x97,
  ÿ: 0x98, Ö: 0x99, Ü: 0x9a, ø: 0x9b, "£": 0x9c, Ø: 0x9d, "×": 0x9e,
  á: 0xa0, í: 0xa1, ó: 0xa2, ú: 0xa3, ñ: 0xa4, Ñ: 0xa5, ª: 0xa6, º: 0xa7,
  "¿": 0xa8, "®": 0xa9, "½": 0xab, "¼": 0xac, "¡": 0xad, "«": 0xae, "»": 0xaf,
  Á: 0xb5, Â: 0xb6, À: 0xb7, "©": 0xb8, ã: 0xc6, Ã: 0xc7,
  Ê: 0xd2, Ë: 0xd3, È: 0xd4, Í: 0xd6, Î: 0xd7, Ï: 0xd8, Ì: 0xde,
  Ó: 0xe0, ß: 0xe1, Ô: 0xe2, Ò: 0xe3, õ: 0xe4, Õ: 0xe5, µ: 0xe6,
  Ú: 0xe9, Û: 0xea, Ù: 0xeb, "±": 0xf1, "°": 0xf8, "·": 0xfa,
}

/** Equivalentes ASCII de lo que no está en PC850. */
// biome-ignore format: tabla
const FALLBACK: Record<string, string> = {
  "—": "-", "–": "-", "≈": "~", "…": "...", "“": '"', "”": '"', "‘": "'", "’": "'",
  "€": "EUR", " ": " ", " ": " ",
}

/** Texto → bytes PC850; lo que no existe se aproxima (sin acento) o se cambia por «?». */
export function encodePc850(text: string): number[] {
  const out: number[] = []
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0x3f
    if (code >= 0x20 && code < 0x7f) out.push(code)
    else if (ch === "\n") out.push(0x0a)
    else if (PC850[ch] !== undefined) out.push(PC850[ch])
    else if (FALLBACK[ch] !== undefined) out.push(...encodePc850(FALLBACK[ch]))
    else {
      const plain = ch.normalize("NFD").replace(/\p{Diacritic}/gu, "")
      out.push(...(plain && plain !== ch ? encodePc850(plain) : [0x3f]))
    }
  }
  return out
}

export type Align = "left" | "center" | "right"

/** Constructor de un trabajo de impresión ESC/POS. */
export class EscPos {
  private bytes: number[] = []

  constructor() {
    this.raw(ESC, 0x40) // inicializar
    this.raw(ESC, 0x74, PC850_PAGE)
  }

  raw(...bytes: number[]): this {
    this.bytes.push(...bytes)
    return this
  }

  align(a: Align): this {
    return this.raw(ESC, 0x61, a === "left" ? 0 : a === "center" ? 1 : 2)
  }

  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0)
  }

  /** Tamaño de letra: 1 normal, 2 doble (ancho y alto por separado). */
  size(width: 1 | 2, height: 1 | 2): this {
    return this.raw(GS, 0x21, ((width - 1) << 4) | (height - 1))
  }

  text(s: string): this {
    this.bytes.push(...encodePc850(s))
    return this
  }

  line(s = ""): this {
    return this.text(s).raw(0x0a)
  }

  feed(lines: number): this {
    return this.raw(ESC, 0x64, Math.max(0, Math.min(255, lines)))
  }

  /** Corte parcial con avance previo (las que no tienen cortador lo ignoran). */
  cut(): this {
    return this.raw(GS, 0x56, 66, 3)
  }

  /** Pulso a la gaveta de dinero conectada a la impresora (pin 2, ~50 ms / ~500 ms). */
  openDrawer(): this {
    return this.raw(ESC, 0x70, 0, 25, 250)
  }

  encode(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}
