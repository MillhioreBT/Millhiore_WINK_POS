import type { Bootstrap, CatalogItem } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { ArrowRightIcon, Trash2Icon } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { ScanButton } from "../../components/CameraScanner"
import { api, errorMessage } from "../../lib/api"
import { formatQty, parseAmount } from "../../lib/format"
import { stockAt } from "../../lib/locations"
import { productsQuery, queryClient } from "../../lib/queries"
import { findByCode } from "../../lib/scanner"

interface Line {
  item: CatalogItem
  qty: string
}

/**
 * Pasar mercancía de una ubicación a otra (del depósito a la tienda): sale del origen y entra al
 * destino en el mismo momento. Se anula con un reverso que la devuelve.
 */
export function NewTransferDialog({
  boot,
  locations,
  origins = locations,
  terminalId,
  defaultFrom,
  onClose,
}: {
  boot: Bootstrap
  /** Adónde puede ir (con sucursales, a cualquiera). */
  locations: Bootstrap["locations"]
  /** De dónde puede salir (las ubicaciones de las sucursales donde se trabaja). */
  origins?: Bootstrap["locations"]
  terminalId: string
  defaultFrom: string
  onClose: () => void
}) {
  // Con sucursales, el destino se elige agrupado por sucursal.
  const branches = boot.features.branches && boot.branches.length > 1 ? boot.branches : null
  const products = useQuery(productsQuery())
  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState(() => locations.find((l) => l.id !== defaultFrom)?.id ?? "")
  const [lines, setLines] = useState<Line[]>([])
  const [search, setSearch] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [transferId] = useState(uuidv7)

  const name = (id: string) => locations.find((l) => l.id === id)?.name ?? ""
  const parsed = lines.map((l) => parseAmount(l.qty, 3))
  const valid =
    from !== "" &&
    to !== "" &&
    from !== to &&
    lines.length > 0 &&
    parsed.every((q) => q !== null && q > 0)
  // Lo que se lleva más de lo que hay en el origen: se avisa (el negocio decide si lo permite).
  const short = lines.filter((l, i) => (parsed[i] ?? 0) > stockAt(l.item, from))

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (q.length < 2) return []
    return (products.data ?? [])
      .filter(
        (p) =>
          p.tracksStock &&
          (p.name.toLowerCase().includes(q) || p.barcode === q || p.sku.toLowerCase() === q),
      )
      .slice(0, 8)
  }, [products.data, search])

  const addLine = (item: CatalogItem) => {
    setLines((ls) =>
      ls.some((l) => l.item.variantId === item.variantId) ? ls : [...ls, { item, qty: "1" }],
    )
    setSearch("")
  }

  // Al elegir como origen lo que era el destino, se intercambian.
  const pickFrom = (id: string) => {
    if (id === to) setTo(origins.some((l) => l.id === from) ? from : "")
    setFrom(id)
  }
  const destination = (l: Bootstrap["locations"][number]) => (
    <option key={l.id} value={l.id}>
      {l.name}
    </option>
  )

  const submit = async () => {
    if (!valid) return
    setBusy(true)
    try {
      const posted = await api<{ number: string }>("/api/documents", {
        body: {
          id: transferId,
          type: "STOCK_TRANSFER",
          terminalId,
          currency: boot.business.legalCurrency,
          rate: null,
          locationId: from,
          toLocationId: to,
          lines: lines.map((l, i) => ({
            variantId: l.item.variantId,
            qtyMilli: parsed[i] ?? 0,
            unitPriceMinor: 0,
          })),
          payments: [],
          note: note.trim() || null,
        },
      })
      await Promise.all(
        ["products", "documents", "reports", "locations"].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      )
      toast.success(
        `Traslado ${posted.number}: ${lines.length} producto${lines.length === 1 ? "" : "s"} de ${name(from)} a ${name(to)}`,
      )
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nuevo traslado</DialogTitle>
          <DialogDescription>
            La mercancía sale del origen y entra al destino en el mismo momento.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2">
          <Field label="Desde" htmlFor="tr-from">
            <NativeSelect id="tr-from" value={from} onChange={(e) => pickFrom(e.target.value)}>
              {origins.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <ArrowRightIcon className="mb-2.5 size-4 text-muted-foreground" aria-hidden />
          <Field label="Hasta" htmlFor="tr-to">
            <NativeSelect id="tr-to" value={to} onChange={(e) => setTo(e.target.value)}>
              {branches
                ? branches.map((b) => {
                    const here = locations.filter((l) => l.id !== from && l.branchId === b.id)
                    return here.length ? (
                      <optgroup key={b.id} label={b.name}>
                        {here.map(destination)}
                      </optgroup>
                    ) : null
                  })
                : locations.filter((l) => l.id !== from).map(destination)}
            </NativeSelect>
          </Field>
        </div>

        <div className="relative">
          <div className="flex gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Agregar producto: nombre o código"
              aria-label="Buscar producto para trasladar"
            />
            <ScanButton
              continuous
              onCode={(code) => {
                const item = findByCode(
                  (products.data ?? []).filter((p) => p.tracksStock),
                  code,
                )
                if (!item) {
                  toast.error(`No hay ningún producto con el código ${code}`)
                  return
                }
                addLine(item)
                toast.success(`${item.name} en el traslado`)
              }}
            />
          </div>
          {filtered.length ? (
            <ul className="absolute top-11 z-10 w-full divide-y rounded-md border bg-popover shadow-lg">
              {filtered.map((p) => (
                <li key={p.variantId}>
                  <button
                    type="button"
                    className="flex w-full cursor-pointer justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
                    onClick={() => addLine(p)}
                  >
                    <span className="min-w-0">
                      {p.name} <span className="text-muted-foreground">{p.sku}</span>
                    </span>
                    <span className="tabular shrink-0 text-muted-foreground">
                      hay {formatQty(stockAt(p, from))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <ul className="divide-y rounded-lg border text-sm">
          {lines.length === 0 ? (
            <li className="px-3 py-6 text-center text-muted-foreground">
              Busca y agrega los productos que vas a pasar.
            </li>
          ) : null}
          {lines.map((l, i) => {
            const available = stockAt(l.item, from)
            const over = (parsed[i] ?? 0) > available
            return (
              <li
                key={l.item.variantId}
                className="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-x-3 gap-y-1 px-3 py-2"
              >
                <span className="flex min-w-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="-ml-2 shrink-0 text-muted-foreground"
                    onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                    aria-label={`Quitar ${l.item.name}`}
                  >
                    <Trash2Icon />
                  </Button>
                  <span className="min-w-0">
                    <span className="block font-medium">{l.item.name}</span>
                    <span
                      className={`block text-xs ${over ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      En {name(from)} hay {formatQty(available)}
                    </span>
                  </span>
                </span>
                <Input
                  value={l.qty}
                  inputMode="decimal"
                  className="tabular h-9 text-right sm:h-8"
                  aria-label={`Cantidad de ${l.item.name}`}
                  onChange={(e) =>
                    setLines((ls) =>
                      ls.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)),
                    )
                  }
                />
              </li>
            )
          })}
        </ul>

        <Field label="Nota (opcional)" htmlFor="tr-note">
          <Input
            id="tr-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reposición del mostrador, pedido de la tienda 2…"
            maxLength={500}
          />
        </Field>
        {short.length ? (
          <p className="text-destructive text-sm">
            Llevas más de lo que hay en {name(from)}
            {short.length === 1 ? ` de ${short[0]?.item.name}` : ` de ${short.length} productos`}.
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={busy || !valid}>
            {busy ? "Trasladando…" : "Trasladar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
