/**
 * Variantes: un producto con tallas, colores u otras características se vende en cada combinación
 * (camisa M azul, camisa L negra), y cada una lleva su código, su precio y su existencia.
 */

/** Una característica del producto (Talla) con sus valores, en el orden en que se muestran. */
export interface ProductOption {
  name: string
  values: string[]
}

/** Hasta tres características (talla, color, material) y doscientas combinaciones. */
export const MAX_OPTIONS = 3
export const MAX_VARIANTS = 200

/** «M, Azul»: los valores de una combinación, para mostrarlos junto al nombre. */
export function variantLabel(values: readonly string[] | null): string {
  return values?.length ? values.join(", ") : ""
}

/** «Camisa (M, Azul)»: el nombre con que la combinación sale en la caja y en los documentos. */
export function variantName(productName: string, values: readonly string[] | null): string {
  return values?.length ? `${productName} (${variantLabel(values)})` : productName
}

/** Todas las combinaciones de las características, en el orden de la cuadrícula. */
export function combinations(options: readonly ProductOption[]): string[][] {
  return options.reduce<string[][]>(
    (acc, o) => acc.flatMap((prefix) => o.values.map((v) => [...prefix, v])),
    options.length ? [[]] : [],
  )
}

/** Clave para comparar combinaciones sin importar mayúsculas ni espacios de más. */
export function comboKey(values: readonly string[]): string {
  return values.map((v) => v.trim().toLocaleLowerCase("es")).join("\u0000")
}

/**
 * Ordena las combinaciones como la cuadrícula: por la posición de cada valor en su
 * característica. Los valores que ya no están (variantes viejas) van al final.
 */
export function compareCombos(
  options: readonly ProductOption[],
  a: readonly string[] | null,
  b: readonly string[] | null,
): number {
  for (let i = 0; i < options.length; i++) {
    const values = options[i]?.values ?? []
    const pos = (v: string | undefined) => {
      const p = v === undefined ? -1 : values.indexOf(v)
      return p === -1 ? Number.MAX_SAFE_INTEGER : p
    }
    const d = pos(a?.[i]) - pos(b?.[i])
    if (d !== 0) return d
  }
  return 0
}

/**
 * Qué está mal en las características, o null si están bien: nombres y valores sin repetir (sin
 * importar mayúsculas), alguno en cada una y no más de lo que cabe.
 */
export function optionsProblem(options: readonly ProductOption[]): string | null {
  if (options.length > MAX_OPTIONS) return `Hasta ${MAX_OPTIONS} características`
  const names = new Set<string>()
  for (const o of options) {
    const name = o.name.trim()
    if (!name) return "Cada característica necesita un nombre"
    if (names.has(name.toLocaleLowerCase("es"))) return `«${name}» está repetida`
    names.add(name.toLocaleLowerCase("es"))
    if (o.values.length === 0) return `Agrega al menos un valor a «${name}»`
    const values = new Set<string>()
    for (const v of o.values) {
      const value = v.trim()
      if (!value) return `«${name}» tiene un valor vacío`
      if (values.has(value.toLocaleLowerCase("es"))) return `«${value}» está repetido en «${name}»`
      values.add(value.toLocaleLowerCase("es"))
    }
  }
  const count = options.reduce((acc, o) => acc * o.values.length, options.length ? 1 : 0)
  if (count > MAX_VARIANTS) {
    return `Son ${count} combinaciones; el máximo es ${MAX_VARIANTS}`
  }
  return null
}
