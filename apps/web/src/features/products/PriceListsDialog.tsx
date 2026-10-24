import type { PriceList } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { EyeIcon, EyeOffIcon, PencilIcon, PlusIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatPercent, parseAmount, toInputAmount } from "../../lib/format"
import { priceListsQuery, queryClient } from "../../lib/queries"

/** "−10", "-12,5" o "15" → centésimas de punto con signo; null si no se entiende. */
export function parseSignedPercent(text: string): number | null {
  const t = text.trim()
  if (!t) return 0
  const negative = /^[-−]/.test(t)
  const bp = parseAmount(t.replace(/^[-−+]\s*/, ""))
  return bp === null ? null : negative ? -bp : bp
}

/** Cómo se lee el ajuste de una lista: «10 % menos», «5 % más» o «precio normal». */
export function adjustLabel(bp: number): string {
  if (bp === 0) return "precio normal"
  return bp < 0 ? `${formatPercent(-bp)} menos` : `${formatPercent(bp)} más`
}

function signedInput(bp: number): string {
  return bp === 0 ? "" : `${bp < 0 ? "-" : ""}${toInputAmount(Math.abs(bp)).replace(/,00$/, "")}`
}

/**
 * Listas de precios (al mayor, revendedores…): cada una con un ajuste sobre el precio normal para
 * los productos que no tienen precio propio en ella. Los precios propios se ponen en cada producto.
 */
export function PriceListsDialog({
  canManage,
  onClose,
}: {
  canManage: boolean
  onClose: () => void
}) {
  const lists = useQuery(priceListsQuery({ all: true }))
  const [name, setName] = useState("")
  const [adjust, setAdjust] = useState("")
  const [editing, setEditing] = useState<{ id: string; name: string; adjust: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["price-lists"] }),
        queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
      ])
      return true
    } catch (e) {
      toast.error(errorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    const adjustBp = parseSignedPercent(adjust)
    if (adjustBp === null) {
      setError("Escribe un porcentaje, p. ej. −10")
      return
    }
    setError(null)
    if (await run(() => api("/api/price-lists", { body: { name: name.trim(), adjustBp } }))) {
      setName("")
      setAdjust("")
    }
  }

  const save = async () => {
    if (!editing) return
    const adjustBp = parseSignedPercent(editing.adjust)
    if (adjustBp === null) {
      setError("Escribe un porcentaje, p. ej. −10")
      return
    }
    setError(null)
    const ok = await run(() =>
      api(`/api/price-lists/${editing.id}`, {
        method: "PATCH",
        body: { name: editing.name.trim(), adjustBp },
      }),
    )
    if (ok) setEditing(null)
  }

  const toggle = (l: PriceList) =>
    run(() => api(`/api/price-lists/${l.id}`, { method: "PATCH", body: { active: !l.active } }))

  const counts = (l: PriceList) =>
    [
      l.priceCount === 1 ? "1 precio propio" : `${l.priceCount} precios propios`,
      l.customerCount === 1 ? "1 cliente" : `${l.customerCount} clientes`,
    ].join(" · ")

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Listas de precios</DialogTitle>
          <DialogDescription>
            Para vender al mayor o a revendedores. Un producto sin precio propio en la lista vale su
            precio normal con el ajuste de la lista. En la caja se elige la lista, o se aplica sola
            al escoger un cliente que la tenga.
          </DialogDescription>
        </DialogHeader>

        {canManage ? (
          <form
            className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_7rem_auto]"
            onSubmit={(e) => {
              e.preventDefault()
              void add()
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nombre, p. ej. Al mayor"
              aria-label="Nombre de la lista"
              maxLength={60}
            />
            <Input
              value={adjust}
              onChange={(e) => setAdjust(e.target.value)}
              placeholder="% (−10)"
              aria-label="Ajuste en %"
              inputMode="text"
              className="tabular"
            />
            <Button type="submit" disabled={busy || !name.trim()}>
              <PlusIcon /> Agregar
            </Button>
            {error ? <p className="text-destructive text-xs sm:col-span-3">{error}</p> : null}
          </form>
        ) : null}

        <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
          {(lists.data ?? []).length === 0 ? (
            <li className="p-4 text-center text-muted-foreground text-sm">
              {lists.isLoading ? "Cargando…" : "Todavía no hay listas de precios."}
            </li>
          ) : null}
          {(lists.data ?? []).map((l) =>
            editing?.id === l.id ? (
              <li key={l.id} className="px-3 py-2">
                <form
                  className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_6rem_auto_auto]"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void save()
                  }}
                >
                  <Input
                    autoFocus
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    aria-label={`Nombre de ${l.name}`}
                    maxLength={60}
                  />
                  <Input
                    value={editing.adjust}
                    onChange={(e) => setEditing({ ...editing, adjust: e.target.value })}
                    aria-label={`Ajuste de ${l.name}`}
                    placeholder="0"
                    className="tabular"
                  />
                  <Button type="submit" size="sm" disabled={busy || !editing.name.trim()}>
                    Guardar
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                    Cancelar
                  </Button>
                </form>
              </li>
            ) : (
              <li
                key={l.id}
                className={`flex items-center gap-2 px-3 py-2 text-sm ${l.active ? "" : "opacity-60"}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{l.name}</span>
                  <Badge variant="secondary" className="ml-2">
                    {adjustLabel(l.adjustBp)}
                  </Badge>
                  {l.active ? null : (
                    <Badge variant="outline" className="ml-2">
                      Inactiva
                    </Badge>
                  )}
                  <span className="block text-muted-foreground text-xs">{counts(l)}</span>
                </span>
                {canManage ? (
                  <span className="flex shrink-0 gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Editar ${l.name}`}
                      title="Editar"
                      disabled={busy}
                      onClick={() =>
                        setEditing({ id: l.id, name: l.name, adjust: signedInput(l.adjustBp) })
                      }
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={l.active ? `Desactivar ${l.name}` : `Activar ${l.name}`}
                      title={l.active ? "Desactivar" : "Activar"}
                      disabled={busy}
                      onClick={() => toggle(l)}
                    >
                      {l.active ? <EyeIcon /> : <EyeOffIcon />}
                    </Button>
                  </span>
                ) : null}
              </li>
            ),
          )}
        </ul>

        <DialogFooter>
          <Button onClick={onClose}>Listo</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
