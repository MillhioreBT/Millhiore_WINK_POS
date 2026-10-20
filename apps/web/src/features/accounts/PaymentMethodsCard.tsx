import type { PaymentMethodRow } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { PencilIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatPercent, parseAmount, toInputAmount } from "../../lib/format"
import { paymentMethodsQuery, queryClient } from "../../lib/queries"

const refresh = () =>
  Promise.all(
    ["payment-methods", "accounts", "bootstrap"].map((k) =>
      queryClient.invalidateQueries({ queryKey: [k] }),
    ),
  )

/** Cambia la comisión de un método de pago y si pide referencia o se ofrece al cobrar. */
function PaymentMethodDialog({
  method,
  onClose,
}: {
  method: PaymentMethodRow
  onClose: () => void
}) {
  // Un porcentaje con dos decimales son justo los puntos básicos: «2,5» → 250.
  const [percent, setPercent] = useState(toInputAmount(method.commissionBp))
  const [needsReference, setNeedsReference] = useState(method.requiresReference)
  const [active, setActive] = useState(method.active)
  const [busy, setBusy] = useState(false)
  const bp = parseAmount(percent)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (bp === null || bp > 10_000) {
      toast.error("Escribe un porcentaje entre 0 y 100")
      return
    }
    setBusy(true)
    try {
      await api(`/api/payment-methods/${method.id}`, {
        method: "PATCH",
        body: { commissionBp: bp, requiresReference: needsReference, active },
      })
      await refresh()
      toast.success(`«${method.name}» guardado`)
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
          <DialogTitle>{method.name}</DialogTitle>
          <DialogDescription>
            Cae en la cuenta «{method.accountName}» ({method.currency}).
          </DialogDescription>
        </DialogHeader>
        <form id="method-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <Field
            label="Comisión (%)"
            htmlFor="pm-commission"
            hint="Lo que el banco o el punto de venta descuenta de cada cobro. Déjala en 0 si no descuenta nada."
          >
            <Input
              id="pm-commission"
              inputMode="decimal"
              autoFocus
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              className="tabular"
              placeholder="0,00"
            />
          </Field>
          {bp ? (
            <p className="-mt-2 rounded-md bg-muted px-3 py-2 text-sm">
              Cada venta o abono cobrado con este método registra la comisión: la cuenta recibe el
              cobro menos {formatPercent(bp)}. Lo ya cobrado no cambia.
            </p>
          ) : null}
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--primary)]"
              checked={needsReference}
              onChange={(e) => setNeedsReference(e.target.checked)}
            />
            <span>Pedir la referencia del pago al cobrar</span>
          </label>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--primary)]"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            <span>Ofrecerlo al cobrar y al pagar</span>
          </label>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form="method-form" variant="success" disabled={busy}>
            {busy ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Con qué se cobra y se paga, a qué cuenta cae y cuánto descuenta el banco o el punto de venta. */
export function PaymentMethodsCard({ canManage }: { canManage: boolean }) {
  const methods = useQuery(paymentMethodsQuery)
  const [editing, setEditing] = useState<PaymentMethodRow | null>(null)
  const list = [...(methods.data ?? [])].sort((a, b) => Number(b.active) - Number(a.active))
  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardDescription>
          Métodos de pago · la comisión es lo que el banco o el punto de venta te descuenta
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableBody>
            {list.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                  {methods.isLoading ? "Cargando…" : "No hay métodos de pago."}
                </TableCell>
              </TableRow>
            ) : null}
            {list.map((m) => (
              <TableRow key={m.id} className={m.active ? "" : "opacity-60"}>
                <TableCell className="whitespace-normal font-medium">
                  {m.name}
                  {m.active ? null : (
                    <Badge variant="secondary" className="ml-2">
                      No se ofrece
                    </Badge>
                  )}
                  <span className="block font-normal text-muted-foreground text-xs">
                    Cae en {m.accountName} ({m.currency})
                    {m.surchargeName ? ` · lleva ${m.surchargeName}` : ""}
                  </span>
                </TableCell>
                <TableCell className="tabular whitespace-nowrap text-right">
                  {m.commissionBp ? (
                    <>
                      <span className="font-medium">{formatPercent(m.commissionBp)}</span>
                      <span className="block text-muted-foreground text-xs">comisión</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground text-xs">Sin comisión</span>
                  )}
                </TableCell>
                <TableCell className="w-0">
                  {canManage ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Editar ${m.name}`}
                      title="Editar"
                      onClick={() => setEditing(m)}
                    >
                      <PencilIcon />
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      {editing ? <PaymentMethodDialog method={editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  )
}
