/**
 * Códigos de barras para las etiquetas: EAN-13, UPC-A y EAN-8 cuando el código es uno de esos
 * (con su dígito de control correcto) y Code 128 para todo lo demás (el SKU, códigos internos).
 * Devuelve los módulos (1 = barra, 0 = espacio) sin márgenes: quien lo dibuja deja el margen en
 * blanco a cada lado (`QUIET_ZONE` módulos) para que el lector lo encuentre.
 */

import { eanCheckDigit } from "@millhiore/domain"

export { eanCheckDigit }

export type BarcodeFormat = "EAN13" | "UPCA" | "EAN8" | "CODE128"

export interface Barcode {
  format: BarcodeFormat
  /** Un carácter por módulo: "1" barra, "0" espacio. */
  modules: string
  /** Lo que se imprime debajo. */
  text: string
}

/** Módulos en blanco a cada lado: el mínimo de Code 128 y suficiente para EAN. */
export const QUIET_ZONE = 11

const L = [
  "0001101",
  "0011001",
  "0010011",
  "0111101",
  "0100011",
  "0110001",
  "0101111",
  "0111011",
  "0110111",
  "0001011",
]
/** Las G son las L al revés y las R, las L invertidas. */
const G = L.map((code) => [...code].reverse().map(flip).join(""))
const R = L.map((code) => [...code].map(flip).join(""))
/** Paridad de los seis dígitos de la izquierda según el primer dígito del EAN-13. */
const PARITY = [
  "LLLLLL",
  "LLGLGG",
  "LLGGLG",
  "LLGGGL",
  "LGLLGG",
  "LGGLLG",
  "LGGGLL",
  "LGLGLG",
  "LGLGGL",
  "LGGLGL",
]

function flip(bit: string): string {
  return bit === "1" ? "0" : "1"
}

const validEan = (code: string, length: number) =>
  new RegExp(`^\\d{${length}}$`).test(code) &&
  eanCheckDigit(code.slice(0, -1)) === Number(code.at(-1))

function ean13(code: string): string {
  const first = Number(code[0])
  const parity = PARITY[first] ?? ""
  let out = "101"
  for (let i = 1; i <= 6; i++) {
    const d = Number(code[i])
    out += (parity[i - 1] === "G" ? G : L)[d]
  }
  out += "01010"
  for (let i = 7; i <= 12; i++) out += R[Number(code[i])]
  return `${out}101`
}

function ean8(code: string): string {
  let out = "101"
  for (let i = 0; i < 4; i++) out += L[Number(code[i])]
  out += "01010"
  for (let i = 4; i < 8; i++) out += R[Number(code[i])]
  return `${out}101`
}

/** Anchos de barra y espacio de cada símbolo de Code 128 (0–105) y la parada (106). */
export const CODE128 = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
  "2331112",
]
const START_B = 104
const START_C = 105
const TO_C = 99
const TO_B = 100
const STOP = 106

/** Cuántos dígitos seguidos hay desde `i`. */
function digitRun(text: string, i: number): number {
  let n = 0
  while (i + n < text.length && /\d/.test(text[i + n] ?? "")) n++
  return n
}

/**
 * Los símbolos de Code 128 (con el de control, sin la parada): letras en el juego B y las tiras
 * de dígitos en el C, de dos en dos, cuando acorta el código.
 */
export function code128Values(text: string): number[] | null {
  if (text.length === 0 || ![...text].every((c) => c >= " " && c <= "~")) return null
  const values: number[] = []
  let set: "B" | "C" | null = null
  let i = 0
  while (i < text.length) {
    const run = digitRun(text, i)
    const edge = i === 0 || i + run === text.length
    const useC = set === "C" ? run >= 2 : run >= (edge ? 4 : 6)
    if (useC) {
      if (set !== "C") values.push(set === null ? START_C : TO_C)
      set = "C"
      const n = run - (run % 2)
      for (let k = 0; k < n; k += 2) values.push(Number(text.slice(i + k, i + k + 2)))
      i += n
    } else {
      if (set !== "B") values.push(set === null ? START_B : TO_B)
      set = "B"
      values.push(text.charCodeAt(i) - 32)
      i++
    }
  }
  const check = values.reduce((acc, v, j) => acc + (j === 0 ? v : v * j), 0) % 103
  return [...values, check]
}

function code128(text: string): string | null {
  const values = code128Values(text)
  if (!values) return null
  return [...values, STOP]
    .map((v) =>
      [...(CODE128[v] ?? "")].map((w, j) => (j % 2 === 0 ? "1" : "0").repeat(Number(w))).join(""),
    )
    .join("")
}

/**
 * El código de barras para un valor: EAN-13, UPC-A o EAN-8 si lo es (y su dígito de control
 * cuadra), si no Code 128. null si tiene caracteres que no caben en Code 128 (ñ, acentos).
 */
export function barcodeFor(value: string): Barcode | null {
  const v = value.trim()
  if (validEan(v, 13)) return { format: "EAN13", modules: ean13(v), text: v }
  if (validEan(v, 12)) return { format: "UPCA", modules: ean13(`0${v}`), text: v }
  if (validEan(v, 8)) return { format: "EAN8", modules: ean8(v), text: v }
  const modules = code128(v)
  return modules ? { format: "CODE128", modules, text: v } : null
}
