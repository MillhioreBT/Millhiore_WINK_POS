import type { Cell, SheetData } from "write-excel-file/browser"

export type { Cell }

export interface ExportSheet {
  name: string
  /** Ancho de cada columna en caracteres. */
  widths: number[]
  rows: Cell[][]
}

/** Texto en negrita (encabezados y totales). */
export const bold = (value: string | number | null, extra: Cell = {}): Cell =>
  ({ value, fontWeight: "bold", ...(extra as object) }) as Cell

/** Un monto en unidades menores como número con dos decimales (queda sumable en Excel). */
export const moneyCell = (minor: number | null, decimals = 2, strong = false): Cell =>
  minor === null
    ? null
    : ({
        value: minor / 10 ** decimals,
        type: Number,
        format: "#,##0.00",
        ...(strong ? { fontWeight: "bold" } : {}),
      } as Cell)

/** Una cantidad en milésimas (1000 = 1 unidad). */
export const qtyCell = (milli: number): Cell =>
  ({ value: milli / 1000, type: Number, format: "#,##0.###" }) as Cell

/** Un porcentaje a partir de puntos básicos (2500 = 25 %). */
export const percentCell = (bp: number | null): Cell =>
  bp === null ? null : ({ value: bp / 10_000, type: Number, format: "0.0%" } as Cell)

/** Un nombre de archivo sin caracteres raros: `informe-ventas-2026-10-01-a-2026-10-15`. */
export function fileName(...parts: string[]): string {
  return `${parts
    .join("-")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .toLowerCase()}.xlsx`
}

/** Descarga un libro de Excel con las hojas dadas. La librería se carga solo al exportar. */
export async function downloadXlsx(name: string, sheets: ExportSheet[]): Promise<void> {
  const { default: writeXlsxFile } = await import("write-excel-file/browser")
  await writeXlsxFile(
    sheets.map((s) => ({
      sheet: s.name.slice(0, 31),
      data: s.rows as SheetData,
      columns: s.widths.map((width) => ({ width })),
    })),
  ).toFile(name)
}
