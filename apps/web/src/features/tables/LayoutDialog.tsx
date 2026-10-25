import type { DiningFloor } from "@millhiore/contracts"
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
  Input,
} from "@millhiore/ui"
import { useQuery } from "@tanstack/react-query"
import { PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api, errorMessage } from "../../lib/api"
import { diningQuery, queryClient } from "../../lib/queries"

interface TableRow {
  key: string
  id?: string
  name: string
  busy: boolean
}

interface AreaRow {
  key: string
  id?: string
  name: string
  tables: TableRow[]
}

let seq = 0
const key = () => `k${++seq}`

/** El número que sigue: uno más que la mesa con el número más alto. */
export function nextTableName(areas: readonly { tables: readonly { name: string }[] }[]): string {
  const numbers = areas.flatMap((a) => a.tables.map((t) => Number(t.name.trim())))
  const max = Math.max(0, ...numbers.filter((n) => Number.isInteger(n)))
  return String(max + 1)
}

function fromFloor(floor: DiningFloor): AreaRow[] {
  if (floor.areas.length === 0) {
    // Para arrancar: un salón con ocho mesas, que después se renombran o se quitan.
    return [
      {
        key: key(),
        name: "Salón",
        tables: Array.from({ length: 8 }, (_, i) => ({
          key: key(),
          name: String(i + 1),
          busy: false,
        })),
      },
    ]
  }
  return floor.areas.map((a) => ({
    key: key(),
    id: a.id,
    name: a.name,
    tables: a.tables.map((t) => ({ key: key(), id: t.id, name: t.name, busy: t.tab !== null })),
  }))
}

/** Las salas y sus mesas: agregar, renombrar y quitar (las ocupadas no se pueden quitar). */
export function LayoutDialog({ floor, onClose }: { floor: DiningFloor; onClose: () => void }) {
  const [areas, setAreas] = useState<AreaRow[]>(() => fromFloor(floor))
  const [busy, setBusy] = useState(false)

  const update = (areaKey: string, fn: (a: AreaRow) => AreaRow) =>
    setAreas((all) => all.map((a) => (a.key === areaKey ? fn(a) : a)))
  const addTables = (areaKey: string, n: number) =>
    setAreas((all) => {
      const next = all.map((a) => ({ ...a, tables: [...a.tables] }))
      const area = next.find((a) => a.key === areaKey)
      for (let i = 0; i < n && area; i++) {
        area.tables.push({ key: key(), name: nextTableName(next), busy: false })
      }
      return next
    })

  const save = async () => {
    setBusy(true)
    try {
      await api("/api/dining/layout", {
        method: "PUT",
        body: {
          areas: areas.map((a) => ({
            ...(a.id ? { id: a.id } : {}),
            name: a.name,
            tables: a.tables.map((t) => ({ ...(t.id ? { id: t.id } : {}), name: t.name })),
          })),
        },
      })
      await queryClient.invalidateQueries({ queryKey: ["dining"] })
      toast.success("Mesas guardadas")
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Salas y mesas</DialogTitle>
          <DialogDescription>
            Cada sala (salón, terraza, barra) con sus mesas, en el orden en que se ven. Una mesa
            ocupada no se puede quitar.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4">
          {areas.map((a, i) => {
            const occupied = a.tables.some((t) => t.busy)
            return (
              <fieldset
                key={a.key}
                className="grid min-w-0 grid-cols-1 gap-2 rounded-lg border p-3"
              >
                <legend className="sr-only">{a.name || `Sala ${i + 1}`}</legend>
                <div className="flex items-center gap-2">
                  <Input
                    value={a.name}
                    maxLength={40}
                    aria-label={`Nombre de la sala ${i + 1}`}
                    placeholder="Salón, terraza…"
                    onChange={(e) => update(a.key, (x) => ({ ...x, name: e.target.value }))}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Quitar la sala ${a.name}`}
                    title={occupied ? "Tiene mesas ocupadas" : "Quitar la sala"}
                    disabled={occupied}
                    onClick={() => setAreas((all) => all.filter((x) => x.key !== a.key))}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {a.tables.map((t, j) => (
                    <span
                      key={t.key}
                      className="flex items-center rounded-md border bg-card pr-0.5 focus-within:ring-2 focus-within:ring-ring"
                    >
                      <input
                        value={t.name}
                        maxLength={20}
                        size={Math.max(2, t.name.length)}
                        aria-label={`Mesa ${j + 1} de ${a.name}`}
                        className="h-8 min-w-0 bg-transparent px-2 text-sm outline-none"
                        onChange={(e) =>
                          update(a.key, (x) => ({
                            ...x,
                            tables: x.tables.map((y) =>
                              y.key === t.key ? { ...y, name: e.target.value } : y,
                            ),
                          }))
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-6 text-muted-foreground"
                        aria-label={`Quitar la mesa ${t.name}`}
                        title={t.busy ? "Tiene la cuenta abierta" : "Quitar"}
                        disabled={t.busy}
                        onClick={() =>
                          update(a.key, (x) => ({
                            ...x,
                            tables: x.tables.filter((y) => y.key !== t.key),
                          }))
                        }
                      >
                        <XIcon />
                      </Button>
                    </span>
                  ))}
                  <Button variant="outline" size="sm" onClick={() => addTables(a.key, 1)}>
                    <PlusIcon /> Mesa
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => addTables(a.key, 5)}>
                    + 5
                  </Button>
                </div>
              </fieldset>
            )
          })}
          <Button
            variant="outline"
            className="justify-self-start"
            onClick={() =>
              setAreas((all) => [
                ...all,
                {
                  key: key(),
                  name: all.length ? "" : "Salón",
                  tables: [{ key: key(), name: nextTableName(all), busy: false }],
                },
              ])
            }
          >
            <PlusIcon /> Sala
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** En Ajustes: cuántas salas y mesas hay, y el botón para cambiarlas. */
export function DiningCard() {
  const floor = useQuery(diningQuery)
  const [editing, setEditing] = useState(false)
  const areas = floor.data?.areas ?? []
  const tables = areas.reduce((acc, a) => acc + a.tables.length, 0)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Salas y mesas</CardTitle>
        <CardDescription>
          {tables
            ? `${areas.length === 1 ? "1 sala" : `${areas.length} salas`} con ${tables === 1 ? "1 mesa" : `${tables} mesas`}: ${areas.map((a) => a.name).join(", ")}.`
            : "Aún no hay mesas: arma el salón, la terraza o la barra."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" disabled={!floor.data} onClick={() => setEditing(true)}>
          <PencilIcon /> Editar salas y mesas
        </Button>
        {editing && floor.data ? (
          <LayoutDialog floor={floor.data} onClose={() => setEditing(false)} />
        ) : null}
      </CardContent>
    </Card>
  )
}
