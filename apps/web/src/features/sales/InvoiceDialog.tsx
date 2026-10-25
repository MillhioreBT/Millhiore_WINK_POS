import type { DocumentDetail, DocumentSummary } from "@millhiore/contracts"
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
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { queryClient } from "../../lib/queries"

/**
 * Anota los números de la factura que emitió el medio autorizado (máquina fiscal, talonario de
 * forma libre o, más adelante, el medio digital del SENIAT). Este sistema no la emite.
 */
export function InvoiceDialog({ doc, onClose }: { doc: DocumentSummary; onClose: () => void }) {
  const [invoiceNumber, setInvoiceNumber] = useState(doc.invoice?.invoiceNumber ?? "")
  const [controlNumber, setControlNumber] = useState(doc.invoice?.controlNumber ?? "")
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const saved = await api<DocumentDetail>(`/api/documents/${doc.id}/invoice`, {
        method: "PUT",
        body: { invoiceNumber, controlNumber },
      })
      queryClient.setQueryData(["document", doc.id], saved)
      await queryClient.invalidateQueries({ queryKey: ["documents"] })
      toast.success(`Factura ${saved.invoice?.invoiceNumber} anotada en la venta ${doc.number}`)
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Factura de la venta {doc.number}</DialogTitle>
          <DialogDescription>
            Los números de la factura emitida con la máquina fiscal o el talonario de forma libre
            {doc.contactName ? ` a ${doc.contactName}` : ""}
            {doc.contactTaxId ? ` (${doc.contactTaxId})` : ""}.
          </DialogDescription>
        </DialogHeader>
        <form id="invoice-form" onSubmit={submit} className="grid grid-cols-1 gap-4">
          <Field label="N.º de factura" htmlFor="inv-number">
            <Input
              id="inv-number"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="000123"
              autoComplete="off"
              maxLength={30}
              required
              autoFocus
            />
          </Field>
          <Field label="N.º de control" htmlFor="inv-control" hint="El que trae impreso la factura">
            <Input
              id="inv-control"
              value={controlNumber}
              onChange={(e) => setControlNumber(e.target.value)}
              placeholder="00-000123"
              autoComplete="off"
              maxLength={30}
              required
            />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="invoice-form"
            disabled={busy || !invoiceNumber.trim() || !controlNumber.trim()}
          >
            {busy ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
