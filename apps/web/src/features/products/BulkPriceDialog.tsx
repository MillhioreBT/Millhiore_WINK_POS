import type { BulkPriceBody, BulkPriceResult, PriceRounding } from "@millhiore/contracts"
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
import { ArrowRightIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatMoney, parseAmount } from "../../lib/format"
import { bootstrapQuery, categoriesQuery, queryClient } from "../../lib/queries"

type Scope = "all" | "category" | "filtered"
type Kind = "up" | "down" | "markup"

const ROUNDING_LABEL: Record<PriceRounding, string> = {
  none: "Al céntimo",
  five: "A 5 céntimos",
  ten: "A 10 céntimos",
  unit: "A la unidad",
}

/**
 * Cambia muchos precios a la vez: sube o baja un porcentaje, o pone una ganancia sobre el costo.
 * Primero se ven los cambios y después se aplican; lo ya vendido conserva su precio.
 */
export function BulkPriceDialog({
  filteredIds,
  canUseCost,
  onClose,
}: {
  /** Los productos que se ven en la lista con los filtros de ahora; null si no hay filtros. */
  filteredIds: string[] | null
  canUseCost: boolean
  onClose: () => void
}) {
  const { data: boot } = useQuery(bootstrapQuery)
  const categories = useQuery(categoriesQuery())
  const [scope, setScope] = useState<Scope>(filteredIds ? "filtered" : "all")
  const [categoryId, setCategoryId] = useState("")
  const [kind, setKind] = useState<Kind>("up")
  const [value, setValue] = useState("")
  const [rounding, setRounding] = useState<PriceRounding>("none")
  const [preview, setPreview] = useState<BulkPriceResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Cualquier cambio en el formulario invalida la vista previa.
  const edit =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v)
      setPreview(null)
    }

  const body = (apply: boolean): BulkPriceBody | null => {
    const bp = value.trim() ? parseAmount(value) : 0
    if (bp === null) {
      setError("Escribe un porcentaje, p. ej. 10 o 12,5")
      return null
    }
    if (kind === "down" && bp >= 10_000) {
      setError("No se puede bajar el 100 % o más")
      return null
    }
    if (scope === "category" && !categoryId) {
      setError("Elige la categoría")
      return null
    }
    setError(null)
    return {
      mode: kind === "markup" ? "markup" : "percent",
      valueBp: kind === "down" ? -bp : bp,
      rounding,
      apply,
      ...(scope === "category" ? { categoryId } : {}),
      ...(scope === "filtered" && filteredIds ? { variantIds: filteredIds } : {}),
    }
  }

  const run = async (apply: boolean) => {
    const b = body(apply)
    if (!b) return
    setBusy(true)
    try {
      const result = await api<BulkPriceResult>("/api/products/bulk-price", { body: b })
      if (apply) {
        toast.success(
          result.changed === 1 ? "Se cambió 1 precio" : `Se cambiaron ${result.changed} precios`,
        )
        await queryClient.invalidateQueries({ queryKey: ["products"] })
        onClose()
      } else {
        setPreview(result)
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const pricesIncludeTax = boot?.fiscal.pricesIncludeTax && boot.fiscal.taxpayer !== "none"
  const noFilteredItems = scope === "filtered" && filteredIds?.length === 0

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cambiar precios</DialogTitle>
          <DialogDescription>
            Revisa los cambios antes de aplicarlos. Lo ya vendido conserva su precio.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="¿A qué productos?" htmlFor="bp-scope">
            <NativeSelect
              id="bp-scope"
              value={scope}
              onChange={(e) => edit(setScope)(e.target.value as Scope)}
            >
              <option value="all">Todos los activos</option>
              <option value="category">Los de una categoría</option>
              {filteredIds ? (
                <option value="filtered">
                  {filteredIds.length === 1
                    ? "El que estoy viendo"
                    : `Los ${filteredIds.length} que estoy viendo`}
                </option>
              ) : null}
            </NativeSelect>
          </Field>
          {scope === "category" ? (
            <Field label="Categoría" htmlFor="bp-category">
              <NativeSelect
                id="bp-category"
                value={categoryId}
                onChange={(e) => edit(setCategoryId)(e.target.value)}
              >
                <option value="">Elige una</option>
                {(categories.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value="none">Sin categoría</option>
              </NativeSelect>
            </Field>
          ) : null}
          <Field label="¿Qué hacer?" htmlFor="bp-kind">
            <NativeSelect
              id="bp-kind"
              value={kind}
              onChange={(e) => edit(setKind)(e.target.value as Kind)}
            >
              <option value="up">Subir un porcentaje</option>
              <option value="down">Bajar un porcentaje</option>
              {canUseCost ? <option value="markup">Ganancia sobre el costo</option> : null}
            </NativeSelect>
          </Field>
          <Field
            label={kind === "markup" ? "Ganancia (%)" : "Porcentaje"}
            htmlFor="bp-value"
            error={error ?? undefined}
            hint={
              kind === "markup"
                ? pricesIncludeTax
                  ? "Costo + ganancia + IVA. Sin costo se deja igual"
                  : "Costo + ganancia. Sin costo se deja igual"
                : undefined
            }
          >
            <Input
              id="bp-value"
              inputMode="decimal"
              value={value}
              onChange={(e) => edit(setValue)(e.target.value)}
              placeholder="10"
              className="tabular"
            />
          </Field>
          <Field label="Redondear" htmlFor="bp-rounding" hint="Al más cercano">
            <NativeSelect
              id="bp-rounding"
              value={rounding}
              onChange={(e) => edit(setRounding)(e.target.value as PriceRounding)}
            >
              {(Object.keys(ROUNDING_LABEL) as PriceRounding[]).map((r) => (
                <option key={r} value={r}>
                  {ROUNDING_LABEL[r]}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>

        {preview ? <PreviewTable preview={preview} /> : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          {preview && preview.changed > 0 ? (
            <Button onClick={() => run(true)} disabled={busy}>
              {busy
                ? "Aplicando…"
                : preview.changed === 1
                  ? "Aplicar 1 cambio"
                  : `Aplicar ${preview.changed} cambios`}
            </Button>
          ) : (
            <Button onClick={() => run(false)} disabled={busy || noFilteredItems}>
              {busy ? "Calculando…" : "Ver cambios"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PreviewTable({ preview }: { preview: BulkPriceResult }) {
  const notes = [
    preview.unchanged
      ? preview.unchanged === 1
        ? "1 queda igual"
        : `${preview.unchanged} quedan igual`
      : null,
    preview.skippedNoCost
      ? preview.skippedNoCost === 1
        ? "1 sin costo de compra (no cambia)"
        : `${preview.skippedNoCost} sin costo de compra (no cambian)`
      : null,
    preview.skippedNoRate
      ? `${preview.skippedNoRate} sin tasa para convertir su costo (no cambian)`
      : null,
  ].filter(Boolean)
  const hidden = preview.changed - preview.changes.length
  return (
    <div className="grid grid-cols-1 gap-2">
      <p className="text-sm">
        <span className="font-medium">
          {preview.changed === 0
            ? "Ningún precio cambia."
            : preview.changed === 1
              ? "Cambia 1 precio."
              : `Cambian ${preview.changed} precios.`}
        </span>{" "}
        <span className="text-muted-foreground">{notes.join(" · ")}</span>
      </p>
      {preview.changes.length ? (
        <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border text-sm">
          {preview.changes.map((c) => (
            <li
              key={c.variantId}
              className="grid grid-cols-[1fr_auto] items-center gap-x-3 px-3 py-1.5"
            >
              <span className="min-w-0 truncate" title={c.name}>
                {c.name}
              </span>
              <span className="tabular flex items-center gap-1.5 whitespace-nowrap">
                <span className="text-muted-foreground line-through">
                  {formatMoney(c.beforeMinor, c.currency)}
                </span>
                <ArrowRightIcon className="size-3.5 text-muted-foreground" />
                <span className="font-medium">{formatMoney(c.afterMinor, c.currency)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {hidden > 0 ? (
        <p className="text-muted-foreground text-xs">
          Y {hidden} más que no se muestran: también se cambian.
        </p>
      ) : null}
    </div>
  )
}
