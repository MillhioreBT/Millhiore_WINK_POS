import type { Bootstrap, Shift } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
import {
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
  NativeSelect,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { LockKeyholeOpenIcon, PrinterIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { TerminalPicker } from "../../components/TerminalPicker"
import { api, errorMessage } from "../../lib/api"
import { parseAmount } from "../../lib/format"
import { queryClient, rateStatusQuery, shiftReportQuery } from "../../lib/queries"
import { type CashCount, CashCounter, countedPieces, countTotal, emptyCount } from "./CashCounter"
import { ShiftReportView } from "./ShiftReportView"

/** Cuentas de efectivo (las que se cuentan), desde los métodos de cobro de la caja. */
export function cashAccountsOf(boot: Bootstrap) {
  const seen = new Map<
    string,
    { accountId: string; name: string; currency: string; methodId: string }
  >()
  for (const m of boot.paymentMethods) {
    if (m.kind === "cash" && !seen.has(m.accountId)) {
      seen.set(m.accountId, {
        accountId: m.accountId,
        name: m.name,
        currency: m.currency,
        methodId: m.id,
      })
    }
  }
  return [...seen.values()]
}

function useCounts(accounts: { accountId: string }[]) {
  const [counts, setCounts] = useState<Record<string, CashCount>>(() =>
    Object.fromEntries(accounts.map((a) => [a.accountId, emptyCount()])),
  )
  const totals = accounts.map((a) => countTotal(counts[a.accountId] ?? emptyCount()))
  const valid = totals.every((t) => t !== null)
  return { counts, setCounts, totals, valid }
}

const invalidateShift = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ["shifts"] }),
    queryClient.invalidateQueries({ queryKey: ["documents"] }),
  ])

/** Pantalla de la caja cuando no hay turno: se abre contando el fondo de la gaveta. */
export function OpenShiftCard({
  boot,
  terminalId,
  canOpen,
}: {
  boot: Bootstrap
  terminalId: string
  canOpen: boolean
}) {
  const accounts = cashAccountsOf(boot)
  const { counts, setCounts, totals, valid } = useCounts(accounts)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [shiftId] = useState(uuidv7)

  const open = async () => {
    setBusy(true)
    try {
      await api<Shift>("/api/shifts", {
        body: {
          id: shiftId,
          terminalId,
          counts: accounts.map((a, i) => ({
            accountId: a.accountId,
            countedMinor: totals[i] ?? 0,
          })),
          note: note.trim() || null,
        },
      })
      toast.success("Turno abierto. ¡Buenas ventas!")
      await invalidateShift()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto grid max-w-2xl grid-cols-1 gap-4 py-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <LockKeyholeOpenIcon className="size-5" /> Abrir turno
          </CardTitle>
          <CardDescription>
            Cuenta el efectivo con el que arranca la gaveta. Si no coincide con lo que dicen los
            libros, la diferencia queda registrada.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4">
          {boot.terminals.length > 1 ? (
            <Field label="Caja de este equipo" htmlFor="open-terminal">
              <TerminalPicker boot={boot} id="open-terminal" className="w-full" />
            </Field>
          ) : null}
          {canOpen ? (
            <>
              {accounts.map((a) => (
                <CashCounter
                  key={a.accountId}
                  currency={a.currency}
                  label={a.name}
                  value={counts[a.accountId] ?? emptyCount()}
                  onChange={(next) => setCounts((c) => ({ ...c, [a.accountId]: next }))}
                />
              ))}
              <Field label="Nota" htmlFor="open-note">
                <Input
                  id="open-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Opcional"
                />
              </Field>
              <Button size="lg" onClick={open} disabled={busy || !valid}>
                {busy ? "Abriendo…" : "Abrir turno"}
              </Button>
            </>
          ) : (
            <p className="text-muted-foreground">
              No tienes permiso para abrir el turno. Pídele a quien maneja la caja que lo abra.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/** Ingreso o retiro de efectivo durante el turno (fondo extra, pago a un proveedor, depósito…). */
export function CashMoveDialog({
  boot,
  terminalId,
  onClose,
}: {
  boot: Bootstrap
  terminalId: string
  onClose: () => void
}) {
  const accounts = cashAccountsOf(boot)
  const rate = useQuery(rateStatusQuery)
  const [direction, setDirection] = useState<"CASH_OUT" | "CASH_IN">("CASH_OUT")
  const [accountId, setAccountId] = useState(accounts[0]?.accountId ?? "")
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const account = accounts.find((a) => a.accountId === accountId)
  const current = rate.data?.current

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const minor = parseAmount(amount)
    if (!account || minor === null || minor <= 0) {
      toast.error("Escribe un monto válido")
      return
    }
    if (!note.trim()) {
      toast.error("Indica el motivo")
      return
    }
    setBusy(true)
    try {
      await api("/api/documents", {
        body: {
          id: uuidv7(),
          type: direction,
          terminalId,
          currency: account.currency,
          rate:
            account.currency === boot.business.legalCurrency || !current
              ? null
              : { base: current.base, quote: current.quote, value: current.value },
          payments: [
            {
              id: uuidv7(),
              paymentMethodId: account.methodId,
              currency: account.currency,
              amountMinor: minor,
            },
          ],
          note: note.trim(),
        },
      })
      toast.success(direction === "CASH_IN" ? "Ingreso registrado" : "Retiro registrado")
      await invalidateShift()
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Ingreso o retiro de caja</DialogTitle>
          <DialogDescription>
            Para el dinero que entra o sale de la gaveta sin ser una venta: pagar el hielo, sacar
            para depositar, agregar sencillo.
          </DialogDescription>
        </DialogHeader>
        <form id="cash-move" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant={direction === "CASH_OUT" ? "default" : "outline"}
              onClick={() => setDirection("CASH_OUT")}
            >
              Retiro (sale)
            </Button>
            <Button
              variant={direction === "CASH_IN" ? "default" : "outline"}
              onClick={() => setDirection("CASH_IN")}
            >
              Ingreso (entra)
            </Button>
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field label="Monto" htmlFor="move-amount">
              <Input
                id="move-amount"
                inputMode="decimal"
                autoFocus
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="tabular"
              />
            </Field>
            <Field label="Cuenta" htmlFor="move-account">
              <NativeSelect
                id="move-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field label="Motivo" htmlFor="move-note">
            <Input
              id="move-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Pago del hielo, depósito al banco…"
              required
            />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="cash-move" disabled={busy}>
            {busy ? "Guardando…" : "Registrar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Cierre ciego: quien cierra cuenta la gaveta sin ver cuánto debería haber; el sistema compara
 * después y muestra el cierre con sobrantes y faltantes.
 */
export function CloseShiftDialog({
  boot,
  shift,
  onClose,
}: {
  boot: Bootstrap
  shift: Shift
  onClose: () => void
}) {
  const accounts = shift.accounts.map((a) => ({
    accountId: a.accountId,
    name: a.accountName,
    currency: a.currency,
  }))
  const { counts, setCounts, totals, valid } = useCounts(accounts)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [closedId, setClosedId] = useState<string | null>(null)
  const report = useQuery({ ...shiftReportQuery(closedId ?? ""), enabled: closedId !== null })

  const close = async () => {
    setBusy(true)
    try {
      await api<Shift>(`/api/shifts/${shift.id}/close`, {
        body: {
          counts: accounts.map((a, i) => ({
            accountId: a.accountId,
            countedMinor: totals[i] ?? 0,
            denominations: countedPieces(counts[a.accountId] ?? emptyCount()),
          })),
          note: note.trim() || null,
        },
      })
      setClosedId(shift.id)
      toast.success("Turno cerrado")
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const finish = async () => {
    await invalidateShift()
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && (closedId ? void finish() : onClose())}>
      <DialogContent className="max-w-2xl">
        {closedId ? (
          <>
            <DialogTitle>Cierre de caja</DialogTitle>
            <DialogDescription className="sr-only">Resumen del turno cerrado</DialogDescription>
            {report.data ? (
              <div className="rounded-lg border bg-white p-4 text-black">
                <ShiftReportView report={report.data} business={boot.business} />
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Cargando el cierre…</p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => window.print()} disabled={!report.data}>
                <PrinterIcon /> Imprimir
              </Button>
              <Button onClick={finish}>Listo</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Cerrar turno</DialogTitle>
              <DialogDescription>
                Cuenta el efectivo de la gaveta por billete. Al cerrar verás si hubo sobrante o
                faltante; la diferencia queda registrada.
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-1 gap-3">
              {accounts.map((a) => (
                <CashCounter
                  key={a.accountId}
                  currency={a.currency}
                  label={a.name}
                  value={counts[a.accountId] ?? emptyCount()}
                  onChange={(next) => setCounts((c) => ({ ...c, [a.accountId]: next }))}
                />
              ))}
              <Field label="Nota" htmlFor="close-note">
                <Input
                  id="close-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Opcional"
                />
              </Field>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancelar
              </Button>
              <Button variant="destructive" onClick={close} disabled={busy || !valid}>
                {busy ? "Cerrando…" : "Cerrar turno"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
