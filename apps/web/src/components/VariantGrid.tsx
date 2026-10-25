import type { CatalogItem } from "@millhiore/contracts"
import { comboKey } from "@millhiore/domain"
import { Button } from "@millhiore/ui"
import { type ReactNode, useState } from "react"

/**
 * Las tallas y colores de un producto en cuadrícula: con dos características, filas de la
 * primera (S, M, L) y columnas de la segunda (Azul, Negro); con una, una fila; con tres, la
 * primera se elige arriba. Cada celda la dibuja quien la usa (un botón en la caja, una cantidad
 * en las compras); `item` falta si esa combinación no se vende.
 */
export function VariantGrid({
  items,
  cell,
}: {
  items: readonly CatalogItem[]
  cell: (item: CatalogItem | undefined, label: string) => ReactNode
}) {
  const options = items[0]?.options ?? []
  const byCombo = new Map(items.map((i) => [comboKey(i.optionValues ?? []), i]))
  const [page, setPage] = useState(options.length === 3 ? (options[0]?.values[0] ?? "") : "")
  const prefix = options.length === 3 ? [page] : []
  const grid = options.length === 3 ? options.slice(1) : options
  const find = (values: string[]) => byCombo.get(comboKey([...prefix, ...values]))
  const label = (values: string[]) => [...prefix, ...values].join(", ")

  if (grid.length === 1) {
    const only = grid[0]
    return (
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {only?.values.map((v) => (
          <div key={v} className="grid gap-1">
            <span className="truncate text-center font-medium text-sm">{v}</span>
            {cell(find([v]), label([v]))}
          </div>
        ))}
      </div>
    )
  }
  const [rows, cols] = grid
  return (
    <div className="grid min-w-0 gap-3">
      {options.length === 3 ? (
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={options[0]?.name}>
          {options[0]?.values.map((v) => (
            <Button
              key={v}
              type="button"
              role="tab"
              size="sm"
              aria-selected={page === v}
              variant={page === v ? "default" : "outline"}
              className="rounded-full"
              onClick={() => setPage(v)}
            >
              {v}
            </Button>
          ))}
        </div>
      ) : null}
      {/* Si hay muchos colores, la cuadrícula se desliza dentro de su recuadro. */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <table className="w-full border-separate border-spacing-1.5">
          <thead>
            <tr>
              <th className="text-left font-normal text-muted-foreground text-xs">
                {rows?.name} / {cols?.name}
              </th>
              {cols?.values.map((c) => (
                <th key={c} className="min-w-16 px-1 text-center font-medium text-sm">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows?.values.map((r) => (
              <tr key={r}>
                <th scope="row" className="pr-1 text-left font-medium text-sm">
                  {r}
                </th>
                {cols?.values.map((c) => (
                  <td key={c} className="p-0">
                    {cell(find([r, c]), label([r, c]))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Agrupa las variantes por producto: las de un producto con tallas y colores, juntas. */
export function groupByProduct(items: readonly CatalogItem[]): CatalogItem[][] {
  const groups: CatalogItem[][] = []
  const byProduct = new Map<string, CatalogItem[]>()
  for (const item of items) {
    const group = item.options ? byProduct.get(item.productId) : undefined
    if (group) group.push(item)
    else {
      const created = [item]
      if (item.options) byProduct.set(item.productId, created)
      groups.push(created)
    }
  }
  return groups
}
