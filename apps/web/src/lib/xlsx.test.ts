import { describe, expect, test } from "bun:test"
import { fileName, moneyCell, percentCell, qtyCell } from "./xlsx"

describe("exportar a Excel", () => {
  test("el nombre del archivo no lleva tildes, espacios ni barras", () => {
    expect(fileName("resultados", "01/10/2026 al 15/10/2026")).toBe(
      "resultados-01-10-2026-al-15-10-2026.xlsx",
    )
    expect(fileName("Inventario", "Árbol/Niño")).toBe("inventario-arbol-nino.xlsx")
  })

  test("los montos van como números con dos decimales para poder sumarlos", () => {
    expect(moneyCell(12_345)).toMatchObject({ value: 123.45, type: Number, format: "#,##0.00" })
    expect(moneyCell(-730)).toMatchObject({ value: -7.3 })
    expect(moneyCell(null)).toBeNull()
    expect(moneyCell(500, 2, true)).toMatchObject({ fontWeight: "bold" })
  })

  test("cantidades en milésimas y porcentajes en puntos básicos", () => {
    expect(qtyCell(2_500)).toMatchObject({ value: 2.5 })
    expect(percentCell(2_267)).toMatchObject({ value: 0.2267, format: "0.0%" })
    expect(percentCell(null)).toBeNull()
  })
})
