import type {
  Contact,
  CreateRecurringExpenseBody,
  RecurringExpense,
  UpdateRecurringExpenseBody,
} from "@millhiore/contracts"
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
import { api, errorMessage } from "../../lib/api"
import { todayInCaracas } from "../../lib/days"
import { parseAmount, toInputAmount } from "../../lib/format"
import { bootstrapQuery, expenseCategoriesQuery, queryClient } from "../../lib/queries"
import { FREQUENCIES } from "../../lib/recurrence"
import { ContactPicker } from "../contacts/ContactPicker"

/** Crea o cambia un gasto recurrente: qué es, cuánto, cada cuánto y desde cuándo. */
export function RecurringDialog({
  editing,
  onClose,
}: {
  editing: RecurringExpense | null
  onClose: () => void
}) {
  const boot = useQuery(bootstrapQuery)
  const categories = useQuery(expenseCategoriesQuery())
  const list = categories.data ?? []
  const [note, setNote] = useState(editing?.note ?? "")
  const [categoryId, setCategoryId] = useState(editing?.categoryId ?? "")
  const [amount, setAmount] = useState(editing ? toInputAmount(editing.amountMinor) : "")
  const [currency, setCurrency] = useState(editing?.currency ?? "")
  const [frequency, setFrequency] = useState(editing?.frequency ?? "monthly")
  const [dueDay, setDueDay] = useState(editing?.nextDueDay ?? todayInCaracas())
  const [supplier, setSupplier] = useState<Contact | null>(editing?.contact ?? null)
  const [auto, setAuto] = useState(editing?.auto ?? false)
  const [busy, setBusy] = useState(false)

  const reference = boot.data?.business.referenceCurrency
  const legal = boot.data?.business.legalCurrency
  const currencies = [reference, legal].filter(
    (c, i, all): c is string => !!c && all.indexOf(c) === i,
  )
  const chosenCurrency = currency || currencies[0] || ""
  const category = categoryId || list[0]?.id || ""

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const minor = parseAmount(amount)
    if (!note.trim()) {
      toast.error("Cuéntanos en qué se gasta")
      return
    }
    if (minor === null || minor <= 0) {
      toast.error("Escribe un monto válido")
      return
    }
    if (auto && !supplier) {
      toast.error("Para registrarlo solo hace falta el proveedor: queda a deber a él")
      return
    }
    setBusy(true)
    try {
      if (editing) {
        const body: UpdateRecurringExpenseBody = {
          note: note.trim(),
          categoryId: category,
          contactId: supplier?.id ?? null,
          currency: chosenCurrency,
          amountMinor: minor,
          frequency,
          nextDueDay: dueDay,
          auto,
        }
        await api(`/api/recurring-expenses/${editing.id}`, { method: "PATCH", body })
      } else {
        const body: CreateRecurringExpenseBody = {
          note: note.trim(),
          categoryId: category,
          contactId: supplier?.id ?? null,
          currency: chosenCurrency,
          amountMinor: minor,
          frequency,
          firstDueDay: dueDay,
          auto,
        }
        await api("/api/recurring-expenses", { body })
      }
      await queryClient.invalidateQueries({ queryKey: ["recurring"] })
      toast.success(editing ? "Recurrente guardado" : "Recurrente creado")
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Cambiar gasto recurrente" : "Nuevo gasto recurrente"}
          </DialogTitle>
          <DialogDescription>
            Lo que se paga una y otra vez: alquiler, internet, sueldos. Cuando vence se te avisa
            para registrarlo, o se registra solo a deber si así lo eliges.
          </DialogDescription>
        </DialogHeader>
        <form id="recurring-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <Field label="¿En qué se gasta?" htmlFor="rec-note">
            <Input
              id="rec-note"
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Alquiler del local"
              maxLength={500}
            />
          </Field>
          <Field label="Categoría" htmlFor="rec-category">
            <NativeSelect
              id="rec-category"
              value={category}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field label="Monto" htmlFor="rec-amount">
              <Input
                id="rec-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="tabular"
                placeholder="0,00"
              />
            </Field>
            <Field label="Moneda" htmlFor="rec-currency">
              <NativeSelect
                id="rec-currency"
                value={chosenCurrency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Se repite" htmlFor="rec-frequency">
              <NativeSelect
                id="rec-frequency"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as typeof frequency)}
              >
                {FREQUENCIES.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={editing ? "Próximo vencimiento" : "Primer vencimiento"} htmlFor="rec-due">
              <Input
                id="rec-due"
                type="date"
                value={dueDay}
                onChange={(e) => e.target.value && setDueDay(e.target.value)}
              />
            </Field>
          </div>
          <Field label="A quién se le paga (opcional)" htmlFor="rec-supplier">
            <ContactPicker
              kind="supplier"
              value={supplier}
              onChange={(c) => {
                setSupplier(c)
                if (!c) setAuto(false)
              }}
              placeholder="Buscar proveedor por nombre o RIF"
            />
          </Field>
          <div className="flex items-start gap-3">
            <input
              id="rec-auto"
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--primary)]"
              checked={auto}
              disabled={!supplier}
              onChange={(e) => setAuto(e.target.checked)}
            />
            <Label htmlFor="rec-auto" className="font-normal">
              Registrarlo solo, a deber, cuando venza
              <span className="block text-muted-foreground text-xs">
                {supplier
                  ? "Aparece en «Por pagar» con los días de crédito del proveedor."
                  : "Elige primero el proveedor al que se le debe."}
              </span>
            </Label>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form="recurring-form" disabled={busy || !category}>
            {busy ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
