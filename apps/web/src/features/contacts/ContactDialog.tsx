import type { Contact } from "@millhiore/contracts"
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
  Label,
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { ApiError, api, errorMessage } from "../../lib/api"
import { currencySymbol, parseAmount, toInputAmount } from "../../lib/format"
import { bootstrapQuery, queryClient } from "../../lib/queries"

type Kind = Contact["kind"]

/** Crear (contact = null) o editar un cliente/proveedor. */
export function ContactDialog({
  contact,
  defaultKind = "customer",
  initialName = "",
  onClose,
  onSaved,
}: {
  contact: Contact | null
  defaultKind?: Kind
  initialName?: string
  onClose: () => void
  onSaved?: (c: Contact) => void
}) {
  const boot = useQuery(bootstrapQuery)
  const reference = boot.data?.business.referenceCurrency ?? "USD"
  const [form, setForm] = useState({
    kind: contact?.kind ?? defaultKind,
    name: contact?.name ?? initialName,
    taxId: contact?.taxId ?? "",
    phone: contact?.phone ?? "",
    email: contact?.email ?? "",
    address: contact?.address ?? "",
    notes: contact?.notes ?? "",
    creditDays: String(contact?.creditDays ?? 0),
    creditLimit: contact?.creditLimitMinor != null ? toInputAmount(contact.creditLimitMinor) : "",
    active: contact?.active ?? true,
  })
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
    setBusy(true)
    setErrors({})
    const days = Number(form.creditDays || 0)
    const limit = form.creditLimit.trim() ? parseAmount(form.creditLimit) : null
    if (!Number.isInteger(days) || days < 0 || days > 365) {
      setErrors({ creditDays: "Entre 0 y 365 días" })
      setBusy(false)
      return
    }
    if (form.creditLimit.trim() && limit === null) {
      setErrors({ creditLimitMinor: "Escribe un monto válido" })
      setBusy(false)
      return
    }
    const body = {
      kind: form.kind,
      name: form.name.trim(),
      taxId: form.taxId.trim() || null,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      address: form.address.trim() || null,
      notes: form.notes.trim() || null,
      creditDays: days,
      creditLimitMinor: limit,
    }
    try {
      const saved = contact
        ? await api<Contact>(`/api/contacts/${contact.id}`, {
            method: "PATCH",
            body: { ...body, active: form.active },
          })
        : await api<Contact>("/api/contacts", { body })
      await queryClient.invalidateQueries({ queryKey: ["contacts"] })
      toast.success(contact ? "Contacto guardado" : `${saved.name} registrado`)
      onSaved?.(saved)
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
          <DialogTitle>{contact ? "Editar contacto" : "Nuevo contacto"}</DialogTitle>
          <DialogDescription>
            La cédula o el RIF aparecen en el recibo y en la factura.
          </DialogDescription>
        </DialogHeader>
        <form id="contact-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <Field label="Nombre o razón social" htmlFor="c-name" error={errors.name}>
              <Input id="c-name" value={form.name} onChange={set("name")} required autoFocus />
            </Field>
            <Field label="Es" htmlFor="c-kind">
              <NativeSelect id="c-kind" value={form.kind} onChange={set("kind")}>
                <option value="customer">Cliente</option>
                <option value="supplier">Proveedor</option>
                <option value="both">Ambos</option>
              </NativeSelect>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Cédula o RIF"
              htmlFor="c-taxid"
              hint="V-12345678 · J-12345678-9"
              error={errors.taxId}
            >
              <Input
                id="c-taxid"
                value={form.taxId}
                onChange={set("taxId")}
                autoCapitalize="characters"
              />
            </Field>
            <Field label="Teléfono" htmlFor="c-phone">
              <Input id="c-phone" type="tel" value={form.phone} onChange={set("phone")} />
            </Field>
          </div>
          <Field label="Correo" htmlFor="c-email" error={errors.email}>
            <Input id="c-email" type="email" value={form.email} onChange={set("email")} />
          </Field>
          <Field label="Dirección" htmlFor="c-address">
            <Input id="c-address" value={form.address} onChange={set("address")} />
          </Field>
          <Field label="Notas" htmlFor="c-notes">
            <Input id="c-notes" value={form.notes} onChange={set("notes")} />
          </Field>
          {form.kind === "supplier" ? (
            <fieldset className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border p-3">
              <legend className="px-1 text-muted-foreground text-sm">Crédito del proveedor</legend>
              <Field
                label="Días que te da para pagar"
                htmlFor="c-days"
                hint="Se usan para la fecha límite de lo que le dejes a deber. 0 = sin plazo"
                error={errors.creditDays}
              >
                <Input
                  id="c-days"
                  inputMode="numeric"
                  value={form.creditDays}
                  onChange={set("creditDays")}
                />
              </Field>
            </fieldset>
          ) : null}
          {form.kind !== "supplier" ? (
            <fieldset className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border p-3 sm:grid-cols-2">
              <legend className="px-1 text-muted-foreground text-sm">Crédito (fiado)</legend>
              <Field
                label="Días para pagar"
                htmlFor="c-days"
                hint="0 = sin plazo"
                error={errors.creditDays}
              >
                <Input
                  id="c-days"
                  inputMode="numeric"
                  value={form.creditDays}
                  onChange={set("creditDays")}
                />
              </Field>
              <Field
                label={`Límite de deuda (${currencySymbol(reference)})`}
                htmlFor="c-limit"
                hint="Vacío = sin límite"
                error={errors.creditLimitMinor}
              >
                <Input
                  id="c-limit"
                  inputMode="decimal"
                  value={form.creditLimit}
                  onChange={set("creditLimit")}
                />
              </Field>
            </fieldset>
          ) : null}
          {contact ? (
            <div className="flex items-center gap-3">
              <input
                id="c-active"
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={form.active}
                onChange={set("active")}
              />
              <Label htmlFor="c-active">Activo</Label>
            </div>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="contact-form" disabled={busy}>
            {busy ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
