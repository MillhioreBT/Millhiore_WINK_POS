import type { Account, DocumentSummary } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeftRightIcon, PencilIcon, PlusIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatDateTime, formatMoney } from "../../lib/format"
import {
  accountsQuery,
  bootstrapQuery,
  documentsQuery,
  queryClient,
  rateStatusQuery,
  transfersQuery,
} from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { ReceiptDialog } from "../sales/ReceiptDialog"
import { DocumentDialog } from "../sales/SalesPage"
import { AccountDialog, KIND_LABEL } from "./AccountDialog"
import { PaymentMethodsCard } from "./PaymentMethodsCard"
import { TransferDialog } from "./TransferDialog"

/** Dónde está el dinero del negocio: efectivo, bancos, pago móvil y billeteras, con lo que hay en cada una. */
export function AccountsPage() {
  const me = useMe()
  const boot = useQuery(bootstrapQuery)
  const rate = useQuery(rateStatusQuery)
  const accounts = useQuery(accountsQuery({ all: true }))
  // Las transferencias de los últimos 60 días; la fecha se fija una vez para no repetir la consulta.
  const [since] = useState(() => Date.now() - 60 * 86_400_000)
  const transfers = useQuery(transfersQuery({ from: since }))
  const summaries = useQuery(documentsQuery({ type: "TRANSFER", from: since }))
  const canManage = can(me, "finance.manage")
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<Account | null>(null)
  const [transferFrom, setTransferFrom] = useState<string | null>(null)
  const [receiptId, setReceiptId] = useState<string | null>(null)
  const [open, setOpen] = useState<DocumentSummary | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const legal = boot.data?.business.legalCurrency
  const factor = rate.data?.current && Number(rate.data.current.value)
  const reference = boot.data?.business.referenceCurrency
  const list = accounts.data ?? []
  const active = list.filter((a) => a.active)
  const inactive = list.filter((a) => !a.active)

  const toggle = async (a: Account) => {
    setBusyId(a.id)
    try {
      await api(`/api/accounts/${a.id}`, { method: "PATCH", body: { active: !a.active } })
      await Promise.all(
        ["accounts", "bootstrap"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
      )
      toast.success(a.active ? `«${a.name}» desactivada` : `«${a.name}» activada`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusyId(null)
    }
  }

  const card = (a: Account) => {
    const approx =
      factor && legal && reference && a.currency === reference && a.balanceMinor !== 0
        ? Math.round(a.balanceMinor * factor)
        : null
    return (
      <Card key={a.id} className={a.active ? "" : "opacity-70"}>
        <CardHeader className="p-4 pb-1">
          <CardDescription className="flex items-center gap-2">
            <span className="min-w-0 truncate font-medium text-foreground">{a.name}</span>
            <Badge variant="outline">{a.currency}</Badge>
            {a.active ? null : <Badge variant="secondary">Desactivada</Badge>}
          </CardDescription>
          <div
            className={`tabular font-semibold text-2xl ${a.balanceMinor < 0 ? "text-destructive" : ""}`}
          >
            {formatMoney(a.balanceMinor, a.currency)}
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-2 p-4 pt-0 text-muted-foreground text-sm">
          <span>
            {KIND_LABEL[a.kind]}
            {approx !== null && legal ? (
              <span className="tabular ml-2">≈ {formatMoney(approx, legal)}</span>
            ) : null}
          </span>
          {a.kind === "cash" ? (
            <span className="text-xs">Lo que debería haber en la gaveta según el sistema.</span>
          ) : null}
          {canManage ? (
            <div className="flex flex-wrap gap-1">
              {a.active ? (
                <Button size="sm" variant="outline" onClick={() => setTransferFrom(a.id)}>
                  <ArrowLeftRightIcon /> Transferir
                </Button>
              ) : null}
              {a.kind === "cash" ? null : (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Renombrar ${a.name}`}
                    title="Renombrar"
                    onClick={() => setRenaming(a)}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === a.id}
                    aria-label={`${a.active ? "Desactivar" : "Activar"} ${a.name}`}
                    onClick={() => toggle(a)}
                  >
                    {a.active ? "Desactivar" : "Activar"}
                  </Button>
                </>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-xl">Cuentas</h1>
        {canManage ? (
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => setCreating(true)}>
              <PlusIcon /> Nueva cuenta
            </Button>
            <Button onClick={() => setTransferFrom("")}>
              <ArrowLeftRightIcon /> Transferir
            </Button>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {accounts.isLoading ? (
          <Card className="sm:col-span-2 lg:col-span-3">
            <CardHeader>
              <CardDescription>Cargando…</CardDescription>
            </CardHeader>
          </Card>
        ) : null}
        {active.map(card)}
        {inactive.map(card)}
      </div>

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardDescription>Transferencias recientes</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              {transfers.data?.length ? null : (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                    {transfers.isLoading
                      ? "Cargando…"
                      : "Cuando muevas dinero entre cuentas aparecerá aquí."}
                  </TableCell>
                </TableRow>
              )}
              {transfers.data?.map((t) => {
                const summary = summaries.data?.find((d) => d.id === t.id)
                return (
                  <TableRow key={t.id}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {summary ? (
                        <button
                          type="button"
                          className="cursor-pointer text-primary underline-offset-4 hover:underline"
                          onClick={() => setOpen(summary)}
                        >
                          {t.number}
                        </button>
                      ) : (
                        t.number
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {t.fromAccountName} → {t.toAccountName}
                      <span className="block text-muted-foreground text-xs">
                        {formatDateTime(t.postedAt)}
                        {t.reference ? ` · Ref. ${t.reference}` : ""}
                        {t.note ? ` · ${t.note}` : ""}
                      </span>
                    </TableCell>
                    <TableCell className="tabular whitespace-nowrap text-right">
                      {formatMoney(t.fromAmountMinor, t.fromCurrency)}
                      {t.toCurrency !== t.fromCurrency ? (
                        <span className="block text-muted-foreground text-xs">
                          → {formatMoney(t.toAmountMinor, t.toCurrency)}
                        </span>
                      ) : null}
                      {t.reversedBy ? (
                        <Badge variant="destructive" className="mt-1">
                          Anulada
                        </Badge>
                      ) : t.reversesDocumentId ? (
                        <Badge variant="outline" className="mt-1">
                          Reverso
                        </Badge>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <PaymentMethodsCard canManage={canManage} />

      {creating ? <AccountDialog onClose={() => setCreating(false)} /> : null}
      {renaming ? <AccountDialog account={renaming} onClose={() => setRenaming(null)} /> : null}
      {transferFrom !== null ? (
        <TransferDialog
          {...(transferFrom ? { initialFrom: transferFrom } : {})}
          onClose={() => setTransferFrom(null)}
          onPosted={(id) => {
            setTransferFrom(null)
            setReceiptId(id)
          }}
        />
      ) : null}
      {open ? <DocumentDialog doc={open} onClose={() => setOpen(null)} /> : null}
      <ReceiptDialog documentId={receiptId} onClose={() => setReceiptId(null)} done="Listo" />
    </div>
  )
}
