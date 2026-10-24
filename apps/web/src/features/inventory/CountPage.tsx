import type { CatalogItem } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import {
  Button,
  Card,
  CardContent,
  Field,
  Input,
  NativeSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { SearchIcon, Trash2Icon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { ScanButton } from "../../components/CameraScanner"
import { api, errorMessage } from "../../lib/api"
import { formatQty, parseAmount, toInputQty } from "../../lib/format"
import { stockAt, useLocations } from "../../lib/locations"
import { bootstrapQuery, productsQuery, queryClient } from "../../lib/queries"
import { findByCode } from "../../lib/scanner"
import { useTerminal } from "../../lib/terminal"

interface Row {
  variantId: string
  /** Lo contado, como lo escribe la persona. */
  counted: string
}

// El conteo en curso se guarda en este navegador (por ubicación): si se cierra la página o se
// apaga el celular a mitad de camino, no se pierde.
const draftKey = (locationId: string) => `millhiore.count.${locationId}`

function loadDraft(locationId: string): Row[] {
  try {
    const raw = localStorage.getItem(draftKey(locationId))
    const rows = raw ? (JSON.parse(raw) as Row[]) : []
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function saveDraft(locationId: string, rows: Row[]): void {
  try {
    if (rows.length) localStorage.setItem(draftKey(locationId), JSON.stringify(rows))
    else localStorage.removeItem(draftKey(locationId))
  } catch {
    // Sin almacenamiento (ventana privada): el conteo vive mientras la página siga abierta.
  }
}

/**
 * Conteo físico desde el celular o la PC: se escanea (cada lectura suma 1) o se busca cada
 * producto, se anota lo contado y, al guardar, la diferencia con el sistema queda como sobrante o
 * faltante de conteo.
 */
export function CountPage() {
  const { data: boot } = useQuery(bootstrapQuery)
  const products = useQuery(productsQuery())
  const locations = useLocations()
  const terminal = useTerminal()
  const [picked, setPicked] = useState<string | null>(null)
  const locationId = picked ?? terminal?.locationId ?? ""
  const [rows, setRows] = useState<Row[]>([])
  const [loadedFor, setLoadedFor] = useState("")
  const [search, setSearch] = useState("")
  const [busy, setBusy] = useState(false)
  // Ids de los documentos de este guardado: reintentar no registra dos veces.
  const ids = useRef<{ in: string; out: string } | null>(null)
  const inputs = useRef(new Map<string, HTMLInputElement>())

  // Al cambiar de ubicación se retoma su conteo guardado.
  useEffect(() => {
    if (!locationId) return
    setRows(loadDraft(locationId))
    setLoadedFor(locationId)
    ids.current = null
  }, [locationId])
  useEffect(() => {
    if (loadedFor) saveDraft(loadedFor, rows)
  }, [rows, loadedFor])

  const items = useMemo(
    () => new Map((products.data ?? []).map((p) => [p.variantId, p])),
    [products.data],
  )
  const countable = (products.data ?? []).filter((p) => p.tracksStock)
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (q.length < 2) return []
    return countable
      .filter(
        (p) => p.name.toLowerCase().includes(q) || p.barcode === q || p.sku.toLowerCase() === q,
      )
      .slice(0, 8)
  }, [countable, search])

  /** Agrega el producto arriba de la lista; `plusOne` suma una unidad a lo contado. */
  const add = (item: CatalogItem, plusOne: boolean) => {
    ids.current = null
    setRows((rs) => {
      const existing = rs.find((r) => r.variantId === item.variantId)
      const before = existing ? (parseAmount(existing.counted, 3) ?? 0) : 0
      const counted = plusOne ? toInputQty(before + 1000) : (existing?.counted ?? "")
      return [{ variantId: item.variantId, counted }, ...rs.filter((r) => r !== existing)]
    })
    setSearch("")
    if (!plusOne) setTimeout(() => inputs.current.get(item.variantId)?.focus(), 0)
  }

  const diffs = rows
    .map((r) => {
      const item = items.get(r.variantId)
      const counted = parseAmount(r.counted, 3)
      const system = item ? stockAt(item, locationId) : 0
      return { row: r, item, counted, system, delta: counted === null ? null : counted - system }
    })
    .filter((d) => d.item)
  const pending = diffs.filter((d) => d.delta !== null && d.delta !== 0)
  const blank = diffs.filter((d) => d.counted === null)

  const save = async () => {
    if (!boot || !terminal) return
    if (blank.length) {
      toast.error(`Falta lo contado de ${blank[0]?.item?.name}`)
      return
    }
    setBusy(true)
    try {
      // Lo del sistema puede haber cambiado mientras se contaba (una venta): se toma el de ahora.
      const fresh = await queryClient.fetchQuery({ ...productsQuery(), staleTime: 0 })
      const now = new Map(fresh.map((p) => [p.variantId, p]))
      const lines = diffs
        .map((d) => {
          const item = now.get(d.row.variantId)
          return {
            variantId: d.row.variantId,
            qtyMilli: (d.counted ?? 0) - (item ? stockAt(item, locationId) : 0),
            unitPriceMinor: 0,
          }
        })
        .filter((l) => l.qtyMilli !== 0)
      if (lines.length === 0) {
        toast.success("Todo cuadra: no hay diferencias que registrar")
        setRows([])
        return
      }
      ids.current ??= { in: uuidv7(), out: uuidv7() }
      const post = (id: string, reason: string, part: typeof lines) =>
        part.length
          ? api("/api/documents", {
              body: {
                id,
                type: "ADJUSTMENT",
                terminalId: terminal.id,
                currency: boot.business.legalCurrency,
                rate: null,
                ...(locations ? { locationId } : {}),
                stockReasonId: reason,
                note: "Conteo físico",
                lines: part,
              },
            })
          : Promise.resolve()
      // Una entrada solo suma y una salida solo resta: sobrantes y faltantes van por separado.
      await post(
        ids.current.in,
        "stk-in-count",
        lines.filter((l) => l.qtyMilli > 0),
      )
      await post(
        ids.current.out,
        "stk-out-count",
        lines.filter((l) => l.qtyMilli < 0),
      )
      await Promise.all(
        ["products", "stock-adjustments", "lots", "reports", "documents"].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      )
      const over = lines.filter((l) => l.qtyMilli > 0).length
      const short = lines.length - over
      toast.success(
        `Conteo guardado: ${[
          over ? `${over} con sobrante` : null,
          short ? `${short} con faltante` : null,
        ]
          .filter(Boolean)
          .join(" y ")}`,
      )
      ids.current = null
      setRows([])
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <h1 className="font-semibold text-xl">Conteo físico</h1>
      <p className="-mt-2 text-muted-foreground text-sm">
        Escanea cada producto (cada lectura suma 1) o búscalo y escribe cuánto hay. Al guardar, la
        diferencia con el sistema queda como sobrante o faltante de conteo. Lo que vas contando se
        guarda en este equipo.
      </p>

      {locations ? (
        <Field label="Ubicación que cuentas" htmlFor="count-location" className="sm:w-64">
          <NativeSelect
            id="count-location"
            value={locationId}
            onChange={(e) => setPicked(e.target.value)}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : null}

      <div className="relative">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return
                const item =
                  findByCode(countable, search) ?? (filtered.length === 1 ? filtered[0] : undefined)
                if (item) add(item, findByCode(countable, search) !== undefined)
              }}
              placeholder="Producto: nombre o código"
              aria-label="Buscar producto para contar"
              className="pl-9"
            />
          </div>
          <ScanButton
            continuous
            label="Contar con la cámara"
            onCode={(code) => {
              const item = findByCode(countable, code)
              if (!item) {
                toast.error(`No hay ningún producto con el código ${code}`)
                return
              }
              add(item, true)
            }}
          />
        </div>
        {filtered.length ? (
          <ul className="absolute top-11 z-10 w-full divide-y rounded-md border bg-popover shadow-lg">
            {filtered.map((p) => (
              <li key={p.variantId}>
                <button
                  type="button"
                  className="w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => add(p, false)}
                >
                  {p.name} <span className="text-muted-foreground">{p.sku}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Producto</TableHead>
                <TableHead className="w-24 text-right">Contado</TableHead>
                <TableHead className="text-right">Dif.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {diffs.length ? null : (
                <TableRow>
                  <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                    Escanea o busca el primer producto.
                  </TableCell>
                </TableRow>
              )}
              {diffs.map((d) => (
                <TableRow key={d.row.variantId}>
                  <TableCell className="min-w-0 whitespace-normal text-sm">
                    <span className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="-ml-2 shrink-0 text-muted-foreground"
                        aria-label={`Quitar ${d.item?.name}`}
                        onClick={() => {
                          ids.current = null
                          setRows((rs) => rs.filter((r) => r !== d.row))
                        }}
                      >
                        <Trash2Icon />
                      </Button>
                      <span className="min-w-0">
                        <span className="block font-medium">{d.item?.name}</span>
                        <span className="block text-muted-foreground text-xs">
                          En el sistema: {formatQty(d.system)}
                        </span>
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Input
                      ref={(el) => {
                        if (el) inputs.current.set(d.row.variantId, el)
                        else inputs.current.delete(d.row.variantId)
                      }}
                      value={d.row.counted}
                      inputMode="decimal"
                      className="tabular h-9 w-20 text-right sm:h-8"
                      aria-label={`Contado de ${d.item?.name}`}
                      onChange={(e) => {
                        ids.current = null
                        const counted = e.target.value
                        setRows((rs) => rs.map((r) => (r === d.row ? { ...r, counted } : r)))
                      }}
                    />
                  </TableCell>
                  <TableCell
                    className={`tabular whitespace-nowrap text-right font-medium ${
                      d.delta === null || d.delta === 0
                        ? "text-muted-foreground"
                        : d.delta > 0
                          ? "text-success"
                          : "text-destructive"
                    }`}
                  >
                    {d.delta === null ? "—" : `${d.delta > 0 ? "+" : ""}${formatQty(d.delta)}`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-sm">
          {diffs.length} producto{diffs.length === 1 ? "" : "s"} · {pending.length} con diferencia
        </span>
        <span className="ml-auto flex gap-2">
          <Button
            variant="outline"
            disabled={busy || rows.length === 0}
            onClick={() => {
              ids.current = null
              setRows([])
            }}
          >
            Vaciar
          </Button>
          <Button onClick={save} disabled={busy || rows.length === 0 || !terminal}>
            {busy ? "Guardando…" : "Guardar conteo"}
          </Button>
        </span>
      </div>
    </div>
  )
}
