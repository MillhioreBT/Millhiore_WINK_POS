import type { Shift } from "@millhiore/contracts"
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { PrinterIcon } from "lucide-react"
import { useState } from "react"
import { formatDateTime, formatMoney } from "../../lib/format"
import { bootstrapQuery, shiftReportQuery, shiftsQuery } from "../../lib/queries"
import { ShiftReportView } from "./ShiftReportView"

function ReportDialog({ shiftId, onClose }: { shiftId: string; onClose: () => void }) {
  const boot = useQuery(bootstrapQuery)
  const report = useQuery(shiftReportQuery(shiftId))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Cierre de caja</DialogTitle>
        <DialogDescription className="sr-only">Resumen del turno</DialogDescription>
        {report.data ? (
          <div className="rounded-lg border bg-white p-4 text-black">
            <ShiftReportView report={report.data} business={boot.data?.business} />
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Cargando…</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => window.print()} disabled={!report.data}>
            <PrinterIcon /> Imprimir
          </Button>
          <Button onClick={onClose}>Cerrar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Diferencias del arqueo de un turno, en texto corto: "−1,00 $ · +20,00 Bs". */
function differences(shift: Shift): { text: string; tone: "success" | "warning" | "destructive" } {
  if (shift.status === "open") return { text: "—", tone: "success" }
  const diffs = shift.accounts.filter((a) => (a.differenceMinor ?? 0) !== 0)
  if (!diffs.length) return { text: "Cuadró", tone: "success" }
  const text = diffs
    .map(
      (a) =>
        `${(a.differenceMinor ?? 0) > 0 ? "+" : "−"}${formatMoney(Math.abs(a.differenceMinor ?? 0), a.currency)}`,
    )
    .join(" · ")
  return { text, tone: diffs.some((a) => (a.differenceMinor ?? 0) < 0) ? "destructive" : "warning" }
}

export function ShiftsList() {
  const shifts = useQuery(shiftsQuery)
  const [open, setOpen] = useState<string | null>(null)
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Caja</TableHead>
              <TableHead>Apertura</TableHead>
              <TableHead>Cierre</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Arqueo</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(shifts.data ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  {shifts.isLoading ? "Cargando…" : "Aún no hay turnos."}
                </TableCell>
              </TableRow>
            ) : null}
            {(shifts.data ?? []).map((s) => {
              const diff = differences(s)
              return (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.terminalName}</TableCell>
                  <TableCell>
                    {formatDateTime(s.openedAt)}
                    <div className="text-muted-foreground text-xs">{s.openedBy ?? "—"}</div>
                  </TableCell>
                  <TableCell>
                    {s.closedAt ? formatDateTime(s.closedAt) : "—"}
                    <div className="text-muted-foreground text-xs">{s.closedBy ?? ""}</div>
                  </TableCell>
                  <TableCell>
                    {s.status === "open" ? (
                      <Badge variant="success">Abierto</Badge>
                    ) : (
                      <Badge variant="outline">Cerrado</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={diff.tone} className="tabular">
                      {diff.text}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" onClick={() => setOpen(s.id)}>
                      {s.status === "open" ? "Corte parcial" : "Ver cierre"}
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
      {open ? <ReportDialog shiftId={open} onClose={() => setOpen(null)} /> : null}
    </Card>
  )
}
