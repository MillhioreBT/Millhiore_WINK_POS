import type { ModifierGroup } from "@millhiore/contracts"
import {
  Badge,
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
import { PencilIcon, PlusIcon, XIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatMoney, parseAmount, toInputAmount } from "../../lib/format"
import { bootstrapQuery, modifierGroupsQuery, queryClient } from "../../lib/queries"
import { groupRule } from "../pos/ModifierDialog"

/** Cuántas se eligen, en palabras: lo que suele pedir cada grupo. */
const RULES = [
  { id: "one", label: "Una, obligatoria (término, tamaño)", min: 1, max: 1 },
  { id: "one-optional", label: "Una, opcional", min: 0, max: 1 },
  { id: "many", label: "Varias, opcionales (extras)", min: 0, max: null },
  { id: "many-required", label: "Varias, al menos una", min: 1, max: null },
] as const

function ruleOf(g: { minSelect: number; maxSelect: number | null }): string {
  return (
    RULES.find((r) => r.min === g.minSelect && r.max === g.maxSelect)?.id ??
    (g.minSelect > 0 ? "many-required" : "many")
  )
}

interface OptionRow {
  key: string
  id?: string
  name: string
  price: string
  currency: string
}

let seq = 0
const rowKey = () => `o${++seq}`

/** Los grupos de opciones y extras: la lista y el formulario de cada uno. */
export function ModifierGroupsDialog({ onClose }: { onClose: () => void }) {
  const groups = useQuery(modifierGroupsQuery)
  const [editing, setEditing] = useState<ModifierGroup | "new" | null>(null)

  if (editing) {
    return (
      <GroupForm
        group={editing === "new" ? null : editing}
        onDone={() => setEditing(null)}
        onClose={onClose}
      />
    )
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Opciones y extras</DialogTitle>
          <DialogDescription>
            Lo que se elige al vender: el término de la carne, el tamaño, los extras con su precio.
            Cada grupo se ofrece con los productos que lo tengan.
          </DialogDescription>
        </DialogHeader>
        {groups.data?.length === 0 ? (
          <p className="text-muted-foreground text-sm">Aún no hay grupos.</p>
        ) : null}
        <ul className="grid grid-cols-1 divide-y rounded-lg border">
          {(groups.data ?? []).map((g) => (
            <li
              key={g.id}
              className={`flex items-start gap-2 px-3 py-2 ${g.active ? "" : "opacity-60"}`}
            >
              <span className="min-w-0 flex-1 text-sm">
                <span className="font-medium">{g.name}</span>
                {g.active ? null : (
                  <Badge variant="outline" className="ml-2">
                    Inactivo
                  </Badge>
                )}
                <span className="block text-muted-foreground text-xs">
                  {groupRule(g)} ·{" "}
                  {g.modifiers
                    .filter((m) => m.active)
                    .map((m) =>
                      m.priceMinor && m.priceCurrency
                        ? `${m.name} +${formatMoney(m.priceMinor, m.priceCurrency)}`
                        : m.name,
                    )
                    .join(", ")}
                </span>
                <span className="block text-muted-foreground text-xs">
                  {g.productCount === 1 ? "1 producto" : `${g.productCount} productos`}
                </span>
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Editar ${g.name}`}
                onClick={() => setEditing(g)}
              >
                <PencilIcon />
              </Button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
          <Button onClick={() => setEditing("new")}>
            <PlusIcon /> Nuevo grupo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function GroupForm({
  group,
  onDone,
  onClose,
}: {
  group: ModifierGroup | null
  onDone: () => void
  onClose: () => void
}) {
  const boot = useQuery(bootstrapQuery)
  const reference = boot.data?.business.referenceCurrency ?? "USD"
  const legal = boot.data?.business.legalCurrency ?? "VES"
  const symbol = (code: string) =>
    boot.data?.currencies.find((c) => c.code === code)?.symbol ?? code
  const [name, setName] = useState(group?.name ?? "")
  const [rule, setRule] = useState(group ? ruleOf(group) : "one")
  const [active, setActive] = useState(group?.active ?? true)
  const [rows, setRows] = useState<OptionRow[]>(() =>
    group
      ? group.modifiers
          .filter((m) => m.active)
          .map((m) => ({
            key: rowKey(),
            id: m.id,
            name: m.name,
            price: m.priceMinor ? toInputAmount(m.priceMinor) : "",
            currency: m.priceCurrency ?? reference,
          }))
      : [{ key: rowKey(), name: "", price: "", currency: reference }],
  )
  const [busy, setBusy] = useState(false)
  const set = (key: string, patch: Partial<OptionRow>) =>
    setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const chosen = RULES.find((r) => r.id === rule) ?? RULES[0]
    const modifiers = []
    for (const r of rows) {
      const price = r.price.trim() ? parseAmount(r.price) : 0
      if (price === null) {
        toast.error(`Revisa el precio de «${r.name || "la opción"}»`)
        return
      }
      modifiers.push({
        ...(r.id ? { id: r.id } : {}),
        name: r.name.trim(),
        priceMinor: price,
        ...(price ? { priceCurrency: r.currency } : {}),
      })
    }
    setBusy(true)
    try {
      await api(group ? `/api/modifier-groups/${group.id}` : "/api/modifier-groups", {
        method: group ? "PUT" : "POST",
        body: {
          name: name.trim(),
          minSelect: chosen.min,
          maxSelect: chosen.max,
          active,
          modifiers,
        },
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["modifier-groups"] }),
        queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
        queryClient.invalidateQueries({ queryKey: ["products"] }),
      ])
      toast.success(group ? "Grupo guardado" : "Grupo creado")
      onDone()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <form onSubmit={save} className="grid grid-cols-1 gap-4">
          <DialogHeader>
            <DialogTitle>{group ? group.name : "Nuevo grupo"}</DialogTitle>
            <DialogDescription>
              El precio de una opción se suma al del producto; déjalo vacío si no cambia el precio.
            </DialogDescription>
          </DialogHeader>
          <Field label="Nombre del grupo" htmlFor="mg-name">
            <Input
              id="mg-name"
              value={name}
              maxLength={40}
              autoFocus={!group}
              onChange={(e) => setName(e.target.value)}
              placeholder="Término, Tamaño, Extras…"
            />
          </Field>
          <Field label="Cuántas se eligen" htmlFor="mg-rule">
            <NativeSelect id="mg-rule" value={rule} onChange={(e) => setRule(e.target.value)}>
              {RULES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <fieldset className="grid min-w-0 grid-cols-1 gap-2">
            <legend className="mb-1.5 font-medium text-sm">Opciones</legend>
            {rows.map((r, i) => (
              <div
                key={r.key}
                className="grid grid-cols-[minmax(0,1fr)_5.5rem_auto] gap-1.5 sm:grid-cols-[minmax(0,1fr)_6rem_5.5rem_auto]"
              >
                {/* En el celular el nombre va arriba, a lo ancho; el precio debajo. */}
                <Input
                  className="col-span-3 sm:col-span-1"
                  value={r.name}
                  maxLength={40}
                  aria-label={`Opción ${i + 1}`}
                  placeholder="Queso extra"
                  onChange={(e) => set(r.key, { name: e.target.value })}
                />
                <Input
                  value={r.price}
                  inputMode="decimal"
                  aria-label={`Precio de la opción ${i + 1}`}
                  placeholder="0,00"
                  onChange={(e) => set(r.key, { price: e.target.value })}
                />
                <NativeSelect
                  value={r.currency}
                  aria-label={`Moneda de la opción ${i + 1}`}
                  onChange={(e) => set(r.key, { currency: e.target.value })}
                >
                  <option value={reference}>{symbol(reference)}</option>
                  {legal !== reference ? <option value={legal}>{symbol(legal)}</option> : null}
                </NativeSelect>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Quitar la opción ${i + 1}`}
                  disabled={rows.length === 1}
                  onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}
                >
                  <XIcon />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="justify-self-start"
              onClick={() =>
                setRows((all) => [
                  ...all,
                  { key: rowKey(), name: "", price: "", currency: reference },
                ])
              }
            >
              <PlusIcon /> Opción
            </Button>
          </fieldset>
          {group ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Activo (si lo desactivas, deja de ofrecerse en todos los productos)
            </label>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onDone} disabled={busy}>
              Volver
            </Button>
            <Button
              type="submit"
              disabled={busy || !name.trim() || rows.some((r) => !r.name.trim())}
            >
              {busy ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
