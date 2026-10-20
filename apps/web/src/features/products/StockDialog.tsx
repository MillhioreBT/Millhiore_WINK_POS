import type { CatalogItem } from "@millhiore/contracts"
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
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatQty, parseAmount } from "../../lib/format"
import { bootstrapQuery, queryClient, stockReasonsQuery } from "../../lib/queries"

type Mode = "in" | "out" | "count"

/** Los motivos de fábrica que usa el conteo físico: sobrante si sobra, faltante si falta. */
const COUNT_REASON = { in: "stk-in-count", out: "stk-out-count" } as const

/**
 * Ajuste de existencia: entrada, salida o conteo físico. Se registra como un documento de
 * ajuste con su motivo (queda en el kardex y se puede anular), nunca editando el saldo.
 */
export function StockDialog({ item, onClose }: { item: CatalogItem | null; onClose: () => void }) {
  const { data: boot } = useQuery(bootstrapQuery)
  const reasons = useQuery(stockReasonsQuery())
  const [mode, setMode] = useState<Mode>("in")
  const [qty, setQty] = useState("")
  const [reasonId, setReasonId] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  if (!item) return null

  const parsed = parseAmount(qty, 3)
  const delta =
    parsed === null
      ? null
      : mode === "in"
        ? parsed
        : mode === "out"
          ? -parsed
          : parsed - item.stockMilli

  // Los motivos del sentido elegido; en un conteo el motivo sale solo de si sobra o falta.
  const all = reasons.data ?? []
  const options = all.filter((r) => r.direction === (mode === "in" ? "in" : "out"))
  const chosen = options.find((r) => r.id === reasonId) ?? options[0]
  const countReason =
    delta === null || delta === 0
      ? undefined
      : all.find((r) => r.id === COUNT_REASON[delta > 0 ? "in" : "out"])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const terminalId = boot?.terminals[0]?.id
    if (delta === null || !terminalId || !boot) {
      toast.error("Escribe una cantidad válida")
      return
    }
    if (delta === 0) {
      toast.info("La existencia ya es esa: no hay nada que ajustar")
      onClose()
      return
    }
    setBusy(true)
    try {
      await api("/api/documents", {
        body: {
          id: uuidv7(),
          type: "ADJUSTMENT",
          terminalId,
          currency: boot.business.legalCurrency,
          lines: [{ variantId: item.variantId, qtyMilli: delta, unitPriceMinor: 0 }],
          payments: [],
          // Sin motivo elegido (o desactivado) el servidor usa «Otra entrada» u «Otra salida».
          stockReasonId: mode === "count" ? (countReason?.id ?? null) : (chosen?.id ?? null),
          note: note.trim() || null,
        },
      })
      await Promise.all(
        ["products", "stock-adjustments", "stock-reasons"].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      )
      toast.success(`Existencia de ${item.name}: ${formatQty(item.stockMilli + delta)}`)
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Ajustar existencia</DialogTitle>
          <DialogDescription>
            {item.name} · existencia actual: <strong>{formatQty(item.stockMilli)}</strong>
          </DialogDescription>
        </DialogHeader>
        <form id="stock-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <Field label="Tipo de ajuste" htmlFor="s-mode">
            <NativeSelect
              id="s-mode"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as Mode)
                setReasonId("")
              }}
            >
              <option value="in">Entrada (suma)</option>
              <option value="out">Salida (resta)</option>
              <option value="count">Conteo físico (existencia real)</option>
            </NativeSelect>
          </Field>
          <Field
            label={mode === "count" ? "Existencia contada" : "Cantidad"}
            htmlFor="s-qty"
            hint={
              delta !== null && delta !== 0
                ? `Quedará en ${formatQty(item.stockMilli + delta)}`
                : "Admite decimales para productos por peso"
            }
          >
            <Input
              id="s-qty"
              inputMode="decimal"
              autoFocus
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="tabular"
              required
            />
          </Field>
          {mode === "count" ? (
            <p className="-mt-2 text-muted-foreground text-xs">
              {delta === null || delta === 0
                ? "Si lo contado es distinto, se registra como sobrante o faltante de conteo."
                : delta > 0
                  ? "Se registra como «Sobrante de conteo»."
                  : "Se registra como «Faltante de conteo»."}
            </p>
          ) : (
            <Field label="Motivo" htmlFor="s-reason">
              <NativeSelect
                id="s-reason"
                value={chosen?.id ?? ""}
                onChange={(e) => setReasonId(e.target.value)}
              >
                {options.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label="Nota (opcional)" htmlFor="s-note">
            <Input
              id="s-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Se cayó una caja, lote 14…"
              maxLength={500}
            />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="stock-form" disabled={busy || delta === null}>
            {busy ? "Guardando…" : "Guardar ajuste"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
