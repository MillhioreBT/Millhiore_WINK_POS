import type { SaleCharge } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Label,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { EyeIcon, EyeOffIcon, PencilIcon, PlusIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { ApiError, api, errorMessage } from "../../lib/api"
import {
  currencySymbol,
  formatMoney,
  formatPercent,
  parseAmount,
  toInputAmount,
} from "../../lib/format"
import { bootstrapQuery, chargesQuery, queryClient, taxesQuery } from "../../lib/queries"

const refresh = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ["charges"] }),
    queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
  ])

/** Cómo se lee un recargo: «$ 2,00 · sin IVA · se agrega solo». */
function summary(c: SaleCharge, taxName: (id: string | null) => string): string {
  return [
    c.kind === "percent"
      ? `${formatPercent(c.rateBp)} del subtotal sin IVA`
      : formatMoney(c.amountMinor, c.currency ?? "USD"),
    taxName(c.taxId),
    c.auto ? "se agrega solo" : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

/**
 * Recargos de venta (delivery, servicio, empaque): se suman a la venta aparte de los productos.
 * En la caja se activan con un toque; los marcados «se agrega solo» vienen puestos.
 */
export function ChargesCard({ canManage }: { canManage: boolean }) {
  const charges = useQuery(chargesQuery({ all: true }))
  const taxes = useQuery(taxesQuery)
  const [editing, setEditing] = useState<SaleCharge | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const taxName = (id: string | null) => {
    const t = taxes.data?.find((x) => x.id === id)
    return !t ? "sin IVA" : t.kind === "taxed" ? `IVA ${formatPercent(t.rateBp)}` : t.name
  }

  const toggle = async (c: SaleCharge) => {
    setBusy(true)
    try {
      await api(`/api/charges/${c.id}`, { method: "PATCH", body: { active: !c.active } })
      await refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Recargos de venta</CardTitle>
        <CardDescription>
          Delivery, servicio, empaque… Se suman a la venta aparte de los productos y van en el
          recibo. El de porcentaje se calcula sobre el subtotal sin IVA. Si un recargo lleva IVA o
          no, confírmalo con tu contador.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3">
        <ul className="divide-y rounded-lg border">
          {(charges.data ?? []).length === 0 ? (
            <li className="p-4 text-center text-muted-foreground text-sm">
              {charges.isLoading ? "Cargando…" : "No hay recargos."}
            </li>
          ) : null}
          {(charges.data ?? []).map((c) => (
            <li
              key={c.id}
              className={`flex items-center gap-2 px-3 py-2 text-sm ${c.active ? "" : "opacity-60"}`}
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium">{c.name}</span>
                {c.active ? null : (
                  <Badge variant="outline" className="ml-2">
                    Inactivo
                  </Badge>
                )}
                <span className="block text-muted-foreground text-xs">{summary(c, taxName)}</span>
              </span>
              {canManage ? (
                <span className="flex shrink-0 gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Editar ${c.name}`}
                    title="Editar"
                    onClick={() => setEditing(c)}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={c.active ? `Desactivar ${c.name}` : `Activar ${c.name}`}
                    title={c.active ? "Desactivar" : "Activar"}
                    disabled={busy}
                    onClick={() => toggle(c)}
                  >
                    {c.active ? <EyeIcon /> : <EyeOffIcon />}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {canManage ? (
          <Button variant="outline" className="justify-self-start" onClick={() => setEditing(null)}>
            <PlusIcon /> Nuevo recargo
          </Button>
        ) : null}
      </CardContent>
      {editing !== undefined ? (
        <ChargeDialog charge={editing} onClose={() => setEditing(undefined)} />
      ) : null}
    </Card>
  )
}

function ChargeDialog({ charge, onClose }: { charge: SaleCharge | null; onClose: () => void }) {
  const { data: boot } = useQuery(bootstrapQuery)
  const taxes = useQuery(taxesQuery)
  const reference = boot?.business.referenceCurrency ?? "USD"
  const legal = boot?.business.legalCurrency ?? "VES"
  const [form, setForm] = useState(() => ({
    name: charge?.name ?? "",
    kind: charge?.kind ?? "fixed",
    value: charge
      ? toInputAmount(charge.kind === "percent" ? charge.rateBp : charge.amountMinor)
      : "",
    currency: charge?.currency ?? reference,
    taxId: charge?.taxId ?? "",
    auto: charge?.auto ?? false,
  }))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({
        ...f,
        [k]:
          e.target instanceof HTMLInputElement && e.target.type === "checkbox"
            ? e.target.checked
            : e.target.value,
      }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const value = parseAmount(form.value)
    if (value === null || (form.kind === "percent" && (value <= 0 || value > 10_000))) {
      setErrors({
        value: form.kind === "percent" ? "Un porcentaje de 0,01 a 100" : "Escribe un monto",
      })
      return
    }
    setErrors({})
    setBusy(true)
    const body = {
      name: form.name.trim(),
      taxId: form.taxId || null,
      auto: form.auto,
      ...(form.kind === "percent"
        ? { rateBp: value }
        : { amountMinor: value, currency: form.currency }),
    }
    try {
      if (charge) {
        await api(`/api/charges/${charge.id}`, { method: "PATCH", body })
        toast.success("Recargo guardado. Las ventas ya hechas no cambian.")
      } else {
        await api("/api/charges", { body: { ...body, kind: form.kind } })
        toast.success(`${body.name} creado`)
      }
      await refresh()
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.issues.length) {
        setErrors(Object.fromEntries(err.issues.map((i) => [i.path, i.message])))
      } else {
        toast.error(errorMessage(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{charge ? "Editar recargo" : "Nuevo recargo"}</DialogTitle>
          <DialogDescription>
            Un monto fijo (delivery, empaque) o un porcentaje del subtotal sin IVA (servicio).
          </DialogDescription>
        </DialogHeader>
        <form id="charge-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <Field label="Nombre" htmlFor="ch-name" error={errors.name}>
            <Input
              id="ch-name"
              value={form.name}
              onChange={set("name")}
              placeholder="Delivery"
              required
              autoFocus
              maxLength={60}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Tipo"
              htmlFor="ch-kind"
              hint={charge ? "No se cambia: crea otro si hace falta" : undefined}
            >
              <NativeSelect
                id="ch-kind"
                value={form.kind}
                onChange={set("kind")}
                disabled={charge !== null}
              >
                <option value="fixed">Monto fijo</option>
                <option value="percent">Porcentaje</option>
              </NativeSelect>
            </Field>
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Field
                label={form.kind === "percent" ? "Porcentaje" : "Monto sugerido"}
                htmlFor="ch-value"
                error={errors.value ?? errors.rateBp ?? errors.amountMinor}
              >
                <Input
                  id="ch-value"
                  inputMode="decimal"
                  value={form.value}
                  onChange={set("value")}
                  placeholder={form.kind === "percent" ? "10" : "2,00"}
                  className="tabular"
                />
              </Field>
              {form.kind === "fixed" ? (
                <Field label="Moneda" htmlFor="ch-currency">
                  <NativeSelect id="ch-currency" value={form.currency} onChange={set("currency")}>
                    <option value={reference}>{currencySymbol(reference)}</option>
                    <option value={legal}>{currencySymbol(legal)}</option>
                  </NativeSelect>
                </Field>
              ) : null}
            </div>
          </div>
          <Field label="IVA" htmlFor="ch-tax">
            <NativeSelect id="ch-tax" value={form.taxId} onChange={set("taxId")}>
              <option value="">Sin IVA (no sujeto)</option>
              {(taxes.data ?? [])
                .filter((t) => t.active)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} {t.kind === "taxed" ? formatPercent(t.rateBp) : ""}
                  </option>
                ))}
            </NativeSelect>
          </Field>
          <div className="flex items-start gap-3">
            <input
              id="ch-auto"
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--primary)]"
              checked={form.auto}
              onChange={set("auto")}
            />
            <div className="grid gap-1">
              <Label htmlFor="ch-auto">Agregarlo solo a cada venta</Label>
              <p className="text-muted-foreground text-xs">
                En la caja se puede quitar en una venta si no corresponde.
              </p>
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="charge-form" disabled={busy}>
            {busy ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
