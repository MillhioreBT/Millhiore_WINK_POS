import type { RecurringExpense } from "@millhiore/contracts"
import { Badge, Button, Card, CardContent } from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { PauseIcon, PencilIcon, PlayIcon, PlusIcon, ReceiptTextIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { formatMoney } from "../../lib/format"
import { queryClient, recurringQuery } from "../../lib/queries"
import { FREQUENCY_LABEL, formatDueDay } from "../../lib/recurrence"
import { can, useMe } from "../../lib/session"
import { ExpenseDialog } from "./ExpenseDialog"
import { RecurringDialog } from "./RecurringDialog"

/** Los gastos que se repiten: los que ya vencieron primero, para registrarlos o dejar que se registren solos. */
export function RecurringTab({ onPosted }: { onPosted: (documentId: string) => void }) {
  const me = useMe()
  const recurring = useQuery(recurringQuery)
  const [editing, setEditing] = useState<RecurringExpense | "new" | null>(null)
  const [registering, setRegistering] = useState<RecurringExpense | null>(null)
  const canManage = can(me, "expense.create")
  const rows = recurring.data ?? []

  const toggle = async (r: RecurringExpense) => {
    try {
      await api(`/api/recurring-expenses/${r.id}`, { method: "PATCH", body: { active: !r.active } })
      await queryClient.invalidateQueries({ queryKey: ["recurring"] })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-muted-foreground text-sm">
          Alquiler, internet, sueldos… Cuando vencen te avisamos aquí, o se registran solos a deber
          si así lo configuras.
        </p>
        {canManage ? (
          <Button onClick={() => setEditing("new")}>
            <PlusIcon /> Nuevo recurrente
          </Button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            {recurring.isLoading ? "Cargando…" : "Todavía no hay gastos recurrentes."}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {rows.map((r) => (
          <Card key={r.id} className={r.active ? "" : "opacity-60"}>
            <CardContent className="grid grid-cols-1 gap-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{r.note}</p>
                  <p className="text-muted-foreground text-xs">
                    {r.categoryName}
                    {r.contact ? ` · ${r.contact.name}` : ""}
                  </p>
                </div>
                <span className="tabular shrink-0 font-semibold text-lg">
                  {formatMoney(r.amountMinor, r.currency)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">
                  {FREQUENCY_LABEL[r.frequency]} · próximo {formatDueDay(r.nextDueDay)}
                </span>
                {!r.active ? (
                  <Badge variant="outline">Pausado</Badge>
                ) : r.due ? (
                  <Badge variant="warning">
                    {r.auto ? "Venció: se registra solo" : "Por registrar"}
                  </Badge>
                ) : null}
                {r.auto && r.active && !r.due ? (
                  <Badge variant="secondary">Automático</Badge>
                ) : null}
              </div>
              {r.lastError ? (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-sm">
                  No se pudo registrar solo: {r.lastError}
                </p>
              ) : null}
              {canManage ? (
                <div className="flex flex-wrap justify-end gap-2">
                  {r.active && r.due ? (
                    <Button size="sm" onClick={() => setRegistering(r)}>
                      <ReceiptTextIcon /> Registrar ahora
                    </Button>
                  ) : null}
                  <Button variant="outline" size="sm" onClick={() => setEditing(r)}>
                    <PencilIcon /> Cambiar
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => toggle(r)}>
                    {r.active ? <PauseIcon /> : <PlayIcon />} {r.active ? "Pausar" : "Reanudar"}
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>

      {editing ? (
        <RecurringDialog
          editing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {registering ? (
        <ExpenseDialog
          prefill={{
            recurringId: registering.id,
            note: registering.note,
            categoryId: registering.categoryId,
            contact: registering.contact,
            currency: registering.currency,
            amountMinor: registering.amountMinor,
          }}
          onClose={() => setRegistering(null)}
          onPosted={(id) => {
            setRegistering(null)
            void queryClient.invalidateQueries({ queryKey: ["recurring"] })
            onPosted(id)
          }}
        />
      ) : null}
    </div>
  )
}
