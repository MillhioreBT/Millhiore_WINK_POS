import type { Account } from "@millhiore/contracts"
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
import { bootstrapQuery, queryClient } from "../../lib/queries"

export const KIND_LABEL: Record<Account["kind"], string> = {
  cash: "Efectivo",
  bank: "Banco",
  mobile: "Pago móvil",
  wallet: "Billetera (Zelle, Binance…)",
}

const refresh = () =>
  Promise.all(
    ["accounts", "payment-methods", "bootstrap", "reports"].map((k) =>
      queryClient.invalidateQueries({ queryKey: [k] }),
    ),
  )

/** Crea una cuenta nueva (con su método de pago) o le cambia el nombre a una existente. */
export function AccountDialog({
  account,
  onClose,
}: {
  /** La cuenta que se renombra; sin ella se crea una nueva. */
  account?: Account
  onClose: () => void
}) {
  const boot = useQuery(bootstrapQuery)
  const [name, setName] = useState(account?.name ?? "")
  const [kind, setKind] = useState<"bank" | "mobile" | "wallet">("bank")
  const [currency, setCurrency] = useState("")
  const [busy, setBusy] = useState(false)

  const currencies = [
    boot.data?.business.legalCurrency,
    boot.data?.business.referenceCurrency,
  ].filter((c, i, all): c is string => !!c && all.indexOf(c) === i)
  const chosen = currency || currencies[0] || ""

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      toast.error("Escribe el nombre de la cuenta")
      return
    }
    setBusy(true)
    try {
      if (account) {
        await api(`/api/accounts/${account.id}`, { method: "PATCH", body: { name: name.trim() } })
        toast.success("Cuenta renombrada")
      } else {
        await api("/api/accounts", { body: { name: name.trim(), kind, currency: chosen } })
        toast.success(`Cuenta «${name.trim()}» creada: ya puedes cobrar y pagar con ella`)
      }
      await refresh()
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
          <DialogTitle>{account ? `Renombrar «${account.name}»` : "Nueva cuenta"}</DialogTitle>
          <DialogDescription>
            {account
              ? "El nombre cambia también en el método de pago con el que se cobra."
              : "Un banco, un pago móvil o una billetera. Se crea también el método de pago para cobrar y pagar con ella."}
          </DialogDescription>
        </DialogHeader>
        <form id="account-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <Field label="Nombre" htmlFor="acc-name">
            <Input
              id="acc-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Banesco, Zelle Mercantil…"
              maxLength={60}
            />
          </Field>
          {account ? null : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Tipo" htmlFor="acc-kind">
                <NativeSelect
                  id="acc-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as typeof kind)}
                >
                  <option value="bank">{KIND_LABEL.bank}</option>
                  <option value="mobile">{KIND_LABEL.mobile}</option>
                  <option value="wallet">{KIND_LABEL.wallet}</option>
                </NativeSelect>
              </Field>
              <Field label="Moneda" htmlFor="acc-currency">
                <NativeSelect
                  id="acc-currency"
                  value={chosen}
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
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="account-form"
            variant="success"
            disabled={busy || !name.trim() || (!account && !chosen)}
          >
            {busy ? "Guardando…" : account ? "Guardar" : "Crear cuenta"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
