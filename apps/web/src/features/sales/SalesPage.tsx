import type { DocumentSummary } from "@millhiore/contracts"
import { uuidv7 } from "@millhiore/domain"
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
  DialogTitle,
  Field,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { BanIcon, PrinterIcon, Undo2Icon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { dayRange, todayInCaracas } from "../../lib/days"
import { formatDay, formatMoney, formatTime } from "../../lib/format"
import { usePrintDocument } from "../../lib/printing"
import { bootstrapQuery, documentQuery, documentsQuery, queryClient } from "../../lib/queries"
import { can, useMe } from "../../lib/session"
import { ShiftsList } from "../shifts/ShiftsList"
import { Receipt, ReceiptDialog } from "./ReceiptDialog"
import { ReturnDialog } from "./ReturnDialog"

const DOC_LABEL: Record<string, string> = {
  SALE: "Venta",
  PAYMENT_IN: "Abono",
  RETURN: "Devolución",
  EXPENSE: "Gasto",
  PAYMENT_OUT: "Pago a proveedor",
  TRANSFER: "Transferencia",
  PURCHASE: "Compra",
  CASH_IN: "Ingreso de caja",
  CASH_OUT: "Retiro de caja",
  ADJUSTMENT: "Ajuste de inventario",
  DEBT_IN: "Deuda de cliente",
  DEBT_OUT: "Deuda con proveedor",
  STOCK_TRANSFER: "Traslado",
  PURCHASE_RETURN: "Devolución a proveedor",
}

const VOID_PERMISSION: Record<string, string> = {
  SALE: "sale.void",
  PAYMENT_IN: "sale.void",
  RETURN: "sale.void",
  EXPENSE: "finance.manage",
  PAYMENT_OUT: "payable.manage",
  TRANSFER: "finance.manage",
  PURCHASE: "purchase.void",
  CASH_IN: "finance.manage",
  CASH_OUT: "finance.manage",
  ADJUSTMENT: "inventory.adjust",
  DEBT_IN: "finance.manage",
  DEBT_OUT: "payable.manage",
  STOCK_TRANSFER: "inventory.adjust",
  PURCHASE_RETURN: "purchase.void",
}

/** Detalle imprimible de un documento, con anulación si se tiene el permiso. */
export function DocumentDialog({ doc, onClose }: { doc: DocumentSummary; onClose: () => void }) {
  const me = useMe()
  const { data: boot } = useQuery(bootstrapQuery)
  const detail = useQuery(documentQuery(doc.id))
  const { print, printing } = usePrintDocument()
  const [confirming, setConfirming] = useState(false)
  const [returning, setReturning] = useState(false)
  const [receiptId, setReceiptId] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const label = DOC_LABEL[doc.type] ?? "Documento"
  // Se devuelve parte de una venta (o, al proveedor, de una compra) vigente; una anulada, un
  // reverso o un abono no.
  const canReturn =
    ((doc.type === "SALE" && can(me, "sale.void")) ||
      (doc.type === "PURCHASE" && can(me, "purchase.void"))) &&
    !doc.reversesDocumentId &&
    !doc.reversedBy
  const canVoid =
    can(me, VOID_PERMISSION[doc.type] ?? "-") && !doc.reversesDocumentId && !doc.reversedBy

  const voidSale = async () => {
    setBusy(true)
    try {
      await api(`/api/documents/${doc.id}/void`, {
        body: { reversalId: uuidv7(), reason: reason.trim() || null },
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["documents"] }),
        queryClient.invalidateQueries({ queryKey: ["document", doc.id] }),
        queryClient.invalidateQueries({ queryKey: ["products"] }),
        queryClient.invalidateQueries({ queryKey: ["receivables"] }),
        queryClient.invalidateQueries({ queryKey: ["reports"] }),
        queryClient.invalidateQueries({ queryKey: ["expenses"] }),
        queryClient.invalidateQueries({ queryKey: ["payables"] }),
        queryClient.invalidateQueries({ queryKey: ["expense-categories"] }),
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["stock-adjustments"] }),
        queryClient.invalidateQueries({ queryKey: ["stock-reasons"] }),
        queryClient.invalidateQueries({ queryKey: ["transfers"] }),
        queryClient.invalidateQueries({ queryKey: ["lots"] }),
      ])
      toast.success(`${label} ${doc.number} ${doc.type === "EXPENSE" ? "anulado" : "anulada"}`)
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>
          {label} {doc.number}
        </DialogTitle>
        <DialogDescription className="sr-only">Detalle del documento</DialogDescription>
        {detail.data ? (
          <div className="rounded-lg border bg-white p-4 text-black">
            <Receipt doc={detail.data} business={boot?.business} />
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Cargando…</p>
        )}
        {confirming ? (
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-destructive/40 p-3">
            <Field label="Motivo de la anulación" htmlFor="void-reason">
              <Input
                id="void-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                autoFocus
                placeholder="Error de cobro, devolución…"
              />
            </Field>
            <p className="text-muted-foreground text-xs">
              {doc.type === "TRANSFER"
                ? "Se registra un documento de reverso: el dinero vuelve a la cuenta de origen y sale de la de destino. El documento original no se borra."
                : doc.type === "EXPENSE" || doc.type === "PAYMENT_OUT"
                  ? "Se registra un documento de reverso: el dinero vuelve a la cuenta con la que se pagó y, si era un pago, la deuda vuelve a quedar pendiente. El documento original no se borra."
                  : "Se registra un documento de reverso: el dinero sale de las cuentas y la mercancía vuelve (o sale) del inventario. El documento original no se borra."}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                No anular
              </Button>
              <Button variant="destructive" onClick={voidSale} disabled={busy}>
                {busy ? "Anulando…" : `Anular ${label.toLowerCase()}`}
              </Button>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          {canReturn && !confirming ? (
            <Button variant="outline" onClick={() => setReturning(true)}>
              <Undo2Icon /> {doc.type === "PURCHASE" ? "Devolver al proveedor" : "Devolver"}
            </Button>
          ) : null}
          {canVoid && !confirming ? (
            <Button
              variant="outline"
              className="text-destructive"
              onClick={() => setConfirming(true)}
            >
              <BanIcon /> Anular
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={() => print(doc.id)}
            disabled={!detail.data || printing}
          >
            <PrinterIcon /> {printing ? "Imprimiendo…" : "Imprimir"}
          </Button>
          <Button onClick={onClose}>Cerrar</Button>
        </DialogFooter>
      </DialogContent>
      {returning ? (
        <ReturnDialog
          documentId={doc.id}
          onClose={() => setReturning(false)}
          onPosted={(id) => {
            setReturning(false)
            setReceiptId(id)
          }}
        />
      ) : null}
      <ReceiptDialog
        documentId={receiptId}
        done="Listo"
        onClose={() => {
          setReceiptId(null)
          onClose()
        }}
      />
    </Dialog>
  )
}

function DaySales() {
  const [day, setDay] = useState(todayInCaracas)
  const range = dayRange(day)
  const docs = useQuery(documentsQuery({ type: "SALE,PAYMENT_IN,RETURN", ...range }))
  const [open, setOpen] = useState<DocumentSummary | null>(null)

  // Los abonos y las devoluciones salen en la lista; las devoluciones restan de lo vendido.
  const list = docs.data ?? []
  const sales = list.filter((d) => d.type === "SALE")
  const returned = list.filter((d) => d.type === "RETURN").reduce((acc, d) => acc + d.totalMinor, 0)
  const cur = sales[0]?.currency ?? "VES"
  const originals = sales.filter((d) => !d.reversesDocumentId)
  const net = sales.reduce((acc, d) => acc + d.totalMinor, 0) - returned
  const igtf = sales.reduce((acc, d) => acc + d.surchargeMinor, 0)
  const voided = originals.filter((d) => d.reversedBy).length

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-block font-medium first-letter:uppercase">
          {formatDay(range.from + 12 * 3_600_000)}
        </span>
        <Input
          type="date"
          value={day}
          max={todayInCaracas()}
          onChange={(e) => e.target.value && setDay(e.target.value)}
          className="w-44 sm:ml-auto"
          aria-label="Día"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Vendido (neto de anulaciones y devoluciones)</CardDescription>
            <CardTitle className="tabular text-2xl">{formatMoney(net, cur)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Ventas</CardDescription>
            <CardTitle className="text-2xl">
              {originals.length - voided}
              {voided ? (
                <span className="ml-2 font-normal text-muted-foreground text-sm">
                  ({voided} {voided === 1 ? "anulada" : "anuladas"})
                </span>
              ) : null}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>IGTF percibido</CardDescription>
            <CardTitle className="tabular text-2xl">{formatMoney(igtf, cur)}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Número</TableHead>
                <TableHead className="hidden sm:table-cell">Hora</TableHead>
                <TableHead className="hidden md:table-cell">Cajero</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="hidden text-right sm:table-cell">IGTF</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    {docs.isLoading ? "Cargando…" : "No hubo ventas este día."}
                  </TableCell>
                </TableRow>
              ) : null}
              {list.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">
                    <button
                      type="button"
                      className="cursor-pointer text-primary underline-offset-4 hover:underline"
                      onClick={() => setOpen(d)}
                    >
                      {d.number}
                    </button>
                    <span className="block font-normal text-muted-foreground text-xs sm:hidden">
                      {formatTime(d.postedAt)}
                    </span>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{formatTime(d.postedAt)}</TableCell>
                  <TableCell className="hidden md:table-cell">{d.createdBy ?? "—"}</TableCell>
                  <TableCell className="tabular text-right">
                    {formatMoney(d.totalMinor, d.currency)}
                  </TableCell>
                  <TableCell className="tabular hidden text-right text-muted-foreground sm:table-cell">
                    {d.surchargeMinor ? formatMoney(d.surchargeMinor, d.currency) : "—"}
                  </TableCell>
                  <TableCell>
                    {d.reversesDocumentId ? (
                      <Badge variant="outline">Reverso</Badge>
                    ) : d.reversedBy ? (
                      <Badge variant="destructive">Anulada</Badge>
                    ) : d.type === "PAYMENT_IN" ? (
                      <Badge variant="secondary">Abono</Badge>
                    ) : d.type === "RETURN" ? (
                      <Badge variant="secondary">Devolución</Badge>
                    ) : d.creditMinor > 0 ? (
                      <Badge variant="warning">A crédito</Badge>
                    ) : (
                      <Badge variant="success">Cobrada</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {open ? <DocumentDialog doc={open} onClose={() => setOpen(null)} /> : null}
    </div>
  )
}

export function SalesPage() {
  const me = useMe()
  const showShifts = can(me, "shift.manage", "finance.view")
  return (
    <div className="grid grid-cols-1 gap-4">
      <h1 className="font-semibold text-xl">Ventas</h1>
      <Tabs defaultValue="ventas">
        <TabsList>
          <TabsTrigger value="ventas">Ventas del día</TabsTrigger>
          {showShifts ? <TabsTrigger value="turnos">Turnos y cierres</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="ventas">
          <DaySales />
        </TabsContent>
        {showShifts ? (
          <TabsContent value="turnos">
            <ShiftsList />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  )
}
