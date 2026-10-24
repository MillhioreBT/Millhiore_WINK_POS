import { describe, expect, test } from "bun:test"
import { strToU8, zipSync } from "fflate"
import { mapColumns, normalizeHeader, parseCsv, readXlsx } from "./sheetReader"

/** Un .xlsx mínimo como el que guarda Excel: libro, relaciones, textos compartidos y una hoja. */
function xlsx(
  sheet: string,
  shared: string[] = [],
  sheetPath = "worksheets/sheet1.xml",
): Uint8Array {
  return zipSync({
    "xl/workbook.xml": strToU8(
      '<workbook><sheets><sheet name="Productos" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships><Relationship Id="rId1" Type="worksheet" Target="${sheetPath}"/></Relationships>`,
    ),
    "xl/sharedStrings.xml": strToU8(
      `<sst>${shared.map((s) => `<si><t xml:space="preserve">${s}</t></si>`).join("")}</sst>`,
    ),
    [`xl/${sheetPath}`]: strToU8(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`),
  })
}

describe("leer Excel", () => {
  test("textos compartidos, números, celdas en línea y huecos", () => {
    const rows = readXlsx(
      xlsx(
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>
         <row r="2"><c r="A2" t="inlineStr"><is><t>Café &amp; té</t></is></c><c r="B2"><v>1.5</v></c><c r="D2" t="str"><v>X-1</v></c></row>
         <row r="3"><c r="A3" t="s"><v>3</v></c></row>
         <row r="4"></row>`,
        ["Nombre", "Precio", "SKU", "  "],
      ),
    )
    expect(rows).toEqual([
      ["Nombre", "Precio", null, "SKU"],
      ["Café & té", 1.5, null, "X-1"],
    ])
  })

  test("un texto con formato junta sus corridas; la hoja se busca por su relación", () => {
    const rows = readXlsx(
      xlsx(
        '<row r="1"><c r="A1" t="inlineStr"><is><r><t>Harina </t></r><r><t>PAN</t></r></is></c></row>',
        [],
        "worksheets/hoja_productos.xml",
      ),
    )
    expect(rows).toEqual([["Harina PAN"]])
  })

  test("rechaza lo que no es un Excel", () => {
    expect(() => readXlsx(new Uint8Array([1, 2, 3]))).toThrow("no es un Excel válido")
  })
})

describe("leer CSV", () => {
  test("detecta el punto y coma de Excel en español y respeta las comillas", () => {
    expect(parseCsv('﻿Nombre;Precio\r\n"Queso; blanco";"1,50"\r\n\r\nPan;2\n')).toEqual([
      ["Nombre", "Precio"],
      ["Queso; blanco", "1,50"],
      ["Pan", "2"],
    ])
  })

  test("con comas, comillas dobles escapadas y saltos dentro de un campo", () => {
    expect(parseCsv('a,b\n"dice ""hola""","línea 1\nlínea 2"')).toEqual([
      ["a", "b"],
      ['dice "hola"', "línea 1\nlínea 2"],
    ])
  })
})

describe("encabezados", () => {
  test("se reconocen sin importar mayúsculas, acentos ni espacios", () => {
    expect(normalizeHeader("  Código de Barras ")).toBe("codigo de barras")
    const { columns, unknown } = mapColumns(
      ["PRODUCTO", "Precio de venta", "Color", "código de barras", "Nombre"],
      {
        name: ["nombre", "producto"],
        price: ["precio", "precio de venta"],
        barcode: ["codigo de barras"],
      },
    )
    // Una columna que se repite se toma la primera y la otra queda como desconocida.
    expect(columns).toEqual({ name: 0, price: 1, barcode: 3 })
    expect(unknown).toEqual(["Color", "Nombre"])
  })
})
