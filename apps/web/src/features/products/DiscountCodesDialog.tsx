import type { DiscountCode } from "@millhiore/contracts"
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
  Label,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { PencilIcon, PlusIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import {
  formatDate,
  formatMoney,
  formatPercent,
  parseAmount,
  toInputAmount,
} from "../../lib/format"
import { bootstrapQuery, discountCodesQuery, queryClient } from "../../lib/queries"

const refresh = () =>
  Promise.all(
    ["discount-codes", "bootstrap"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
  )

/** Cómo se lee un código: «10 % · 3 de 50 usos · hasta 31/12/26». */
function summary(c: DiscountCode): string {
  return [
    c.kind === "percent"
      ? formatPercent(c.rateBp)
      : formatMoney(c.amountMinor, c.currency ?? "USD"),
    c.maxUses === null
      ? `${c.uses} uso${c.uses === 1 ? "" : "s"}`
      : `${c.uses} de ${c.maxUses} usos`,
    c.validFrom ? `desde ${formatDate(c.validFrom)}` : null,
    c.validUntil ? `hasta ${formatDate(c.validUntil)}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

/**
 * Códigos de descuento que el cliente dice en la caja (PROMO10): un porcentaje o un monto sobre
 * toda la venta. Cualquier cajero los aplica, aunque no pueda dar descuentos a mano.
 */
export function DiscountCodesDialog({ onClose }: { onClose: () => void }) {
  const codes = useQuery(discountCodesQuery)
  const [editing, setEditing] = useState<DiscountCode | null | undefined>(undefined)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Códigos de descuento</DialogTitle>
          <DialogDescription>
            El cliente dice el código en la caja y se descuenta de toda la venta. Uno por venta; una
            venta anulada devuelve el uso.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
          {(codes.data ?? []).length === 0 ? (
            <li className="p-4 text-center text-muted-foreground text-sm">
              {codes.isLoading ? "Cargando…" : "Aún no hay códigos."}
            </li>
          ) : null}
          {(codes.data ?? []).map((c) => (
            <li
              key={c.id}
              className={`flex items-center gap-2 px-3 py-2 text-sm ${c.active ? "" : "opacity-60"}`}
            >
              <span className="min-w-0 flex-1">
                <span className="tabular font-medium">{c.code}</span>
                {c.active ? null : (
                  <Badge variant="outline" className="ml-2">
                    Inactivo
                  </Badge>
                )}
                <span className="block text-muted-foreground text-xs">{summary(c)}</span>
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Editar ${c.code}`}
                title="Editar"
                onClick={() => setEditing(c)}
              >
                <PencilIcon />
              </Button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditing(null)}>
            <PlusIcon /> Nuevo código
          </Button>
          <Button onClick={onClose}>Listo</Button>
        </DialogFooter>
        {editing !== undefined ? (
          <CodeForm code={editing} onClose={() => setEditing(undefined)} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function CodeForm({ code, onClose }: { code: DiscountCode | null; onClose: () => void }) {
  const { data: boot } = useQuery(bootstrapQuery)
  const reference = boot?.business.referenceCurrency ?? "USD"
  const legal = boot?.business.legalCurrency ?? "VES"
  const [form, setForm] = useState(() => ({
    code: code?.code ?? "",
    kind: code?.kind ?? "percent",
    percent: code?.kind === "percent" ? String(code.rateBp / 100).replace(".", ",") : "",
    amount: code?.kind === "amount" ? toInputAmount(code.amountMinor) : "",
    currency: code?.currency ?? reference,
    maxUses: code?.maxUses ? String(code.maxUses) : "",
    validFrom: code?.validFrom ?? "",
    validUntil: code?.validUntil ?? "",
    note: code?.note ?? "",
    active: code?.active ?? true,
  }))
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
    const percent = parseAmount(form.percent)
    const amount = parseAmount(form.amount)
    const maxUses = form.maxUses.trim() ? Number(form.maxUses) : null
    if (form.kind === "percent" && (percent === null || percent <= 0 || percent > 10_000)) {
      toast.error("Escribe un porcentaje entre 0,01 y 100")
      return
    }
    if (form.kind === "amount" && (amount === null || amount <= 0)) {
      toast.error("Escribe el monto del descuento")
      return
    }
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) {
      toast.error("Los usos máximos son un número entero, o vacío para no limitarlos")
      return
    }
    const body = {
      code: form.code.trim(),
      kind: form.kind,
      ...(form.kind === "percent"
        ? { rateBp: percent ?? 0 }
        : { amountMinor: amount ?? 0, currency: form.currency }),
      maxUses,
      validFrom: form.validFrom || null,
      validUntil: form.validUntil || null,
      note: form.note.trim() || null,
    }
    setBusy(true)
    try {
      if (code) {
        await api(`/api/discount-codes/${code.id}`, {
          method: "PATCH",
          body: { ...body, active: form.active },
        })
      } else {
        await api("/api/discount-codes", { body })
      }
      await refresh()
      toast.success(code ? "Código guardado" : `Código ${body.code.toUpperCase()} creado`)
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{code ? `Editar ${code.code}` : "Nuevo código"}</DialogTitle>
          <DialogDescription>Las ventas que ya lo usaron no cambian.</DialogDescription>
        </DialogHeader>
        <form id="code-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Código" htmlFor="dc-code" hint="Letras y números">
              <Input
                id="dc-code"
                value={form.code}
                onChange={set("code")}
                placeholder="PROMO10"
                className="uppercase"
                required
                autoFocus
                maxLength={30}
              />
            </Field>
            <Field label="Descuento" htmlFor="dc-kind">
              <NativeSelect id="dc-kind" value={form.kind} onChange={set("kind")}>
                <option value="percent">Porcentaje</option>
                <option value="amount">Monto fijo</option>
              </NativeSelect>
            </Field>
          </div>
          {form.kind === "percent" ? (
            <Field label="Porcentaje" htmlFor="dc-percent">
              <Input
                id="dc-percent"
                inputMode="decimal"
                value={form.percent}
                onChange={set("percent")}
                placeholder="10"
                className="tabular"
              />
            </Field>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Monto" htmlFor="dc-amount">
                <Input
                  id="dc-amount"
                  inputMode="decimal"
                  value={form.amount}
                  onChange={set("amount")}
                  placeholder="2,00"
                  className="tabular"
                />
              </Field>
              <Field label="Moneda" htmlFor="dc-currency">
                <NativeSelect id="dc-currency" value={form.currency} onChange={set("currency")}>
                  <option value={reference}>{reference}</option>
                  <option value={legal}>{legal === "VES" ? "Bs" : legal}</option>
                </NativeSelect>
              </Field>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Desde (opcional)" htmlFor="dc-from">
              <Input id="dc-from" type="date" value={form.validFrom} onChange={set("validFrom")} />
            </Field>
            <Field label="Hasta (opcional)" htmlFor="dc-until">
              <Input
                id="dc-until"
                type="date"
                value={form.validUntil}
                onChange={set("validUntil")}
              />
            </Field>
          </div>
          <Field label="Usos máximos" htmlFor="dc-uses" hint="Vacío: sin límite">
            <Input
              id="dc-uses"
              inputMode="numeric"
              value={form.maxUses}
              onChange={set("maxUses")}
              className="tabular sm:w-32"
            />
          </Field>
          <Field label="Nota (opcional)" htmlFor="dc-note">
            <Input
              id="dc-note"
              value={form.note}
              onChange={set("note")}
              placeholder="Promoción de aniversario"
              maxLength={200}
            />
          </Field>
          {code ? (
            <div className="flex items-center gap-3">
              <input
                id="dc-active"
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={form.active}
                onChange={set("active")}
              />
              <Label htmlFor="dc-active">Activo (se puede usar en la caja)</Label>
            </div>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form="code-form" disabled={busy || !form.code.trim()}>
            {busy ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
