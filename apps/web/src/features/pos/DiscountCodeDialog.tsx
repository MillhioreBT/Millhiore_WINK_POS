import type { DiscountCode } from "@millhiore/contracts"
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
} from "@millhiore/ui"
import { useState } from "react"
import { api, errorMessage } from "../../lib/api"
import type { DiscountSpec } from "./compute"

/** El descuento que da un código, listo para el ticket (recuerda de qué código salió). */
export function codeDiscount(code: DiscountCode): DiscountSpec {
  const ref = { id: code.id, code: code.code }
  return code.kind === "percent"
    ? { kind: "percent", bp: code.rateBp, code: ref }
    : { kind: "amount", amountMinor: code.amountMinor, currency: code.currency ?? "USD", code: ref }
}

/** El cajero escribe el código que dice el cliente; si vale, se descuenta de toda la venta. */
export function DiscountCodeDialog({
  onApply,
  onClose,
}: {
  onApply: (spec: DiscountSpec) => void
  onClose: () => void
}) {
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const code = await api<DiscountCode>(
        `/api/discount-codes/check?code=${encodeURIComponent(text.trim())}`,
      )
      onApply(codeDiscount(code))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Código de descuento</DialogTitle>
          <DialogDescription>Se descuenta de toda la venta. Uno por venta.</DialogDescription>
        </DialogHeader>
        <form id="code-apply" onSubmit={submit}>
          <Field label="Código" htmlFor="pos-code" error={error ?? undefined}>
            <Input
              id="pos-code"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="PROMO10"
              className="uppercase"
              autoFocus
              required
              maxLength={30}
            />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form="code-apply" disabled={busy || !text.trim()}>
            {busy ? "Revisando…" : "Aplicar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
