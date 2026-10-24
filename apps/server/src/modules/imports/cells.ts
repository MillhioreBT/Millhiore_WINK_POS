import { parseMajor } from "@millhiore/domain"

/** Una celda importada: texto, número o vacía. */
export type Cell = string | number | null | undefined

/** El texto de una celda, sin espacios de más; null si está vacía. */
export function text(cell: Cell): string | null {
  if (cell === null || cell === undefined) return null
  // Un código de barras largo llega de Excel como número: se escribe completo, sin notación científica.
  const s =
    typeof cell === "number"
      ? Number.isInteger(cell)
        ? BigInt(cell).toString()
        : String(cell)
      : cell
  const t = s.trim()
  return t ? t : null
}

/**
 * Un número escrito a mano o por Excel a unidades menores con `decimals` cifras. Acepta
 * "1.234,56", "1234,56", "1234.56", "$ 1,50", "Bs 20" y números de la hoja. Con solo puntos,
 * "1.50" es decimal y "1.500" son miles (en Venezuela el punto separa miles).
 * `undefined` si la celda está vacía; `null` si no es un número válido no negativo.
 */
export function amount(cell: Cell, decimals = 2): number | null | undefined {
  if (cell === null || cell === undefined || cell === "") return undefined
  let normalized: string
  if (typeof cell === "number") {
    if (!Number.isFinite(cell) || cell < 0) return null
    normalized = String(cell)
  } else {
    const s = cell.trim().replace(/\s|\$|bs\.?|usd|ves/gi, "")
    if (!s) return undefined
    if (!/^[\d.,]+$/.test(s)) return null
    const lastComma = s.lastIndexOf(",")
    const lastDot = s.lastIndexOf(".")
    if (lastComma >= 0 && lastDot >= 0) {
      const decimalSep = lastComma > lastDot ? "," : "."
      const thousandSep = decimalSep === "," ? "." : ","
      normalized = s.split(thousandSep).join("").replace(decimalSep, ".")
    } else if (lastComma >= 0) {
      normalized = s.split(",").length === 2 ? s.replace(",", ".") : s.split(",").join("")
    } else if (lastDot >= 0) {
      const after = s.length - lastDot - 1
      normalized = s.split(".").length === 2 && after !== 3 ? s : s.split(".").join("")
    } else {
      normalized = s
    }
    if (!/^\d+(\.\d+)?$/.test(normalized)) return null
  }
  try {
    const minor = parseMajor(normalized, { code: "", decimals }).amountMinor
    return Number.isSafeInteger(minor) ? minor : null
  } catch {
    return null
  }
}

/** Sí/no escrito de cualquier forma; `undefined` si está vacío o no se entiende. */
export function yesNo(cell: Cell): boolean | undefined {
  const t = text(cell)?.toLowerCase()
  if (!t) return undefined
  if (["si", "sí", "s", "x", "1", "true", "verdadero"].includes(t)) return true
  if (["no", "n", "0", "false", "falso"].includes(t)) return false
  return undefined
}

/** Para comparar nombres sin importar mayúsculas, acentos ni espacios. */
export function key(textValue: string): string {
  return textValue.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim()
}
