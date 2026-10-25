import { MAX_OPTIONS } from "@millhiore/domain"
import { Badge, Button, Input, Label, NativeSelect } from "@millhiore/ui"
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react"
import { useState } from "react"
import { ScanButton } from "../../components/CameraScanner"
import { formatQty } from "../../lib/format"
import {
  type Assigned,
  addOption,
  addValues,
  type ComboDraft,
  comboState,
  combosOf,
  type VariantsDraft,
} from "./variantsForm"

/**
 * Tallas, colores u otras características del producto y, debajo, cada combinación con su
 * precio, su código de barras y su SKU. Cambiar el texto de un valor no cambia la variante.
 */
export function VariantsEditor({
  draft,
  onChange,
  basePrice,
  tracksStock,
  assigned,
  onAssign,
  errorKey,
}: {
  draft: VariantsDraft
  onChange: (draft: VariantsDraft) => void
  /** El precio del producto: el de las combinaciones sin precio propio. */
  basePrice: string
  tracksStock: boolean
  /** Producto que ya existía sin tallas: en qué combinación queda lo que ya tiene. */
  assigned: Assigned | null
  onAssign: ((key: string) => void) | null
  /** La combinación con el error que hay que corregir. */
  errorKey: string | null
}) {
  const combos = combosOf(draft.options)
  const setOptions = (options: VariantsDraft["options"]) => onChange({ ...draft, options })
  const setCombo = (key: string, patch: Partial<ComboDraft>) =>
    onChange({
      ...draft,
      combos: { ...draft.combos, [key]: { ...comboState(draft, key, assigned), ...patch } },
    })
  const ownPrices = combos.filter((c) => {
    const p = comboState(draft, c.key, assigned).price
    return p !== null && p.trim() !== "" && p.trim() !== basePrice.trim()
  }).length

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3">
      {draft.options.map((o, i) => (
        <OptionRow
          key={o.key}
          index={i}
          option={o}
          onRename={(name) =>
            setOptions(draft.options.map((x) => (x.key === o.key ? { ...x, name } : x)))
          }
          onRemove={() => setOptions(draft.options.filter((x) => x.key !== o.key))}
          onValue={(valueKey, text) =>
            setOptions(
              draft.options.map((x) =>
                x.key === o.key
                  ? { ...x, values: x.values.map((v) => (v.key === valueKey ? { ...v, text } : v)) }
                  : x,
              ),
            )
          }
          onRemoveValue={(valueKey) =>
            setOptions(
              draft.options.map((x) =>
                x.key === o.key ? { ...x, values: x.values.filter((v) => v.key !== valueKey) } : x,
              ),
            )
          }
          onAdd={(text) => onChange(addValues(draft, o.key, text))}
        />
      ))}
      {draft.options.length < MAX_OPTIONS ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() => onChange(addOption(draft))}
        >
          <PlusIcon /> {draft.options.length ? "Otra característica" : "Agregar talla, color…"}
        </Button>
      ) : null}

      {assigned && onAssign && combos.length ? (
        <div className="grid gap-1.5">
          <Label htmlFor="v-assign">Lo que ya tiene este producto es de</Label>
          <NativeSelect
            id="v-assign"
            value={assigned.key}
            onChange={(e) => onAssign(e.target.value)}
          >
            {combos.map((c) => (
              <option key={c.key} value={c.key}>
                {c.values.join(", ")}
              </option>
            ))}
          </NativeSelect>
          <p className="text-muted-foreground text-xs">
            Su existencia{tracksStock ? ` (${formatQty(assigned.stockMilli)})` : ""}, su código y
            sus ventas pasan a esa combinación.
          </p>
        </div>
      ) : null}

      {combos.length ? (
        <div className="grid min-w-0 gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">
              {combos.length === 1 ? "1 combinación" : `${combos.length} combinaciones`}
            </span>
            {ownPrices ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() =>
                  onChange({
                    ...draft,
                    combos: Object.fromEntries(
                      combos.map((c) => [
                        c.key,
                        { ...comboState(draft, c.key, assigned), price: null },
                      ]),
                    ),
                  })
                }
              >
                Mismo precio para todas
              </Button>
            ) : null}
          </div>
          <ul className="divide-y rounded-lg border">
            {combos.map((c) => {
              const s = comboState(draft, c.key, assigned)
              const label = c.values.join(", ")
              const id = `v-${c.key.replaceAll("|", "-")}`
              return (
                <li
                  key={c.key}
                  className={`grid gap-2 px-3 py-2 ${errorKey === c.key ? "bg-destructive/10" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      id={`${id}-active`}
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={s.active}
                      onChange={(e) => setCombo(c.key, { active: e.target.checked })}
                      aria-label={`Vender ${label}`}
                    />
                    <label
                      htmlFor={`${id}-active`}
                      className={`min-w-0 flex-1 truncate font-medium text-sm ${s.active ? "" : "text-muted-foreground line-through"}`}
                    >
                      {label}
                    </label>
                    {tracksStock && s.id ? (
                      <Badge variant="secondary" className="tabular shrink-0">
                        {formatQty(s.stockMilli)}
                      </Badge>
                    ) : null}
                    {s.id ? null : (
                      <Badge variant="outline" className="shrink-0">
                        Nueva
                      </Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-[6rem_minmax(0,1fr)_minmax(0,8rem)]">
                    <Input
                      inputMode="decimal"
                      className="tabular h-9 text-sm"
                      value={s.price ?? ""}
                      placeholder={basePrice || "Precio"}
                      onChange={(e) => setCombo(c.key, { price: e.target.value })}
                      aria-label={`Precio de ${label}`}
                    />
                    <Input
                      className="h-9 text-sm sm:order-last"
                      value={s.sku}
                      placeholder="SKU automático"
                      onChange={(e) => setCombo(c.key, { sku: e.target.value })}
                      aria-label={`SKU de ${label}`}
                    />
                    <div className="col-span-2 flex gap-1.5 sm:col-span-1">
                      <Input
                        className="h-9 text-sm"
                        value={s.barcode}
                        placeholder="Código de barras"
                        onChange={(e) => setCombo(c.key, { barcode: e.target.value })}
                        aria-label={`Código de barras de ${label}`}
                      />
                      <ScanButton
                        className="size-9"
                        label={`Leer el código de ${label}`}
                        onCode={(code) => setCombo(c.key, { barcode: code })}
                      />
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="text-muted-foreground text-xs">
            Sin precio propio, cada una vale el del producto. Sin SKU, se genera. Las que desmarques
            o quites dejan de venderse, pero no se borran.
          </p>
        </div>
      ) : null}
    </div>
  )
}

function OptionRow({
  index,
  option,
  onRename,
  onRemove,
  onValue,
  onRemoveValue,
  onAdd,
}: {
  index: number
  option: VariantsDraft["options"][number]
  onRename: (name: string) => void
  onRemove: () => void
  onValue: (valueKey: string, text: string) => void
  onRemoveValue: (valueKey: string) => void
  onAdd: (text: string) => void
}) {
  const [adding, setAdding] = useState("")
  const commit = () => {
    if (adding.trim()) onAdd(adding)
    setAdding("")
  }
  return (
    <div className="grid min-w-0 gap-2 rounded-lg border p-2.5">
      <div className="flex items-center gap-2">
        <Input
          className="h-9 w-40 font-medium"
          value={option.name}
          placeholder={["Talla", "Color", "Material"][index] ?? "Característica"}
          onChange={(e) => onRename(e.target.value)}
          aria-label={`Nombre de la característica ${index + 1}`}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto text-muted-foreground"
          onClick={onRemove}
          aria-label={`Quitar ${option.name || "la característica"}`}
          title="Quitar"
        >
          <Trash2Icon />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {option.values.map((v) => (
          <span key={v.key} className="flex h-8 items-center rounded-md border bg-muted/40">
            {/* El texto invisible le da al campo justo el ancho de lo escrito. */}
            <span className="inline-grid h-full max-w-48 items-center text-sm">
              <span className="invisible col-start-1 row-start-1 overflow-hidden whitespace-pre pr-0.5 pl-2">
                {v.text || "  "}
              </span>
              <input
                size={1}
                className="col-start-1 row-start-1 h-full w-full min-w-0 bg-transparent pl-2 outline-none"
                value={v.text}
                onChange={(e) => onValue(v.key, e.target.value)}
                aria-label={`Valor de ${option.name}`}
              />
            </span>
            <button
              type="button"
              className="grid h-full cursor-pointer place-items-center px-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => onRemoveValue(v.key)}
              aria-label={`Quitar ${v.text}`}
            >
              <XIcon className="size-3.5" />
            </button>
          </span>
        ))}
        <Input
          className="h-8 w-36 text-sm"
          value={adding}
          placeholder={option.values.length ? "Agregar…" : "S, M, L…"}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault()
              commit()
            }
          }}
          onBlur={commit}
          aria-label={`Agregar valores a ${option.name || "la característica"}`}
        />
      </div>
    </div>
  )
}
