import type { DocumentSummary } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { PlusIcon } from "lucide-react"
import { useState } from "react"
import { formatDateTime, formatMoney } from "../../lib/format"
import { bootstrapQuery, documentsQuery } from "../../lib/queries"
import { DocumentDialog } from "../sales/SalesPage"
import { NewPurchaseDialog } from "./NewPurchaseDialog"

export function PurchasesPage() {
  const { data: boot } = useQuery(bootstrapQuery)
  const docs = useQuery(documentsQuery({ type: "PURCHASE" }))
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<DocumentSummary | null>(null)
  const terminalId = boot?.terminals[0]?.id

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-xl">Compras</h1>
        <Button
          className="ml-auto"
          onClick={() => setCreating(true)}
          disabled={!boot || !terminalId}
        >
          <PlusIcon /> Nueva compra
        </Button>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Número</TableHead>
              <TableHead className="hidden md:table-cell">Fecha</TableHead>
              <TableHead>Proveedor</TableHead>
              <TableHead className="hidden sm:table-cell">Factura</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Estado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(docs.data ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  {docs.isLoading ? "Cargando…" : "Aún no hay compras registradas."}
                </TableCell>
              </TableRow>
            ) : null}
            {(docs.data ?? []).map((d) => (
              <TableRow key={d.id}>
                <TableCell className="font-medium">
                  <button
                    type="button"
                    className="cursor-pointer text-primary underline-offset-4 hover:underline"
                    onClick={() => setOpen(d)}
                  >
                    {d.number}
                  </button>
                  <span className="block font-normal text-muted-foreground text-xs md:hidden">
                    {formatDateTime(d.postedAt)}
                  </span>
                </TableCell>
                <TableCell className="hidden md:table-cell">{formatDateTime(d.postedAt)}</TableCell>
                <TableCell className="whitespace-normal">
                  {d.contactName ?? "—"}
                  {d.externalRef ? (
                    <span className="block text-muted-foreground text-xs sm:hidden">
                      {d.externalRef}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="hidden sm:table-cell">{d.externalRef ?? "—"}</TableCell>
                <TableCell className="tabular text-right">
                  {formatMoney(d.totalMinor, d.currency)}
                </TableCell>
                <TableCell>
                  {d.reversesDocumentId ? (
                    <Badge variant="outline">Reverso</Badge>
                  ) : d.reversedBy ? (
                    <Badge variant="destructive">Anulada</Badge>
                  ) : (
                    <Badge variant="success">Registrada</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      {creating && boot && terminalId ? (
        <NewPurchaseDialog boot={boot} terminalId={terminalId} onClose={() => setCreating(false)} />
      ) : null}
      {open ? <DocumentDialog doc={open} onClose={() => setOpen(null)} /> : null}
    </div>
  )
}
