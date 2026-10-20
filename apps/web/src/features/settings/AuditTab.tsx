import {
  Badge,
  Card,
  CardContent,
  Field,
  Input,
  NativeSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { errorMessage } from "../../lib/api"
import { ACTION_GROUPS, actionLabel, entryDetail } from "../../lib/auditLabels"
import { dayRange, daysBefore, todayInCaracas } from "../../lib/days"
import { formatDateTime } from "../../lib/format"
import { auditQuery } from "../../lib/queries"

const LIMIT = 500

/** Quién hizo qué y cuándo. Solo se lee: ni el dueño puede editar ni borrar la bitácora. */
export function AuditTab() {
  const today = todayInCaracas()
  const [from, setFrom] = useState(() => daysBefore(today, 6))
  const [to, setTo] = useState(today)
  const [group, setGroup] = useState("")
  const [search, setSearch] = useState("")
  const range = { from: dayRange(from).from, to: dayRange(to).to }
  const log = useQuery({ ...auditQuery({ ...range, action: group }), enabled: from <= to })

  const needle = search.trim().toLowerCase()
  const rows = (log.data ?? []).filter((e) => {
    if (!needle) return true
    const text = [e.actorName, actionLabel(e.action), e.action, entryDetail(e)]
    return text.some((t) => t?.toLowerCase().includes(needle))
  })

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[auto_auto_1fr_1fr]">
        <Field label="Desde" htmlFor="audit-from">
          <Input
            id="audit-from"
            type="date"
            value={from}
            max={to}
            onChange={(e) => e.target.value && setFrom(e.target.value)}
          />
        </Field>
        <Field label="Hasta" htmlFor="audit-to">
          <Input
            id="audit-to"
            type="date"
            value={to}
            min={from}
            max={today}
            onChange={(e) => e.target.value && setTo(e.target.value)}
          />
        </Field>
        <Field label="Qué" htmlFor="audit-group">
          <NativeSelect id="audit-group" value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">Todo</option>
            {ACTION_GROUPS.map((g) => (
              <option key={g.prefix} value={g.prefix}>
                {g.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Buscar" htmlFor="audit-search">
          <Input
            id="audit-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Persona, acción o número"
          />
        </Field>
      </div>

      {log.isError ? <p className="text-destructive text-sm">{errorMessage(log.error)}</p> : null}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cuándo</TableHead>
                <TableHead>Quién</TableHead>
                <TableHead>Qué hizo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                    {log.isLoading ? "Cargando…" : "No hay movimientos con ese filtro."}
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((e) => {
                const detail = entryDetail(e)
                return (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap align-top text-sm">
                      {formatDateTime(e.at)}
                    </TableCell>
                    <TableCell className="align-top text-sm">
                      {e.actorName ?? <span className="text-muted-foreground">Sistema</span>}
                    </TableCell>
                    <TableCell className="align-top text-sm">
                      <span className="font-medium">{actionLabel(e.action)}</span>
                      {detail ? (
                        <span className="block text-muted-foreground">{detail}</span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {(log.data?.length ?? 0) >= LIMIT ? (
        <Badge variant="warning" className="justify-self-start">
          Se muestran las {LIMIT} más recientes: acota las fechas para ver más.
        </Badge>
      ) : null}
    </div>
  )
}
