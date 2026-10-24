import { strFromU8, unzipSync } from "fflate"

/** Una celda tal como viene de la hoja: texto, número o vacía. */
export type SheetCell = string | number | null

/** Primera hoja de un .xlsx (o un .csv) como filas de celdas. Las filas vacías se omiten. */
export async function readSpreadsheet(file: File): Promise<SheetCell[][]> {
  const name = file.name.toLowerCase()
  if (name.endsWith(".csv") || name.endsWith(".txt")) return parseCsv(await file.text())
  if (name.endsWith(".xlsx")) return readXlsx(new Uint8Array(await file.arrayBuffer()))
  throw new Error("Usa un archivo de Excel (.xlsx) o CSV")
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))
      return String.fromCodePoint(code)
    }
    return ENTITIES[e.toLowerCase()] ?? ""
  })
}

/** Todo el texto de los `<t>` de un fragmento (un texto con formato trae varias corridas). */
function textOf(xml: string): string {
  let out = ""
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1] ?? "")
  return out
}

/** "B12" → 1 (índice de columna desde 0). */
function columnIndex(ref: string): number {
  let n = 0
  for (const ch of ref.replace(/\d+$/, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/**
 * Lee la primera hoja de un libro de Excel (.xlsx): un zip con XML. Solo valores (texto, números,
 * verdadero/falso como texto); las fórmulas traen su último resultado guardado.
 */
export function readXlsx(bytes: Uint8Array): SheetCell[][] {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    throw new Error("El archivo no es un Excel válido (.xlsx)")
  }
  const read = (path: string) => {
    const f = files[path]
    return f ? strFromU8(f) : null
  }
  const workbook = read("xl/workbook.xml")
  if (!workbook) throw new Error("El archivo no es un Excel válido (.xlsx)")
  // La primera hoja según el libro y su archivo según las relaciones.
  const firstSheet = workbook.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1]
  const rels = read("xl/_rels/workbook.xml.rels") ?? ""
  let target = "worksheets/sheet1.xml"
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0]
    if (firstSheet && tag.includes(`Id="${firstSheet}"`)) {
      target = tag.match(/Target="([^"]+)"/)?.[1] ?? target
    }
  }
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`
  const sheet = read(path)
  if (!sheet) throw new Error("No se encontró la primera hoja del libro")

  const shared = [...(read("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (m) => textOf(m[1] ?? ""),
  )
  const rows: SheetCell[][] = []
  for (const r of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: SheetCell[] = []
    for (const c of (r[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? ""
      const body = c[2] ?? ""
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1]
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? "n"
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
      let value: SheetCell = null
      if (type === "s" && raw !== undefined) value = shared[Number(raw)] ?? null
      else if (type === "inlineStr") value = textOf(body)
      else if (type === "str") value = raw === undefined ? null : decodeXml(raw)
      else if (type === "b") value = raw === "1" ? "sí" : "no"
      else if (raw !== undefined && raw !== "") value = Number(raw)
      const index = ref ? columnIndex(ref) : row.length
      while (row.length < index) row.push(null)
      row[index] = typeof value === "string" ? value.trim() || null : value
    }
    if (row.some((v) => v !== null)) rows.push(row)
  }
  return rows
}

/**
 * Lee un CSV (separado por comas o por punto y coma, como lo exporta Excel en español), con
 * campos entre comillas y saltos de línea dentro de ellos.
 */
export function parseCsv(text: string): SheetCell[][] {
  const clean = text.replace(/^﻿/, "")
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? ""
  const sep =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ","
  const rows: SheetCell[][] = []
  let row: SheetCell[] = []
  let field = ""
  let quoted = false
  const push = () => {
    row.push(field.trim() || null)
    field = ""
  }
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) push()
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++
      push()
      if (row.some((v) => v !== null)) rows.push(row)
      row = []
    } else field += ch
  }
  if (field || row.length) {
    push()
    if (row.some((v) => v !== null)) rows.push(row)
  }
  return rows
}

/** "Código de barras " → "codigo de barras": para reconocer encabezados escritos a mano. */
export function normalizeHeader(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .trim()
}

/**
 * Reconoce las columnas de la primera fila. `synonyms` dice, para cada campo, cómo se puede
 * llamar su columna. Devuelve en qué columna está cada campo y las que no se reconocieron.
 */
export function mapColumns<K extends string>(
  header: readonly SheetCell[],
  synonyms: Record<K, readonly string[]>,
): { columns: Partial<Record<K, number>>; unknown: string[] } {
  const columns: Partial<Record<K, number>> = {}
  const unknown: string[] = []
  header.forEach((cell, i) => {
    if (cell === null) return
    const h = normalizeHeader(String(cell))
    const key = (Object.keys(synonyms) as K[]).find((k) =>
      synonyms[k].some((s) => normalizeHeader(s) === h),
    )
    if (key && columns[key] === undefined) columns[key] = i
    else unknown.push(String(cell))
  })
  return { columns, unknown }
}
