import type { Bootstrap, CatalogItem, PickedModifier } from "@millhiore/contracts"
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from "@millhiore/ui"
import { CheckIcon } from "lucide-react"
import { useState } from "react"
import { formatMoney } from "../../lib/format"
import { type PosContext, unitPriceInDoc } from "./compute"
import type { LineExtras } from "./store"

type Group = Bootstrap["modifierGroups"][number]

/** Qué pide cada grupo: «Elige 1», «Hasta 2», «Opcional»… */
export function groupRule(g: Pick<Group, "minSelect" | "maxSelect">): string {
  if (g.minSelect > 0 && g.maxSelect === g.minSelect) return `Elige ${g.minSelect}`
  if (g.minSelect > 0) return `Elige al menos ${g.minSelect}`
  if (g.maxSelect !== null) return `Opcional, hasta ${g.maxSelect}`
  return "Opcional"
}

/** Lo que falta para poder agregarlo (un grupo obligatorio sin elegir); null si está completo. */
export function missingChoice(groups: readonly Group[], picked: readonly string[]): string | null {
  for (const g of groups) {
    const count = g.modifiers.filter((m) => picked.includes(m.id)).length
    if (count < g.minSelect) return g.name
  }
  return null
}

/**
 * Elegir las opciones y extras de un producto (término, queso extra) y, si hace falta, las
 * indicaciones para la cocina. Un grupo de una sola opción se comporta como radio.
 */
export function ModifierDialog({
  item,
  groups,
  ctx,
  onConfirm,
  onClose,
}: {
  item: CatalogItem
  groups: readonly Group[]
  ctx: PosContext
  onConfirm: (extras: LineExtras) => void
  onClose: () => void
}) {
  const own = item.modifierGroupIds.flatMap((id) => groups.find((g) => g.id === id) ?? [])
  const [picked, setPicked] = useState<string[]>([])
  const [note, setNote] = useState("")
  const doc = ctx.docCurrency
  const base = unitPriceInDoc(ctx, item.priceMinor, item.priceCurrency)
  const chosen: PickedModifier[] = own.flatMap((g) =>
    g.modifiers.filter((m) => picked.includes(m.id)),
  )
  const extra = chosen.reduce<number | null>((acc, m) => {
    if (acc === null || !m.priceMinor || !m.priceCurrency) return acc
    const minor = unitPriceInDoc(ctx, m.priceMinor, m.priceCurrency)
    return minor === null ? null : acc + minor
  }, 0)
  const missing = missingChoice(own, picked)

  const toggle = (g: Group, id: string) => {
    setPicked((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id)
      const inGroup = g.modifiers.map((m) => m.id)
      // Una sola: elegir otra reemplaza la anterior.
      if (g.maxSelect === 1) return [...current.filter((x) => !inGroup.includes(x)), id]
      const count = current.filter((x) => inGroup.includes(x)).length
      if (g.maxSelect !== null && count >= g.maxSelect) return current
      return [...current, id]
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
        <form
          className="grid grid-cols-1 gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (missing) return
            onConfirm({ modifiers: chosen, note: note.trim() || null })
          }}
        >
          <DialogHeader>
            <DialogTitle>{item.name}</DialogTitle>
            <DialogDescription>Elige las opciones.</DialogDescription>
          </DialogHeader>
          {own.map((g) => {
            const count = g.modifiers.filter((m) => picked.includes(m.id)).length
            const full = g.maxSelect !== null && g.maxSelect > 1 && count >= g.maxSelect
            return (
              <fieldset key={g.id} className="grid min-w-0 grid-cols-1 gap-2">
                <legend className="mb-2 flex w-full items-baseline justify-between gap-2">
                  <span className="font-medium">{g.name}</span>
                  <span
                    className={cn(
                      "text-xs",
                      count < g.minSelect ? "font-medium text-primary" : "text-muted-foreground",
                    )}
                  >
                    {groupRule(g)}
                  </span>
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  {g.modifiers.map((m) => {
                    const on = picked.includes(m.id)
                    const price =
                      m.priceMinor && m.priceCurrency
                        ? unitPriceInDoc(ctx, m.priceMinor, m.priceCurrency)
                        : null
                    return (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={on}
                        disabled={!on && full}
                        onClick={() => toggle(g, m.id)}
                        className={cn(
                          "flex min-h-11 min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:cursor-default disabled:opacity-50",
                          on
                            ? "border-primary bg-primary text-primary-foreground"
                            : "hover:bg-accent",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          {on ? <CheckIcon className="size-4 shrink-0" /> : null}
                          <span className="truncate">{m.name}</span>
                        </span>
                        {price !== null ? (
                          <span className="tabular shrink-0 text-xs">
                            +{formatMoney(price, doc)}
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              </fieldset>
            )
          })}
          <Field label="Indicaciones" htmlFor="modifier-note">
            <Input
              id="modifier-note"
              value={note}
              maxLength={140}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Sin cebolla, para llevar…"
            />
          </Field>
          <DialogFooter className="items-center">
            {missing ? (
              <span className="mr-auto text-muted-foreground text-sm">
                Falta elegir «{missing}»
              </span>
            ) : null}
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={missing !== null}>
              Agregar
              {base !== null && extra !== null ? ` · ${formatMoney(base + extra, doc)}` : ""}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Las opciones elegidas en una línea, para mostrarlas debajo del nombre. */
export function modifiersText(
  modifiers: readonly PickedModifier[] | undefined,
  note?: string | null,
): string | null {
  const parts = [...(modifiers ?? []).map((m) => m.name), ...(note ? [note] : [])]
  return parts.length ? parts.join(" · ") : null
}
